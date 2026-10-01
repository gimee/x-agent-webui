<script lang="ts">
import 'katex/dist/katex.min.css'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import type MarkdownIt from 'markdown-it'
import MarkdownItConstructor from 'markdown-it'
import katex from 'katex'
import markdownItKatex from '@vscode/markdown-it-katex'
import { handleCodeBlockCopyClick, renderHighlightedCodeBlock } from './highlight'
// hermes-v050:C5 本组件是异步 chunk，在这里安装 core + 常用语言高亮器
import './highlight-hljs'
import { repairNestedMarkdownFences } from './markdownFenceRepair'
import {
  MERMAID_MAX_DIAGRAMS_PER_MESSAGE,
  MERMAID_MAX_SOURCE_LENGTH,
  MERMAID_RENDER_TIMEOUT_MS,
  decodeMermaidSource,
  encodeMermaidSource,
  isMermaidFence,
  renderMermaidPlaceholder,
} from './mermaidRenderer'
import { downloadFile, getDownloadUrl, inferDownloadFileName } from '@/api/studio/download'
import { isPreviewableFile } from '@/utils/hermes/file-preview'
import { openUrlInDesktopBrowser } from '@/utils/desktop-browser'
import ImagePreviewOverlay from './ImagePreviewOverlay.vue'

const LATEX_FENCE_LANGS = new Set(['latex', 'tex', 'math', 'katex'])
function getFenceLanguage(info: string): string {
  return info.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
}

function isLatexFence(info: string): boolean {
  return LATEX_FENCE_LANGS.has(getFenceLanguage(info))
}

function normalizeLatexFenceContent(content: string): string {
  const trimmed = content.trim()

  if (trimmed.startsWith('\\[') && trimmed.endsWith('\\]')) {
    return trimmed.slice(2, -2).trim()
  }

  if (trimmed.startsWith('$$') && trimmed.endsWith('$$')) {
    return trimmed.slice(2, -2).trim()
  }

  if (trimmed.startsWith('\\(') && trimmed.endsWith('\\)')) {
    return trimmed.slice(2, -2).trim()
  }

  return trimmed
}

function renderLatexFence(content: string): string {
  const latex = normalizeLatexFenceContent(content)
  return `<div class="latex-block">${katex.renderToString(latex, {
    displayMode: true,
    output: 'htmlAndMathml',
    throwOnError: false,
    strict: 'ignore',
  })}</div>`
}

// hermes-v050:C11 MarkdownIt 与 katex 插件改为模块级单例（原来每个实例都 new 一次并装插件）。
// 复制按钮、diff 折叠等文案不再闭包捕获某个实例的 t()，而是每次渲染经 md.render(src, env) 传入，
// 由围栏规则在调用高亮前取用，切换语言后下一次渲染即生效。
export type MarkdownRenderEnv = {
  copyLabel: string
  formatDiffFoldLabel: (hiddenCount: number) => string
  // hermes-v050:F-12 本次渲染里已遇到的 mermaid 围栏数（围栏规则内部计数，调用方不用传）
  mermaidDiagrams?: number
}

let activeFenceEnv: MarkdownRenderEnv | null = null

const md: MarkdownIt = new MarkdownItConstructor({
  html: false,
  breaks: true,
  linkify: true,
  typographer: true,
  highlight(str: string, lang: string): string {
    const env = activeFenceEnv
    return renderHighlightedCodeBlock(str, lang, env?.copyLabel ?? '', {
      formatDiffFoldLabel: env?.formatDiffFoldLabel,
    })
  },
})

// Preserve literal quote characters from user and assistant messages while
// retaining typographer's other replacements (for example, dashes and ellipses).
md.disable('smartquotes')

md.use(markdownItKatex, {
  katex,
  throwOnError: false,
  strict: 'ignore',
})

