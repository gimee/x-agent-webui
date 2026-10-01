// Guard test for the provider:model composer label. The source tree is frozen, edit here.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const CHAT_PANEL = 'packages/client/src/components/hermes/chat/ChatPanel.vue'
const CHAT_INPUT = 'packages/client/src/components/hermes/chat/ChatInput.vue'

// Lift the computed's body straight out of the SFC and run it.  A toContain()
// on the same string would pass just as happily against dead code; this fails
// when upstream reshapes the data flow, which is the whole point.
//
// The body also reads `activeSessionUsesGlobalCodingAgentConfig` (an upstream
// branch) — inject it as a third parameter, defaulting to
// false, so existing call sites stay two-argument.
function buildLabelFn(usesGlobalCodingAgent = false) {
  const source = readFileSync(CHAT_PANEL, 'utf8')
  const body = source.match(
    /const activeSessionModelLabel = computed\(\(\) => \{\n([\s\S]*?)\n\}\);/,
  )
  if (!body) throw new Error('activeSessionModelLabel no longer has the patched shape')
  const raw = new Function('chatStore', 't', 'activeSessionUsesGlobalCodingAgentConfig', body[1])
  return ((chatStore, t) =>
    raw(chatStore, t, { value: usesGlobalCodingAgent })) as (
    chatStore: { activeSession: { provider?: string; model?: string } },
    t: (key: string) => string,
  ) => string
}

const t = (key: string) => key

describe('chat composer provider:model data flow', () => {
  it('strips the custom: namespace prefix that self-hosted providers carry', () => {
    const label = buildLabelFn()

    expect(label({ activeSession: { provider: 'custom:fixture-provider', model: 'fixture-model' } }, t))
      .toBe('fixture-provider:fixture-model')
    expect(label({ activeSession: { provider: 'anthropic', model: 'claude-opus-4-8' } }, t))
      .toBe('anthropic:claude-opus-4-8')
  })

  it('only strips the prefix, never a custom: that belongs to the model id', () => {
    const label = buildLabelFn()

    expect(label({ activeSession: { provider: 'fixture-proxy', model: 'custom:fixture-model' } }, t))
      .toBe('fixture-proxy:custom:fixture-model')
    expect(label({ activeSession: { provider: 'my-custom:proxy', model: 'gpt-5.6' } }, t))
      .toBe('my-custom:proxy:gpt-5.6')
  })

  it('falls back to the bare model, then to the picker prompt', () => {
    const label = buildLabelFn()

    expect(label({ activeSession: { provider: '   ', model: 'fixture-model' } }, t)).toBe('fixture-model')
    expect(label({ activeSession: {} }, t)).toBe('models.selectModel')
  })

  it('keeps the upstream global-coding-agent branch ahead of our label', () => {
    const label = buildLabelFn(true)

    expect(label({ activeSession: { provider: 'custom:fixture-provider', model: 'fixture-model' } }, t))
      .toBe('codingAgents.launchModeGlobal')
  })

  it('does not replace the pair with a configured alias', () => {
    expect(readFileSync(CHAT_PANEL, 'utf8'))
      .not.toContain('return appStore.displayModelName(session.model, session.provider);')
  })

  it('does not strip slash-containing model ids in the composer', () => {
    const source = readFileSync(CHAT_INPUT, 'utf8')

    expect(source).toContain(
      "const compactModelLabel = computed(() => {\n  const label = props.modelLabel || t('models.selectModel')\n  return label\n})",
    )
    expect(source).not.toContain("label.split('/').filter(Boolean)")
  })
})

describe('chat composer model button width', () => {
  it('sizes the button to its content instead of a fixed 190px cap', () => {
    const source = readFileSync(CHAT_INPUT, 'utf8')

    expect(source).not.toContain('max-width: 190px')
    expect(source).toMatch(/\.input-model-button \{[\s\S]*?max-width: 100%;\n  min-width: 0;/)
  })

  it('makes the model button the only top-bar sibling that yields space on desktop', () => {
    const source = readFileSync(CHAT_INPUT, 'utf8')

    expect(source).toMatch(
      /@media \(min-width: 769px\) \{\n  \.input-top-bar > \* \{\n    flex-shrink: 0;\n  \}\n\n  \.input-model-button \{\n    flex-shrink: 1;\n  \}\n\}/,
    )
  })

  it('leaves the mobile icon-only button alone', () => {
    const source = readFileSync(CHAT_INPUT, 'utf8')

    expect(source).toMatch(/\.input-model-button \{\n    min-width: 35px;\n    max-width: 35px;/)
  })
})

