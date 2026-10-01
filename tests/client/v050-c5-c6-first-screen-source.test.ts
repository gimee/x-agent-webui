// hermes-v050:C5/C6 源码形状：highlight.js 与 xterm 移出聊天首屏静态闭包。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(`packages/client/src/${path}`, 'utf8')

describe('C5 highlight.js leaves the chat first-screen static closure', () => {
  it('never imports the full highlight.js bundle from chat code', () => {
    expect(read('components/hermes/chat/highlight.ts')).not.toMatch(/from 'highlight\.js'/)
    expect(read('components/hermes/chat/highlight-hljs.ts')).toContain("from 'highlight.js/lib/core'")
  })

  it('MessageItem statically imports only hljs-free helpers and loads the highlighter on demand', () => {
    const messageItem = read('components/hermes/chat/MessageItem.vue')
    expect(messageItem).not.toMatch(/from "\.\/highlight-hljs"/)
    expect(messageItem).toContain('import("./highlight-hljs")')
    const helpers = read('components/hermes/chat/highlight.ts')
    expect(helpers).not.toMatch(/^import .*highlight\.js/m)
  })

  it('MarkdownRenderer (already async) installs the core highlighter', () => {
    expect(read('components/hermes/chat/MarkdownRenderer.vue')).toContain("import './highlight-hljs'")
  })

  it('file previews keep the full language set through their own async chunk', () => {
    for (const file of [
      'components/hermes/files/FilePreview.vue',
      'components/hermes/files/HtmlFilePreview.vue',
      'components/hermes/files/WorkspaceFileDiff.vue',
      'components/hermes/files/WorkspaceDiffPreview.vue',
    ]) {
      expect(read(file), file).toContain("import '@/components/hermes/chat/highlight-full'")
    }
    expect(read('components/hermes/chat/highlight-full.ts')).toContain("from 'highlight.js'")
  })
})

describe('C6 xterm leaves the chat first-screen static closure', () => {
  it('loads TerminalPanel with defineAsyncComponent', () => {
    const chatPanel = read('components/hermes/chat/ChatPanel.vue')
    expect(chatPanel).not.toContain('import TerminalPanel from "./TerminalPanel.vue"')
    expect(chatPanel).toContain("const TerminalPanel = defineAsyncComponent(async () => (await import('./TerminalPanel.vue')).default);")
  })
})