// A conversation carries whatever language the person writes in, and one
// message can hold both. dir="auto" lets each block pick its own direction from
// its first strong character, so an Arabic paragraph reads right-to-left even
// while the interface is in English — and the reverse.
const AUTO_DIRECTION_TOKENS = new Set([
  'paragraph_open',
  'heading_open',
  'blockquote_open',
  'list_item_open',
  'th_open',
  'td_open',
  'dt_open',
  'dd_open',
])

md.core.ruler.push('auto_direction', (state) => {
  for (const token of state.tokens) {
    if (AUTO_DIRECTION_TOKENS.has(token.type)) token.attrSet('dir', 'auto')
  }
})

const defaultFenceRenderer = md.renderer.rules.fence?.bind(md.renderer.rules)

md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  if (isLatexFence(token.info)) {
    return renderLatexFence(token.content)
  }

  if (isMermaidFence(token.info)) {
    // hermes-v050:F-12 每条消息最多 4 张图：按文档顺序计数，超出的直接输出代码块。原来靠渲染时对「仍在
    // 等待」的占位 slice(0,4)，而按块修补（C3）会保留已渲染的图，流式期间第 5、6 张也被渲染了。
    const renderEnv = env as MarkdownRenderEnv
    const copyLabel = renderEnv.copyLabel ?? ''
    renderEnv.mermaidDiagrams = (renderEnv.mermaidDiagrams ?? 0) + 1
    if (renderEnv.mermaidDiagrams > MERMAID_MAX_DIAGRAMS_PER_MESSAGE) {
      return renderHighlightedCodeBlock(token.content, 'mermaid', copyLabel)
    }
    return renderMermaidPlaceholder(token.content, copyLabel)
  }

  if (defaultFenceRenderer) {
    const previousEnv = activeFenceEnv
    activeFenceEnv = env as MarkdownRenderEnv
    try {
      return defaultFenceRenderer(tokens, idx, options, env, self)
    } finally {
      activeFenceEnv = previousEnv
    }
  }

  return self.renderToken(tokens, idx, options)
}

// hermes-v050:F-13 mermaid 的 import / render 超时单独成类，退回代码块时据此标记为可重试
class MermaidTimeoutError extends Error {}

export function renderMarkdownSource(source: string, env: MarkdownRenderEnv): string {
  return md.render(source, env)
}

// hermes-v050:C3 按顶层块渲染：块在 level 0 的闭合（或自闭合）token 处切开，各段 render 结果顺序拼接
// 与整篇 md.render 逐字相同（renderToken 只在开标签处向后看，切点都是闭合 token）。
export function renderMarkdownBlocks(source: string, env: MarkdownRenderEnv): string[] {
  const tokens = md.parse(source, env)
  const blocks: string[] = []
  let start = 0
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.level !== 0 || token.nesting === 1) continue
    blocks.push(md.renderer.render(tokens.slice(start, index + 1), md.options, env))
    start = index + 1
  }
  if (start < tokens.length) blocks.push(md.renderer.render(tokens.slice(start), md.options, env))
  return blocks
}
</script>

<script setup lang="ts">
const props = withDefaults(defineProps<{
    content: string
    mentionNames?: string[]
    headingIdPrefix?: string
    resolveImageUrl?: (path: string) => string
    deferImages?: boolean
}>(), {
    mentionNames: () => [],
    headingIdPrefix: '',
})

const { t } = useI18n()
const message = useMessage()

function diffFoldLabel(hiddenCount: number): string {
  return t('chat.unchangedLines', { count: hiddenCount })
}


const markdownBody = ref<HTMLElement | null>(null)
const componentId = `hermes-mermaid-${Math.random().toString(36).slice(2)}`
const previewUrl = ref<string | null>(null)

let renderGeneration = 0
let unmounted = false

function isLocalFilePath(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path)
}

function normalizeLocalFilePath(path: string): string {
  return /^[a-zA-Z]:\\/.test(path) ? path.replace(/\\/g, '/') : path
}

function localFilePathWithoutLocation(path: string): string {
  const normalizedPath = normalizeLocalFilePath(path)
  const locationMatch = normalizedPath.match(/^(.*?):(\d+)(?::\d+)?$/)
  if (!locationMatch || !isLocalFilePath(locationMatch[1])) return normalizedPath
  return locationMatch[1]
}

