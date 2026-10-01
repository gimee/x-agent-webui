// hermes-v050:T6/T10 — 客户端源码形状：Hermes 回执分支排在 /status 卡片之前且串成 v-if 链；
// store 的四个 run.failed 入口与 reattach 文本都先过译文；代码里不写「Claude Code」。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(process.cwd(), 'packages/client/src')
const read = (path: string) => readFileSync(join(root, path), 'utf8')

describe('hermes-v050:T6 MessageItem wiring', () => {
  const source = read('components/hermes/chat/MessageItem.vue')

  it('renders the coded Hermes receipt first and chains the status card behind it', () => {
    expect(source).toContain('import { formatHermesCommandResultText } from "@/utils/hermes/hermes-command-result-text";')
    const hermes = source.indexOf('<div v-if="hermesCommandText" class="command-result">')
    const status = source.indexOf('<div v-else-if="isStatusCommand" class="command-result command-status">')
    const generic = source.indexOf('<div v-else-if="isCommandMessage && message.content" class="command-result">')
    expect(hermes).toBeGreaterThan(0)
    expect(status).toBeGreaterThan(hermes)
    expect(generic).toBeGreaterThan(status)
    expect(source).toContain('<MarkdownRenderer :content="hermesCommandText" />')
    expect(source).not.toContain('<div v-if="isStatusCommand"')
  })
})

describe('hermes-v050:T6/T10 chat store wiring', () => {
  const source = read('stores/hermes/chat.ts')

  it('reads the persisted code back for command rows', () => {
    expect(source).toMatch(/\.\.\.\(displayRole === 'command' \? hermesCommandDataFields\(msg\.command_data\) : \{\}\),/)
  })

  it('passes a translated error into every run.failed error bubble', () => {
    const calls = [...source.matchAll(/addAgentErrorMessage\((\w+), (e|evt)\.error\)/g)]
    expect(calls).toHaveLength(0)
    expect([...source.matchAll(/addAgentErrorMessage\(\w+, runErrorForDisplay\((e|evt)\)\)/g)]).toHaveLength(4)
  })

  it('translates the reattach warning text', () => {
    expect(source).toMatch(/const text = String\(runEventTextForDisplay\(evt\) \?\? \(\(evt as any\)\.text \|\| \(evt as any\)\.message \|\| ''\)\)\.trim\(\)/)
  })

  it('keeps the brand out of the new client modules', () => {
    for (const path of ['utils/hermes/hermes-command-result-text.ts', 'utils/hermes/run-error-text.ts']) {
      expect(read(path)).not.toMatch(/Claude Code/)
    }
  })
})
