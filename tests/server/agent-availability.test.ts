import { beforeEach, describe, expect, it } from 'vitest'
import {
  resetAgentStatusRegistryForTests,
  updateAgentStatus,
} from '../../packages/server/src/modules/studio/public/agent-status-registry'
import {
  AGENT_NOT_INSTALLED,
  assertAgentAvailable,
  resolveAgentStatusId,
} from '../../packages/server/src/modules/studio/services/agent-availability'

describe('Agent availability validation', () => {
  beforeEach(resetAgentStatusRegistryForTests)

  it('normalizes Agent aliases', () => {
    expect(resolveAgentStatusId('claude')).toBe('claude-code')
    expect(resolveAgentStatusId('claude-code')).toBe('claude-code')
  })

  it('rejects unavailable Agents with a stable conflict code', () => {
    expect(() => assertAgentAvailable('codex')).toThrow('Codex is not installed')

    try {
      assertAgentAvailable('codex')
    } catch (error: any) {
      expect(error).toMatchObject({ status: 409, code: AGENT_NOT_INSTALLED, agent: 'codex' })
    }

    updateAgentStatus('codex', {
      installed: true,
      source: 'user-cli',
      path: '/usr/local/bin/codex',
    })
    expect(assertAgentAvailable('codex')).toBe('codex')
  })

})
