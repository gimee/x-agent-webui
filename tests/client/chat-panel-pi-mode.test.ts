import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('ChatPanel Pi effective mode', () => {
  it('offers Global for Pi and keeps the requested mode for every remaining runtime (v0.1.2)', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/ChatPanel.vue', 'utf8')

    expect(source).toContain('{ label: t("codingAgents.launchModeGlobal"), value: "global" }')
    expect(source).toContain('return requestedMode;')
    expect(source).not.toContain('ekko-agent')
    expect(source).toContain('const mode = effectiveNewChatMode(newChatAgent.value, newChatAgentMode.value);')
    expect(source).not.toContain('newChatAgent.value === "pi" && newChatAgentMode.value !== "scoped"')
  })
})
