// hermes-v050:T6/T10 — 服务端源码形状：英文原文逐字保留；每条 Hermes 回执都带 messageCode；
// 持久化列与读写路径都在；run.failed 的错误码挂在原英文 error 旁边。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(process.cwd(), 'packages/server/src/modules')
const read = (path: string) => readFileSync(join(root, path), 'utf8')

const sessionCommand = read('studio/services/chat-run/session-command.ts')

describe('hermes-v050:T6 Hermes session-command source', () => {
  it('keeps every English receipt verbatim', () => {
    for (const text of [
      "'Usage: /bundles <bundle-name> [instructions]'",
      "'Usage: /skill <skill-name> [instructions]'",
      "'Use /bundles create in X-Agent to open the bundle creator.'",
      '`${label} command failed: ${',
      '`/${targetName} did not resolve to a Bundle.`',
      '`/${targetName} resolved to a Bundle. Use /bundles ${targetName} instead.`',
      '`Unknown bridge command: /${targetName}`',
      '`Learn command failed: ${',
      "'Learn command is not available.'",
      "'Usage: /moa <prompt>'",
      '`MoA one-shot queued with preset ${preset}.`',
      '`Usage: input ${usage.inputTokens}, output ${usage.outputTokens}, total ${usage.inputTokens + usage.outputTokens} tokens.`',
      '`Context: input ${usage.inputTokens}, output ${usage.outputTokens}, total ${totalTokens} / ${contextWindow} tokens (${percent}%).`',
      '`Status: ${isWorking ? \'running\' : \'idle\'}`',
      "'YOLO mode is not available in the running Hermes Agent runtime.'",
      "'⚡ YOLO mode ON for this session — all commands auto-approved. Use with caution.'",
      "'⚠️ YOLO mode OFF for this session — dangerous commands will require approval.'",
      '`YOLO command failed: ${',
      "'Abort requested.'",
      "'Usage: /queue <message>'",
      "'Session is idle. Send the message normally instead.'",
      '`Queued message. Queue length: ${state.queue.length}.`',
      '`Plan command failed: ${',
      "'Plan command is not available.'",
      "'Agent is running. Use /goal status, /goal pause, or /goal clear mid-run, or /abort before setting a new goal.'",
      '`Goal command failed: ${',
      "'Cannot clear history while the bridge run is active. Abort or destroy it first.'",
      '`Cleared ${deleted} history messages from the database.`',
      "'Cleared the current display. History in the database was not deleted.'",
      "'Usage: /title <new title>'",
      '`Title updated: ${title}`',
      "'Session was not found in the database.'",
      "'Compression can only run while the session is idle.'",
      '`Compression completed: ${result.beforeMessages} -> ${result.resultMessages} messages, ${beforeContextTokens} -> ${afterContextTokens} tokens.`',
      '`Compression failed: ${',
      "'Cannot branch while the session is running. Wait for it to finish or use /abort first.'",
      "'Cannot branch coding agent sessions.'",
      "'Cannot branch: no conversation messages found to copy.'",
      '`Branched session "${fork.title || fork.id}" from ${sessionId}.`',
      "'Usage: /steer <instruction>'",
      "'No active bridge run to steer.'",
      "'Steer instruction sent.'",
      "'MCP reload can only run while the session is idle. Wait for the current run to finish or abort it first.'",
      "`MCP reloaded successfully.${server ? ` Server: ${server}` : ' All servers.'}`",
      '`MCP reload failed: ${',
      "'Skills reload can only run while the session is idle. Wait for the current run to finish or abort it first.'",
      '`Skills reload failed: ${',
      "'Skills reloaded successfully.'",
      "'Destroyed bridge agent and stopped the active run.'",
      "'Destroyed bridge agent.'",
      '`Bridge agent was not reachable; cleared local session state.${bridgeError ? ` (${bridgeError})` : \'\'}`',
      'The running Agent Bridge does not support /reload-skills yet. Restart the bridge and try again.',
    ]) {
      expect(sessionCommand, text).toContain(text)
    }
  })

  it('codes every emitted receipt that has a literal message', () => {
    // Each emitCommand({...}) object that sets `message:` must also set `messageCode`
    // (directly, or through a `...xxxCode(...)` spread for receipts that pass bridge text through).
    const calls = [...sessionCommand.matchAll(/emitCommand\(\{([\s\S]*?)\}\)(?: \/\/[^\n]*)?\n/g)].map(match => match[1])
    const withMessage = calls.filter(body => /\bmessage[,:]/.test(body))
    expect(withMessage.length).toBeGreaterThanOrEqual(40)
    for (const body of withMessage) {
      expect(/messageCode|\.\.\.\w+Code\(/.test(body), body).toBe(true)
    }
  })

  it('persists the code beside the English content', () => {
    expect(sessionCommand).toMatch(/persistCommandMessage\(sessionId, state, message, commandCodeData\(payload\)\)/)
    expect(read('studio/infrastructure/database/schemas.ts')).toMatch(/command_data: 'TEXT',/)
    const store = read('studio/repositories/session-store.ts')
    expect(store).toMatch(/\.\.\.\(row\.command_data != null \? \{ command_data: String\(row\.command_data\) \} : \{\}\),/)
    expect(store).toMatch(/reasoning_content, command_data\)\n\s+VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?\)/)
    expect(read('studio/services/chat-run/message-format.ts')).toMatch(/if \(m\.command_data\) msg\.command_data = m\.command_data/)
  })
})

describe('hermes-v050:T10 run.failed source', () => {
  it('keeps the English errors and adds the code beside them', () => {
    const chatRun = read('studio/sockets/chat-run.ts')
    expect(chatRun).toContain("'Hermes Runtime is not installed or is incomplete. Open Runtime Manager to repair or download a Runtime.'")
    expect(chatRun).toContain('`Hermes Runtime is unavailable: ${bridgeReady.error}`')
    expect(chatRun).toContain('`Agent Bridge is not reachable: ${bridgeReady.error}`')
    expect(chatRun).toContain('`Unable to confirm Agent Bridge status while resuming: ${error}`')
    expect(chatRun).toMatch(/error_code: 'agent_bridge_status_unconfirmed'/)
    const runManager = read('coding-agents/services/runtime/run-manager.ts')
    expect(runManager).toContain("'Coding agent run failed'")
    expect(runManager).toContain("'Claude Code API error'")
    expect(runManager).toContain("'Codex run failed'")
    expect(runManager).toContain('`${agentName} exited with code ${code ?? \'unknown\'}`')
    expect(runManager).toMatch(/error: terminalError \|\| undefined,\n\s+\/\/ hermes-v050:T10[^\n]*\n\s+\.\.\.codingAgentRunErrorFields\(terminalError\),/)
  })
})
