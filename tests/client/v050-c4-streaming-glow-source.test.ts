// hermes-v050:C4 源码形状：运行中光环只用 opacity 合成层动画，颜色/周期/幅度照搬原 rainbow-glow。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('packages/client/src/components/hermes/chat/SessionListItem.vue', 'utf8')
const style = source.slice(source.indexOf('<style'))

function keyframes(name: string): string {
  const start = style.indexOf(`@keyframes ${name}`)
  if (start < 0) return ''
  let depth = 0
  for (let i = style.indexOf('{', start); i < style.length; i += 1) {
    if (style[i] === '{') depth += 1
    if (style[i] === '}') {
      depth -= 1
      if (depth === 0) return style.slice(start, i + 1)
    }
  }
  return ''
}

describe('C4 streaming glow runs on the compositor', () => {
  it('does not animate box-shadow anywhere in the session row', () => {
    const animationNames = [...style.matchAll(/animation(?:-name)?:\s*([a-z0-9-]+)/gi)].map(m => m[1]).filter(n => n !== 'none')
    expect(animationNames.length).toBeGreaterThan(0)
    for (const name of new Set(animationNames)) {
      const body = keyframes(name)
      expect(body, name).not.toBe('')
      expect(body, name).not.toMatch(/box-shadow|background|color|width|height|inset|top|left/)
      expect(body, name).toMatch(/opacity|transform/)
    }
    expect(style).not.toContain('@keyframes rainbow-glow')
  })

  it('keeps the original six colours, 2px ring, 10px/20px glows and 4s linear period', () => {
    for (const [hex, rgb] of [
      ['#ff6b6b', '255, 107, 107'],
      ['#feca57', '254, 202, 87'],
      ['#48dbfb', '72, 219, 251'],
      ['#ff9ff3', '255, 159, 243'],
      ['#54a0ff', '84, 160, 255'],
      ['#5f27cd', '95, 39, 205'],
    ]) {
      expect(style).toContain(`0 0 0 2px ${hex},\n    0 0 10px rgba(${rgb}, 0.4),\n    0 0 20px rgba(${rgb}, 0.2);`)
    }
    expect(style).toMatch(/animation: [a-z0-9-]+ 4s linear infinite;/)
  })

  it('stops the animation for prefers-reduced-motion and keeps a static ring', () => {
    const reduced = style.slice(style.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toMatch(/animation: none;/)
    expect(reduced).toMatch(/opacity: 1;/)
  })

  it('renders the glow layers only for streaming rows', () => {
    expect(source).toMatch(/<span v-if="streaming" class="session-item-agent-glow" aria-hidden="true">/)
  })
})