function requestWorkspaceFilePreview(path: string, fileName: string, previewOnly = false): boolean {
  const event = new CustomEvent('hermes:preview-workspace-file', {
    cancelable: true,
    detail: { path, fileName, ...(previewOnly ? { previewOnly: true } : {}) },
  })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

function downloadPathFromUrl(url: string): string | null {
  try {
    return new URL(url, window.location.origin).searchParams.get('path')
  } catch {
    return null
  }
}

const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov'])
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'])

function hasExtension(path: string, extensions: Set<string>): boolean {
  const clean = path.split('?')[0].split('#')[0]
  const ext = clean.split('.').pop()?.toLowerCase()
  return !!ext && extensions.has(ext)
}

// hermes-v050:C3 每个顶层块单独做下面这些字符串后处理（都是块内局部替换；标题编号跨块累加）
function decorateRenderedHtml(blockHtml: string, headingStart: number): { html: string; headings: number } {
  let html = blockHtml
  if (props.deferImages) html = html.replace(/<img\b[^>]*>/gi, '')

  // Add IDs to headings for anchor links
  const prefix = props.headingIdPrefix ? `${props.headingIdPrefix}-` : ''
  let headingCounter = headingStart
  // Match any h1-h6 tags, with or without attributes
  html = html.replace(/<(h[1-6])([^>]*)>/g, (match, tag, attrs) => {
    headingCounter++
    const id = `${prefix}heading-${headingCounter}`
    
    // Check if id attribute already exists
    if (attrs.includes('id=')) {
      // Replace existing id
      return match.replace(/id="[^"]*"/, `id="${id}"`).replace(/id='[^']*'/, `id="${id}"`)
    }
    
    // Add new id
    if (attrs.trim() === '') {
      return `<${tag} id="${id}">`
    }
    return `<${tag} ${attrs.trim()} id="${id}">`
  })

  // Replace image src paths with download URLs
  html = html.replace(/\bsrc=(["'])([^"']+)\1/g, (match, quote, path) => {
    if (!isLocalFilePath(path)) return match
    if (props.resolveImageUrl && !path.startsWith('//')) {
      let decodedPath = md.utils.unescapeAll(path)
      try { decodedPath = decodeURIComponent(decodedPath) } catch { /* Keep literal paths. */ }
      return `src="${md.utils.escapeHtml(props.resolveImageUrl(normalizeLocalFilePath(decodedPath)))}"`
    }
    const downloadUrl = getDownloadUrl(normalizeLocalFilePath(path))
    return `src=${quote}${downloadUrl}${quote}`
  })

  // Replace local file links with file card UI or video player
  // Match <a href="/tmp/file.pdf">filename</a> or <a href="C:/tmp/file.pdf">filename</a>
  html = html.replace(/<a href="([^"]+)">([^<]+)<\/a>/g, (match, rawPath, filename) => {
    if (!isLocalFilePath(rawPath)) return match

    const path = localFilePathWithoutLocation(downloadPathFromUrl(rawPath) || rawPath)
    const fileName = filename.trim()
    const downloadName = inferDownloadFileName(path, fileName)

    // Video files: render as video player
    if (hasExtension(path, VIDEO_EXTENSIONS)) {
      const downloadUrl = getDownloadUrl(path)
      return `<div class="markdown-video-container">
        <video class="markdown-video" controls preload="metadata" src="${downloadUrl}"></video>
        <div class="markdown-video-footer">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
          <span class="att-name">${fileName}</span>
        </div>
      </div>`
    }

    // Audio files: render as inline audio player
    if (hasExtension(path, AUDIO_EXTENSIONS)) {
      const downloadUrl = getDownloadUrl(path)
      return `<div class="markdown-audio-container">
        <audio class="markdown-audio" controls preload="metadata" src="${downloadUrl}"></audio>
        <div class="markdown-audio-footer">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M9 18V5l12-2v13" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="16" r="3" />
          </svg>
          <span class="att-name">${fileName}</span>
        </div>
      </div>`
    }

    // Other files: render as file card
    return `<div class="markdown-file-card" data-path="${path}" data-filename="${downloadName}" title="${t('download.downloadFile')}">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
      <span class="att-name">${fileName}</span>
      <button class="att-download-btn" type="button" title="${t('download.downloadFile')}" aria-label="${t('download.downloadFile')}">
        <svg class="att-download-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      </button>
    </div>`
  })

  if (props.mentionNames && props.mentionNames.length > 0) {
    const escaped = [...props.mentionNames]
      .sort((a, b) => b.length - a.length)
      .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const re = new RegExp(`(?<=[\\s>({\\[<]|^)@(${escaped.join('|')})(?=[\\s.,!?;:，。！？；：)\\]}>]|<|$)`, 'gi')
    html = html.replace(re, '<span class="mention-highlight">@$1</span>')
  }
  return { html, headings: headingCounter - headingStart }
}

