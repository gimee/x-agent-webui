// hermes-v051:C source-shape guard: the Claude compression dialog is copied, not designed.
//  - modal shell (NModal + header + close button + dialog CSS) = CcApiBadge.vue
//  - the five rows = CompressionSettings.vue, only the :value binding prefix changes and :disabled is added
//  - the number-box limits equal the server's PUT limits
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CLAUDE_COMPRESSION_OWN_LIMITS } from '../../packages/server/src/modules/coding-agents/services/claude-compression-settings'

const read = (path: string) => readFileSync(`packages/client/src/${path}`, 'utf8')
const NEW = 'components/layout/CcCompressionSettings.vue'
const style = (source: string) => source.slice(source.indexOf('<style'))
const template = (source: string) => source.slice(source.indexOf('<template>'), source.lastIndexOf('</template>'))
const lines = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean)
const block = (css: string, selector: string) => {
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
const settingRows = (source: string) => [...template(source).matchAll(/<SettingRow[\s\S]*?<\/SettingRow>/g)].map(match => match[0])

describe('hermes-v051:C CcCompressionSettings copies its sources', () => {
  it('the five rows are CompressionSettings.vue rows with only the value prefix changed and :disabled added', () => {
    const original = settingRows(read('components/hermes/settings/CompressionSettings.vue'))
    const copied = settingRows(read(NEW))
    expect(original).toHaveLength(5)
    expect(copied).toHaveLength(6)
    const normalize = (row: string) => lines(row)
      .filter(line => line !== ':disabled="followMain || !loaded"')
      .map(line => line.replace('shown.', 'settingsStore.compression.'))
    copied.slice(1).forEach((row, index) => {
      expect(normalize(row)).toEqual(lines(original[index]))
      expect(lines(row)).toContain(':disabled="followMain || !loaded"')
    })
    // First row: the follow switch uses the same SettingRow + small NSwitch as the "enabled" row.
    expect(lines(copied[0])).toEqual([
      '<SettingRow :label="t(\'ccCompression.followMain\')" :hint="t(\'ccCompression.followMainHint\')">',
      '<NSwitch',
      ':value="followMain"',
      ':disabled="!loaded"',
      'size="small"',
      '@update:value="v => saveFollowMain(v)"',
      '/>',
      '</SettingRow>',
    ])
    expect(style(read(NEW))).toContain(block(style(read('components/hermes/settings/CompressionSettings.vue')), '.settings-section'))
  })

  it('the modal shell is CcApiBadge.vue (header, title, close button, dialog CSS)', () => {
    const badge = read('components/layout/CcApiBadge.vue')
    const source = read(NEW)
    const header = (text: string) => lines(text.slice(text.indexOf('<NModal'), text.indexOf('<div class="mcu-device-table">')))
      .filter(line => !line.includes('mcu-device-subtitle'))
    expect(header(source)).toEqual(header(badge).map(line => line.replace("t('ccApi.title')", "t('ccCompression.title')")))
    // hermes-v051:C the only departure: the shell's fixed table height is dropped (the two `height` lines
    // are deleted, nothing added), so six rows size to content and NModal scrolls them on short screens.
    const unsized = (css: string) => css.split('\n').filter(line => !/^\s*height: /.test(line)).join('\n')
    expect(block(style(source), '.mcu-device-dialog')).toBe(unsized(block(style(badge), '.mcu-device-dialog')))
    for (const selector of ['.mcu-device-header', '.mcu-device-title', '.mcu-device-close']) {
      expect(block(style(source), selector), selector).toBe(block(style(badge), selector))
    }
    // Body container: CcApiBadge's own declarations (its table-only :deep rules are left out).
    const declarations = (css: string) => lines(css).filter(line => /^[a-z-]+: .+;$/.test(line))
    expect(declarations(block(style(source), '.mcu-device-table'))).toEqual(declarations(block(style(badge), '.mcu-device-table')).slice(0, 4))
    expect(style(source)).toContain('@media (max-width: 640px) {\n  .mcu-device-dialog {\n    width: calc(100vw - 24px);\n  }\n')
    // No new style values beyond the copied blocks.
    const allowed = new Set([
      ...lines(style(badge)),
      ...lines(style(read('components/hermes/settings/CompressionSettings.vue'))),
    ])
    for (const line of lines(style(source))) expect(allowed.has(line), line).toBe(true)
  })

  it('number-box limits equal the PUT limits enforced by the server', () => {
    const boxes = [...template(read(NEW)).matchAll(/:min="([\d.]+)"\s+:max="([\d.]+)"/g)].map(match => [Number(match[1]), Number(match[2])])
    const limits = CLAUDE_COMPRESSION_OWN_LIMITS
    expect(boxes).toEqual([
      [limits.threshold.min, limits.threshold.max],
      [limits.targetRatio.min, limits.targetRatio.max],
      [limits.protectLastN.min, limits.protectLastN.max],
      [limits.protectFirstN.min, limits.protectFirstN.max],
    ])
  })

  it('keeps the brand out of the client copy', () => {
    expect(read(NEW)).not.toMatch(/Claude Code/)
  })
})
