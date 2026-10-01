// hermes-v050 界面线 C — 纯样式 / 模板项的源码形状测试（守住关键声明与照搬来源）。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(`packages/client/src/${path}`, 'utf8')
const style = (source: string) => source.slice(source.indexOf('<style'))
const block = (css: string, selector: string) => {
  // prefer the top-level rule (column 0) over a nested / media-query copy
  const top = css.indexOf(`\n${selector} {`)
  const start = top >= 0 ? top + 1 : css.indexOf(`${selector} {`)
  if (start < 0) return ''
  let depth = 0
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++
    if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1)
  }
  return ''
}
const FOLDER_PATH = 'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'
const REFRESH_ICON = '<polyline points="23 4 23 10 17 10" />\n'

describe('hermes-v050 界面线 C source shape', () => {
  it('U1 inline code copies the code-block 1px border', () => {
    const codeBlock = read('styles/code-block.scss')
    expect(block(codeBlock, '.hljs-code-block')).toContain('border: 1px solid $border-color;')
    const inline = block(style(read('components/hermes/chat/MarkdownRenderer.vue')), 'code:not(.hljs)')
    expect(inline).toContain('background: $code-bg;')
    expect(inline).toContain('border: 1px solid $border-color;')
    expect(inline).toContain('hermes-v050:U1')
  })

  it('U4 both reasoning-effort rails copy the .context-bar track', () => {
    const chatInput = style(read('components/hermes/chat/ChatInput.vue'))
    expect(block(chatInput, '.context-bar')).toContain('background: rgba(var(--text-muted-rgb), 0.2);')
    for (const file of ['components/hermes/chat/ChatInput.vue', 'components/layout/CcEffortPicker.vue']) {
      const css = style(read(file))
      expect(block(css, ':deep(.n-slider-rail)')).toContain('background: rgba(var(--text-muted-rgb), 0.2);')
      expect(css).not.toContain('rgba(255, 255, 255, 0.14)')
    }
  })

  it('U8 history header uses the chat header folder SVG instead of the 📁 emoji and a translated source name', () => {
    const history = read('views/hermes/HistoryView.vue')
    const chatPanel = read('components/hermes/chat/ChatPanel.vue')
    expect(chatPanel).toContain(FOLDER_PATH)
    expect(history).toContain(FOLDER_PATH)
    expect(history).not.toContain('📁')
    expect(history).toContain('getSourceLabel(activeSessionSource, t)')
    const badge = block(style(history), '.workspace-badge')
    expect(badge).toContain('gap: 4px;')
    expect(badge).toMatch(/svg\s*\{\s*flex: 0 0 auto;\s*\}/)
  })

  it('U9 workspace badges get the 12% muted tint in both themes', () => {
    for (const file of ['components/hermes/chat/ChatPanel.vue', 'views/hermes/HistoryView.vue']) {
      const badge = block(style(read(file)), '.workspace-badge')
      expect(badge).toContain('background: rgba(var(--text-muted-rgb), 0.12);')
      expect(badge).not.toContain('rgba(255, 255, 255, 0.05)')
    }
  })

  it('U10 / U11 select and input placeholders', () => {
    const theme = read('styles/theme.ts')
    expect(theme).toMatch(/InternalSelection: \{[^}]*placeholderColor: '#999999'/s)
    expect(theme).toMatch(/InternalSelection: \{[^}]*placeholderColor: '#888888'/s)
    expect(theme).not.toContain("placeholderColor: '#666666'")
  })

  it('U12 history list top padding matches the chat list', () => {
    expect(block(style(read('components/hermes/chat/ChatPanel.vue')), '.session-items')).toContain('padding: 10px 6px 12px;')
    expect(block(style(read('views/hermes/HistoryView.vue')), '.session-items')).toContain('padding: 10px 6px 12px;')
  })

  it('U13 / U19 mobile headers keep title + workspace badge', () => {
    const history = style(read('views/hermes/HistoryView.vue'))
    const mobile = history.slice(history.indexOf('@media (max-width: $breakpoint-mobile)'))
    expect(mobile).toMatch(/\.source-badge \{\s*display: none;\s*\}/)
    expect(mobile).toMatch(/\.workspace-badge \{\s*flex-shrink: 0;\s*\}/)
    const chat = style(read('components/hermes/chat/ChatPanel.vue'))
    const chatMobile = chat.slice(chat.indexOf('@media (max-width: $breakpoint-mobile) {\n  .chat-header'))
    const chatMobileBlock = chatMobile.slice(0, chatMobile.indexOf('\n}\n'))
    expect(chatMobileBlock).not.toMatch(/\.header-session-title \{\s*display: none;/)
    expect(chatMobileBlock).toMatch(/\.workspace-badge \{\s*flex-shrink: 0;\s*\}/)
  })

  it('U14 Agent-management icon is 15px like its siblings', () => {
    const nav = read('components/layout/PageSidebarNav.vue')
    expect(nav).not.toContain('width="17"')
    expect(nav.match(/width="15"\s+height="15"/g)?.length).toBeGreaterThanOrEqual(5)
  })

  it('U17 light muted text token is #767676 with matching rgb', () => {
    const vars = read('styles/variables.scss')
    const root = vars.slice(vars.indexOf(':root {'), vars.indexOf('.dark {'))
    expect(root).toContain('--text-muted: #767676;')
    expect(root).toContain('--text-muted-rgb: 118, 118, 118;')
    const dark = vars.slice(vars.indexOf('.dark {'), vars.indexOf('.comic {'))
    expect(dark).toContain('--text-muted: #888888;')
  })

  it('U18 thinking body is not italic but keeps opacity, border and size', () => {
    const body = block(style(read('components/hermes/chat/MessageItem.vue')), '.thinking-body')
    expect(body).not.toContain('font-style: italic')
    expect(body).toContain('opacity: 0.85;')
    expect(body).toContain('border-inline-start: 2px solid $border-light;')
    expect(body).toContain('font-size: 13px;')
  })

  it('U20 provider cards follow content height', () => {
    expect(block(style(read('components/hermes/models/ProvidersPanel.vue')), '.providers-grid')).toContain('align-items: start;')
    const list = block(style(read('components/hermes/models/ProviderCard.vue')), '.models-list')
    expect(list).toContain('max-height: 100px;')
    expect(list).not.toMatch(/(^|\s)height: 100px;/)
  })

  it('U21 Hermes source tag uses the default tag like the other provider tags', () => {
    const manager = read('views/hermes/AgentManagerView.vue')
    const tag = manager.slice(manager.indexOf('data-testid="hermes-source-type"') - 120, manager.indexOf('data-testid="hermes-source-type"') + 120)
    expect(tag).not.toContain('type="info"')
    expect(manager).toContain('<NTag size="small" :bordered="false">{{ agent.provider }}</NTag>')
  })

  it('U24 folder picker uses the SVG folder and the tool-line chevron', () => {
    const picker = read('components/hermes/chat/FolderPicker.vue')
    expect(picker).not.toMatch(/📂|📁|▶|▼/)
    expect(picker.split(FOLDER_PATH).length - 1).toBe(2)
    expect(picker).toContain('<polyline points="9 18 15 12 9 6" />')
    const chevron = block(style(picker), '.folder-chevron')
    const tool = block(style(read('components/hermes/chat/MessageItem.vue')), '.tool-chevron')
    expect(chevron.replace('.folder-chevron', '')).toBe(tool.replace('.tool-chevron', ''))
  })

  it('hermes-v050:E-05 the folder chevron box aligns its SVG like the tool line (flex + centered)', () => {
    const expand = block(style(read('components/hermes/chat/FolderPicker.vue')), '.folder-expand')
    const toolLine = block(style(read('components/hermes/chat/MessageItem.vue')), '.tool-line')
    for (const declaration of ['display: flex;', 'align-items: center;']) {
      expect(toolLine).toContain(declaration)
      expect(expand).toContain(declaration)
    }
    // the 14px box used text-align to center the 10px SVG; a flex box needs justify-content for that
    expect(expand).toContain('justify-content: center;')
    expect(expand).toContain('hermes-v050:E-05')
  })

  it('U26 refresh buttons copy the memory page icon + text quaternary button', () => {
    const memory = read('views/hermes/MemoryView.vue')
    expect(memory).toContain('<NButton size="small" quaternary @click="loadMemory">')
    expect(memory).toContain(REFRESH_ICON)
    const agent = read('views/hermes/AgentManagerView.vue')
    expect(agent).toContain('<NButton size="small" quaternary :loading="loading" @click="refreshAll()">')
    const usage = read('views/hermes/UsageView.vue')
    const models = read('views/hermes/ModelsView.vue')
    for (const source of [agent, usage, models]) expect(source).toContain(REFRESH_ICON)
    expect(models).toMatch(/<NButton\s+size="small"\s+quaternary\s+:loading="modelsStore.refreshingModelCache"/)
    expect(models).not.toContain('M21 12a9 9 0 0 1-9 9 9.7 9.7 0 0 1-6.7-2.7')
  })

  it('U16 literals are replaced by t() in components', () => {
    const checks: Array<[string, string[], string[]]> = [
      ['components/hermes/chat/MessageList.vue', ["t('chat.compression.running'", "t('chat.abort.pausing')", "t('jobs.status.paused')"], ['Compressing...', 'Paused and synced', "'Paused'"]],
      ['components/hermes/chat/ChatPanel.vue', ["t('models.noResults')", "t('models.noModels')"], ["'No results'", "'No models'"]],
      ['components/layout/ModelSelector.vue', ["t('models.noResults')", "t('models.noModels')"], ["'No results'", "'No models'"]],
      ['components/layout/ThemeSwitch.vue', ["t('theme.styleInk')", "t('theme.modeDark')"], ['Ink style', 'Dark mode']],
      ['components/layout/AppSidebar.vue', ["t('sidebar.website')"], ['title="Website"']],
      ['components/hermes/chat/ChatInput.vue', ["t('chat.reasoningEffort.tooltipWithValue'", "t('chat.stop')", "t('chat.send')"], ["'Stop' : 'Send'"]],
      ['components/hermes/skills/SkillDetail.vue', ["t('skills.stats.views')"], ['title="Views"', 'title="Uses"', 'title="Patches"']],
      ['components/hermes/models/ProviderEditorModal.vue', ["t('models.apiMode')"], ['<span>API Mode</span>']],
      ['components/hermes/profiles/ProfileCard.vue', ["t('common.yes')", "t('common.no')"], ["'Yes' : 'No'"]],
      ['components/hermes/kanban/KanbanTaskDrawer.vue', ["t('kanban.detail.taskId')", "t('kanban.detail.parents')", "t('kanban.detail.children')"], ['>Task ID<', '>Parent<', '>Children<']],
      ['components/hermes/settings/PlatformSettings.vue', ["t('platform.botToken')\"", 'platformDisplayName(p)'], ['placeholder="Bot token..."', 'placeholder="Matrix password"', 'placeholder="Encrypt Key"', 'placeholder="Verification Token"', 'placeholder="AI Card Template ID"']],
      ['components/hermes/jobs/JobFormModal.vue', ["t('session.source.weixin')"], ["weixin: 'WeChat'"]],
      ['App.vue', ["t('common.menu')"], ['alt="Menu"']],
      ['components/layout/PageSidebarNav.vue', ["t('sidebar.a11y.chatActions')", "t('sidebar.a11y.conversationType')"], ['aria-label="Chat actions"', 'aria-label="Conversation type"']],
      ['components/layout/DesktopTitleBar.vue', ["t('desktopTitleBar.minimize')"], ['aria-label="Minimize"', "'Restore' : 'Maximize'", 'aria-label="Close"']],
      ['views/hermes/UsageView.vue', ["t('usage.a11y.period')"], ['aria-label="Usage statistics period"']],
      ['components/hermes/usage/ModelBreakdown.vue', ["t('usage.a11y.tokenTypeLegend')"], ['aria-label="Token type legend"']],
      ['components/hermes/usage/DailyTrend.vue', ["t('usage.a11y.tokenTypeLegend')"], ['aria-label="Token type legend"']],
      ['components/hermes/usage/AgentBreakdown.vue', ["t('usage.a11y.tokenTypeLegend')"], ['aria-label="Token type legend"']],
      ['components/hermes/chat/SessionSearchModal.vue', ['getSourceLabel(source, t)'], ["global_agent: 'Global Agent'"]],
    ]
    const problems: string[] = []
    for (const [file, present, absent] of checks) {
      const source = read(file)
      for (const text of present) if (!source.includes(text)) problems.push(`${file}: missing ${text}`)
      for (const text of absent) if (source.includes(text)) problems.push(`${file}: still has ${text}`)
      if (!source.includes('hermes-v050:')) problems.push(`${file}: no hermes-v050 marker`)
    }
    expect(problems).toEqual([])
  })

  it('U3 server no longer appends the compaction summary to the reply text', () => {
    const runManager = readFileSync('packages/server/src/modules/coding-agents/services/runtime/run-manager.ts', 'utf8')
    expect(runManager).not.toContain('`Compaction completed (${trigger}).`')
    const branch = runManager.slice(runManager.indexOf("event.subtype === 'compact_boundary'"), runManager.indexOf("event.subtype === 'host_compaction'"))
    expect(branch).toContain('this.emitClaudeHostCompaction(run, {')
    expect(branch).not.toContain('run.printText')
  })
})