const renderedBlocks = computed(() => {
  const blocks = renderMarkdownBlocks(repairNestedMarkdownFences(props.content), {
    copyLabel: t('common.copy'),
    formatDiffFoldLabel: diffFoldLabel,
  })
  let headings = 0
  return blocks.map((block) => {
    const decorated = decorateRenderedHtml(block, headings)
    headings += decorated.headings
    return decorated.html
  })
})

const renderedHtml = computed(() => renderedBlocks.value.join(''))

// hermes-v050:C3 流式时按顶层块修补 DOM：只替换变化的块（通常只有尾部那一块），前面已完成的块
// （高亮好的代码块、已渲染的 mermaid、展开的 diff）原样保留，不再每个 delta 整段 innerHTML 替换后
// 全量重算样式和布局。块外被改过顶层节点时整段重建。最终 DOM 与一次性 v-html 相同。
let patchedBlocks: Array<{ html: string; nodeCount: number }> = []

function patchMarkdownBody(blocks: string[]): void {
  const root = markdownBody.value
  if (!root) return
  const patchedNodeCount = patchedBlocks.reduce((sum, block) => sum + block.nodeCount, 0)
  if (root.childNodes.length !== patchedNodeCount) {
    patchedBlocks = []
    root.textContent = ''
  }
  let kept = 0
  let keptNodes = 0
  while (kept < blocks.length && kept < patchedBlocks.length && patchedBlocks[kept].html === blocks[kept]) {
    keptNodes += patchedBlocks[kept].nodeCount
    kept += 1
  }
  while (root.childNodes.length > keptNodes) root.lastChild?.remove()
  const next = patchedBlocks.slice(0, kept)
  const parser = document.createElement('div')
  const fragment = document.createDocumentFragment()
  for (let index = kept; index < blocks.length; index += 1) {
    parser.innerHTML = blocks[index]
    next.push({ html: blocks[index], nodeCount: parser.childNodes.length })
    while (parser.firstChild) fragment.appendChild(parser.firstChild)
  }
  root.appendChild(fragment)
  patchedBlocks = next
}

watch(renderedBlocks, patchMarkdownBody, { flush: 'post' })

// hermes-v050:F-13 超时退回的代码块带这个属性，可以重试：下一次渲染（流继续、内容变化）先把它换回占位
// 再渲染；超时的 import / render 事后成功时也自动重试一次（流已结束、历史消息）。按块修补（C3）会保留
// html 没变的块，不做这一步的话，一次临时超时就永久停在代码块上。语法错误等真实失败仍是永久代码块。
const MERMAID_RETRY_ATTR = 'data-mermaid-retry-source'
const MERMAID_COPY_LABEL_ATTR = 'data-mermaid-copy-label'

function replaceWithHtml(element: HTMLElement, html: string): Element | null {
  const template = document.createElement('template')
  template.innerHTML = html
  const first = template.content.firstElementChild
  element.replaceWith(template.content)
  return first
}

