import { describe, expect, it } from 'vitest'
import {
  canScopedCodingAgentUseProvider,
  isAuthModelProvider,
  usesServerManagedProviderAuth,
} from '../../packages/client/src/utils/codingAgentProviders'

describe('coding agent provider visibility', () => {
  it.each(['claude-code', 'codex'] as const)(
    'keeps auth providers hidden from scoped %s sessions',
    (agentId) => {
      expect(canScopedCodingAgentUseProvider(agentId, 'openai-codex')).toBe(false)
      expect(canScopedCodingAgentUseProvider(agentId, 'qwen-oauth')).toBe(false)
      expect(usesServerManagedProviderAuth(agentId, 'openai-codex')).toBe(false)
      expect(canScopedCodingAgentUseProvider(agentId, 'deepseek')).toBe(true)
    },
  )
})
