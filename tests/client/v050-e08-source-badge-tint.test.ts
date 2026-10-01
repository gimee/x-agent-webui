// hermes-v050:E-08 历史页头部的来源徽标没有底色：`rgba($text-muted, 0.12)` 里 $text-muted 是
// var(--text-muted)（十六进制色），编译出 `rgba(var(--text-muted), 0.12)` 是无效值，整条 background 被丢弃。
// 来源徽标照搬相邻工作区徽标（U9）的有效写法 `rgba(var(--text-muted-rgb), 0.12)`。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(`packages/client/src/${path}`, 'utf8')
const style = (source: string) => source.slice(source.indexOf('<style'))
const block = (css: string, selector: string) => {
  // 取顶层规则（第 0 列），不取媒体查询里的副本
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

describe('hermes-v050:E-08 source badge tint', () => {
  for (const file of ['views/hermes/HistoryView.vue', 'components/hermes/chat/ChatPanel.vue']) {
    it(`${file} .source-badge uses the same valid 12% muted tint as .workspace-badge`, () => {
      const css = style(read(file))
      const workspace = block(css, '.workspace-badge')
      const source = block(css, '.source-badge')
      expect(workspace).toContain('background: rgba(var(--text-muted-rgb), 0.12);')
      expect(source).toContain('background: rgba(var(--text-muted-rgb), 0.12);')
      expect(source).toContain('hermes-v050:E-08')
      expect(css).not.toContain('rgba($text-muted, 0.12)')
    })
  }

  it('both themes define the rgb triplet the tint reads', () => {
    const variables = read('styles/variables.scss')
    expect(variables.match(/--text-muted-rgb: \d+, \d+, \d+;/g)?.length).toBeGreaterThanOrEqual(2)
  })
})