function renderMermaidFallback(element: HTMLElement, source: string, retryable = false): void {
  // hermes-v050:F-14 复制文案用占位里记下的那份（与块 html 同一语言）；切换语言后块被重建，文案跟着换
  const copyLabel = element.getAttribute(MERMAID_COPY_LABEL_ATTR) ?? t('common.copy')
  const fallback = replaceWithHtml(element, renderHighlightedCodeBlock(source, 'mermaid', copyLabel))
  if (retryable && fallback) {
    fallback.setAttribute(MERMAID_RETRY_ATTR, encodeMermaidSource(source))
    fallback.setAttribute(MERMAID_COPY_LABEL_ATTR, copyLabel)
  }
}

function restoreRetryableMermaidDiagrams(root: HTMLElement): void {
  for (const fallback of Array.from(root.querySelectorAll<HTMLElement>(`[${MERMAID_RETRY_ATTR}]`))) {
    const source = decodeMermaidSource(fallback.getAttribute(MERMAID_RETRY_ATTR))
    replaceWithHtml(fallback, renderMermaidPlaceholder(source, fallback.getAttribute(MERMAID_COPY_LABEL_ATTR) ?? undefined))
  }
}

// 事后成功只自动重试一次（每个源各一次），避免「每次都比 5s 慢一点」的图无限重渲染
const lateRetriedMermaidSources = new Set<string>()

function retryMermaidWhenSettled(promise: Promise<unknown>, sources: string[], onSettled?: () => void): void {
  const fresh = sources.filter(source => !lateRetriedMermaidSources.has(source))
  if (fresh.length === 0) return
  for (const source of fresh) lateRetriedMermaidSources.add(source)
  promise.then(() => {
    onSettled?.()
    if (unmounted || !markdownBody.value?.querySelector(`[${MERMAID_RETRY_ATTR}]`)) return
    void renderMermaidDiagrams()
  }, () => {
    onSettled?.()
  })
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new MermaidTimeoutError(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId)
    }
  })
}

function getScrollParent(el: HTMLElement | null): HTMLElement | null {
  if (!el) return null
  let current: HTMLElement | null = el.parentElement
  while (current) {
    const { overflow, overflowY } = getComputedStyle(current)
    if (overflow === 'auto' || overflow === 'scroll' || overflowY === 'auto' || overflowY === 'scroll') {
      return current
    }
    current = current.parentElement
  }
  return null
}

function isNearScrollBottom(el: HTMLElement, threshold = 200): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold
}

function cleanupMermaidRenderArtifacts(id: string): void {
  document.getElementById(id)?.remove()
  document.getElementById(`d${id}`)?.remove()
}

async function renderMermaidDiagrams(): Promise<void> {
  const generation = ++renderGeneration
  await nextTick()

  const root = markdownBody.value
  if (unmounted || generation !== renderGeneration || !root) return

  restoreRetryableMermaidDiagrams(root)
  const pendingDiagrams = Array.from(root.querySelectorAll<HTMLElement>('[data-mermaid-pending="true"]'))
  if (pendingDiagrams.length === 0) return

  const diagramsToRender = pendingDiagrams.slice(0, MERMAID_MAX_DIAGRAMS_PER_MESSAGE)
  const diagramsToFallback = pendingDiagrams.slice(MERMAID_MAX_DIAGRAMS_PER_MESSAGE)

  for (const element of diagramsToFallback) {
    renderMermaidFallback(element, decodeMermaidSource(element.getAttribute('data-mermaid-source')))
  }

  const renderCandidates = diagramsToRender
    .map(element => ({
      element,
      source: decodeMermaidSource(element.getAttribute('data-mermaid-source')),
    }))

  const validDiagrams = [] as typeof renderCandidates
  for (const candidate of renderCandidates) {
    if (unmounted || generation !== renderGeneration || !root.contains(candidate.element)) return

    if (!candidate.source || candidate.source.length > MERMAID_MAX_SOURCE_LENGTH) {
      renderMermaidFallback(candidate.element, candidate.source)
      continue
    }

    validDiagrams.push(candidate)
  }

  if (validDiagrams.length === 0) return

  let mermaid: typeof import('mermaid').default
  const mermaidImport = import('mermaid')

  try {
    mermaid = (await withTimeout(mermaidImport, MERMAID_RENDER_TIMEOUT_MS, 'Mermaid import')).default
    if (unmounted || generation !== renderGeneration) return

    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
    })
  } catch (error) {
    if (unmounted || generation !== renderGeneration) return
    const timedOut = error instanceof MermaidTimeoutError
    for (const { element, source } of validDiagrams) {
      if (root.contains(element)) {
        renderMermaidFallback(element, source, timedOut)
      }
    }
    if (timedOut) retryMermaidWhenSettled(mermaidImport, validDiagrams.map(diagram => diagram.source))
    return
  }

  for (const [index, { element, source }] of validDiagrams.entries()) {
    if (unmounted || generation !== renderGeneration || !root.contains(element)) return

    const id = `${componentId}-${generation}-${index}`
    let renderPromise: Promise<{ svg: string }> | null = null
    try {
      renderPromise = mermaid.render(id, source)
      const result = await withTimeout(renderPromise, MERMAID_RENDER_TIMEOUT_MS, 'Mermaid render')
      cleanupMermaidRenderArtifacts(id)
      if (unmounted || generation !== renderGeneration || !root.contains(element)) return

      const scrollParent = getScrollParent(markdownBody.value)
      const shouldKeepBottom = scrollParent ? isNearScrollBottom(scrollParent) : false
      element.removeAttribute('data-mermaid-pending')
      element.removeAttribute('data-mermaid-source')
      element.innerHTML = result.svg
      if (scrollParent && shouldKeepBottom) {
        nextTick(() => {
          scrollParent.scrollTop = scrollParent.scrollHeight
        })
      }
    } catch (error) {
      cleanupMermaidRenderArtifacts(id)
      if (unmounted || generation !== renderGeneration || !root.contains(element)) return
      const timedOut = error instanceof MermaidTimeoutError
      renderMermaidFallback(element, source, timedOut)
      if (timedOut && renderPromise) retryMermaidWhenSettled(renderPromise, [source], () => cleanupMermaidRenderArtifacts(id))
    }
  }
}

onMounted(() => {
  patchMarkdownBody(renderedBlocks.value)
  void renderMermaidDiagrams()
})

watch(renderedHtml, () => {
  void renderMermaidDiagrams()
}, { flush: 'post' })

onBeforeUnmount(() => {
  unmounted = true
  renderGeneration += 1
})

async function handleMarkdownClick(event: MouseEvent): Promise<void> {
  const target = event.target as HTMLElement
  const immediateLink = target.closest('a') as HTMLAnchorElement | null
  const immediateHref = immediateLink?.getAttribute('href')
  if (immediateHref && (isLocalFilePath(immediateHref) || immediateHref.startsWith('/api/studio/files/download?'))) {
    // Native anchor navigation happens as soon as this async listener yields,
    // so local-file links must be canceled before the first await.
    event.preventDefault()
    event.stopPropagation()
  }

  const copyResult = await handleCodeBlockCopyClick(event)
  if (copyResult !== null) {
    if (copyResult) {
      message.success(t('common.copied'))
    } else {
      message.error(t('chat.copyFailed'))
    }
    return
  }

  // Handle image clicks for preview
  const img = target.closest('img') as HTMLImageElement | null
  if (img) {
    event.preventDefault()
    previewUrl.value = img.src
    return
  }

  // Handle file card clicks for download
  const fileCard = target.closest('.markdown-file-card') as HTMLElement | null
  if (fileCard) {
    event.preventDefault()
    event.stopPropagation()
    const path = fileCard.getAttribute('data-path')
    const fileName = fileCard.getAttribute('data-filename') || undefined

    const isDownloadBtn = target.closest('.att-download-btn')

    if (isDownloadBtn && path) { // Only download file with download icon clicked.
      message.info(t('download.downloading'))
      downloadFile(path, fileName).catch((err: Error) => {
        message.error(err.message || t('download.downloadFailed'))
      })
      return
    }

    if (path) {
      if (isPreviewableFile(fileName || path) && requestWorkspaceFilePreview(path, fileName || inferDownloadFileName(path))) {
        return
      } else { // Download file immediately
        downloadFile(path, fileName).catch((err: Error) => {
          message.error(err.message || t('download.downloadFailed'))
        })
      }
    }
    return
  }

  // Handle file path link clicks for download
  const link = target.closest('a') as HTMLAnchorElement | null
  if (!link) return

  const href = link.getAttribute('href')
  if (!href) return

  // Desktop chat links stay inside the embedded browser. Web deployments keep
  // using a separate browser tab so the hash-based router cannot intercept.
  if (href.startsWith('http://') || href.startsWith('https://')) {
    event.preventDefault()
    try {
      if (await openUrlInDesktopBrowser(href)) return
    } catch (error) {
      message.error(`${t('browser.loadFailed')}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    window.open(href, '_blank', 'noopener,noreferrer')
    return
  }

  // Full download URL: open directly (already has /api/studio/files/download?path=...)
  if (href.startsWith('/api/studio/files/download?')) {
    event.preventDefault()
    event.stopPropagation()
    const linkText = link.textContent || ''
    const fileName = linkText.startsWith('File: ') ? linkText.slice(6).trim() : linkText.trim()
    message.info(t('download.downloading'))
    // Parse the real file path from the existing query param
    const url = new URL(href, window.location.origin)
    const realPath = url.searchParams.get('path') || href
    downloadFile(realPath, inferDownloadFileName(realPath, fileName || undefined)).catch((err: Error) => {
      message.error(err.message || t('download.downloadFailed'))
    })
    return
  }

  // Code-styled local file links intentionally remain ordinary Markdown links.
  // Previewable files open as a single-file preview; unsupported files retain
  // the existing download fallback.
  if (isLocalFilePath(href)) {
    event.preventDefault()
    event.stopPropagation()
    const linkText = link.textContent || ''
    const fileName = linkText.startsWith('File: ') ? linkText.slice(6).trim() : linkText.trim()
    const path = localFilePathWithoutLocation(href)
    const downloadName = inferDownloadFileName(path, fileName || undefined)
    if (isPreviewableFile(downloadName)) {
      if (!requestWorkspaceFilePreview(path, downloadName, true)) {
        message.error(t('files.previewFailed'))
      }
      return
    }
    message.info(t('download.downloading'))
    downloadFile(path, downloadName).catch((err: Error) => {
      message.error(err.message || t('download.downloadFailed'))
    })
  }
}

</script>

<template>
  <!-- hermes-v050:C3 内容由 patchMarkdownBody 按块写入（原 v-html="renderedHtml"） -->
  <div ref="markdownBody" class="markdown-body" dir="auto" @click="handleMarkdownClick"></div>
  <ImagePreviewOverlay
    v-if="previewUrl"
    :src="previewUrl"
    alt=""
    @close="previewUrl = null"
  />
</template>

<style lang="scss">
@use '@/styles/variables' as *;

.markdown-body {
  // Code keeps its own direction whatever language surrounds it: a snippet
  // inside an Arabic sentence must not be mirrored.
  pre,
  code,
  kbd,
  samp {
    direction: ltr;
    unicode-bidi: isolate;
    text-align: start;
  }

  font-size: var(--font-size-base);
  line-height: 1.65;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
  overflow-x: auto;
  overflow-wrap: anywhere;
  word-break: break-word;

  p {
    margin: 0 0 8px;
    min-width: 0;
    max-width: 100%;
    overflow-wrap: anywhere;

    &:last-child {
      margin-bottom: 0;
    }
  }

  ul, ol {
    padding-inline-start: 20px;
    margin: 4px 0 8px;
  }

  li {
    margin: 2px 0;
    min-width: 0;
    max-width: 100%;
    overflow-wrap: anywhere;
  }

  strong {
    color: $text-primary;
    font-weight: 600;
  }

  em {
    color: $text-secondary;
  }

  a {
    color: $accent-primary;
    text-decoration: underline;
    text-underline-offset: 2px;
    overflow-wrap: anywhere;
    word-break: break-word;

    &:hover {
      color: $accent-hover;
    }
  }

  img {
    display: block;
    max-width: 200px;
    max-height: 160px;
    object-fit: contain;
    cursor: pointer;
    border-radius: 4px;
    margin: 8px 0;
  }

  .markdown-video-container {
    margin: 12px 0;
    border-radius: $radius-sm;
    overflow: hidden;
    background: #000;
    border: 1px solid $border-color;
  }

  .markdown-video {
    display: block;
    width: 100%;
    max-width: 640px;
    max-height: 480px;
    object-fit: contain;
  }

  .markdown-video-footer {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: rgba(0, 0, 0, 0.85);
    color: #fff;
    font-size: 12px;

    .att-name {
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  }

  .markdown-audio-container {
    margin: 12px 0;
    padding: 10px 12px;
    border: 1px solid $border-light;
    border-radius: $radius-sm;
    background-color: rgba(0, 0, 0, 0.04);
  }

  .markdown-audio {
    display: block;
    width: 100%;
    max-width: 420px;
  }

  .markdown-audio-footer {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
    color: $text-secondary;
    font-size: 12px;

    .att-name {
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  }

  .markdown-file-card {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    font-size: 12px;
    color: $text-secondary;
    background-color: rgba(0, 0, 0, 0.04);
    border: 1px solid $border-light;
    border-radius: $radius-sm;
    margin: 8px 0;
    cursor: pointer;
    transition: background-color 0.15s ease, border-color 0.15s ease;

    &:hover {
      background-color: rgba(0, 0, 0, 0.08);
      border-color: $border-color;
    }

    .att-name {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 160px;
    }

    .att-download-icon {
      flex-shrink: 0;
      opacity: 0.6;
      transition: opacity 0.15s ease;
    }

    .att-download-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      width: 18px;
      height: 18px;
      padding: 0;
      color: inherit;
      background: transparent;
      border: 0;
      cursor: pointer;
    }

    &:hover .att-download-icon,
    .att-download-btn:hover .att-download-icon {
      opacity: 1;
    }
  }

  blockquote {
    margin: 8px 0;
    padding: 4px 12px;
    border-inline-start: 3px solid $border-color;
    color: $text-secondary;
  }

  code:not(.hljs) {
    background: $code-bg;
    border: 1px solid $border-color; /* hermes-v050:U1 same code-bg + 1px border as styles/code-block.scss .hljs-code-block */
    padding: 2px 6px;
    border-radius: 4px;
    font-family: $font-code;
    font-size: 13px;
    color: $accent-primary;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  table {
    width: 100%;
    max-width: 100%;
    border-collapse: collapse;
    margin: 8px 0;
    display: block;
    overflow-x: auto;

    th, td {
      padding: 6px 12px;
      border: 1px solid $border-color;
      text-align: start;
      font-size: 13px;
    }

    th {
      background: rgba(var(--accent-primary-rgb), 0.08);
      color: $text-primary;
      font-weight: 600;
    }

    td {
      color: $text-secondary;
    }
  }

  hr {
    border: none;
    border-top: 1px solid $border-color;
    margin: 12px 0;
  }

  .mermaid-diagram {
    margin: 10px 0;
    padding: 14px;
    border: 1px solid $border-color;
    border-radius: 8px;
    background: rgba(var(--accent-primary-rgb), 0.04);
    overflow-x: auto;

    svg {
      max-width: 100%;
      height: auto;
      display: block;
      margin: 0 auto;
    }
  }

  .mermaid-loading {
    color: $text-secondary;
    font-size: 13px;
    font-family: $font-code;
    min-height: 60px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
}

</style>
