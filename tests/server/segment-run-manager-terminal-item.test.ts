import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as responseStream from '../../packages/server/src/modules/studio/services/chat-run/response-stream'
import { extractResponseText } from '../../packages/server/src/modules/studio/services/chat-run/response-utils'

const { addMessageMock, appliedEvents } = vi.hoisted(() => ({
  addMessageMock: vi.fn(),
  appliedEvents: [] as Array<{ type: string; data: any }>,
}))

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({ addMessage: addMessageMock }))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../packages/server/src/modules/studio/public/sessions', () => ({
  createSession: vi.fn(),
  addMessage: addMessageMock,
  getSession: vi.fn(() => ({ id: 'session-1' })),
  updateSession: vi.fn(),
  updateSessionStats: vi.fn(),
}))
vi.mock('../../packages/server/src/modules/studio/public/usage', () => ({
  normalizeTokenUsage: vi.fn(() => ({ isEstimated: true })),
  recordSessionUsage: vi.fn(),
}))
vi.mock('../../packages/server/src/modules/studio/public/run-state', async () => {
  const stream = await import('../../packages/server/src/modules/studio/services/chat-run/response-stream')
  const utils = await import('../../packages/server/src/modules/studio/services/chat-run/response-utils')
  return {
    applyResponseStreamEvent: (...args: any[]) => {
      appliedEvents.push({ type: args[3], data: args[4] })
      return (stream as any).applyResponseStreamEvent(...args)
    },
    flushResponseRunToDb: (...args: any[]) => (stream as any).flushResponseRunToDb(...args),
    extractResponseText: (...args: any[]) => (utils as any).extractResponseText(...args),
    calcAndUpdateUsage: vi.fn(async () => ({})),
    completeWorkspaceRunCheckpoint: vi.fn(),
    startWorkspaceRunCheckpoint: vi.fn(),
    getChatRunServer: () => null,
    getOrCreateSession: vi.fn(),
    updateContextTokenUsage: vi.fn(),
  }
})

import { CodingAgentRunManager } from '../../packages/server/src/modules/coding-agents/services/runtime/run-manager'

function makeRun() {
  return {
    id: 'agent-session-1',
    launch: {
      agentSessionId: 'agent-session-1',
      agentId: 'claude-code',
      profile: 'default',
      provider: 'test-provider',
      model: 'test-model',
      sessionId: 'session-1',
      command: 'claude',
      args: [],
      shellCommand: 'claude',
      workspaceDir: process.cwd(),
    },
    state: { messages: [], isWorking: true, events: [], queue: [] },
    printResponseId: 'resp_1',
    printMessageId: 'msg_resp_1',
    printTextStarted: false,
    printText: '',
    printSegmentText: '',
    printCompleted: false,
    printToolBlocks: new Map(),
    lastActiveAt: Date.now(),
    startedAt: Date.now(),
    exited: false,
  } as any
}

function harness() {
  const manager = new CodingAgentRunManager()
  const run = makeRun()
  const emitToChat = vi.fn()
  ;(manager as any).runs.set(run.id, run)
  ;(manager as any).sessionIndex.set(run.launch.sessionId, run.id)
  ;(manager as any).touch = vi.fn()
  ;(manager as any).emitToChat = emitToChat
  ;(manager as any).markChatRunCompleted = vi.fn()
  ;(manager as any).completeWorkspaceRunDiff = vi.fn(() => null)
  ;(manager as any).startCodingAgentMemoryExport = vi.fn()
  ;(manager as any).refreshCodingAgentUsage = vi.fn(async () => undefined)
  ;(manager as any).cleanupRun = vi.fn()
  const line = (event: any) => (manager as any).handleClaudePrintLine(run, JSON.stringify(event))
  const stream = (event: any) => line({ type: 'stream_event', event })
  return { manager, run, emitToChat, line, stream }
}

const TEXT = 'Let me check the file.'

function textThenTool(h: ReturnType<typeof harness>) {
  h.stream({ type: 'message_start', message: { id: 'resp_1' } })
  h.stream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })
  h.stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: TEXT } })
  h.stream({ type: 'content_block_stop', index: 0 })
  h.stream({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a' } } })
  h.stream({ type: 'content_block_stop', index: 1 })
  h.line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'contents' }] } })
}

function completedItem() {
  const completed = appliedEvents.filter(e => e.type === 'response.completed')
  expect(completed).toHaveLength(1)
  const response = completed[0].data.response
  const item = response.output.find((entry: any) => entry.type === 'message')
  return { response, item }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

describe('S-F2 run-manager: terminal Responses item carries only the last text segment', () => {
  beforeEach(() => { addMessageMock.mockReset(); appliedEvents.length = 0; let id = 500; addMessageMock.mockImplementation(() => ++id) })

  it('text -> tool -> result (no trailing text): item text is empty, output keeps the aggregate, one text row persisted', async () => {
    const h = harness()
    textThenTool(h)
    h.line({ type: 'result', result: TEXT, usage: {} })
    await settle()

    const { response, item } = completedItem()
    expect(item).toBeDefined()
    expect(extractResponseText(response)).toBe('')
    expect(item.content[0].text).toBe('')

    expect(h.run.state.messages.map((m: any) => m.role)).toEqual(['assistant', 'assistant', 'tool'])
    expect(h.run.state.messages.filter((m: any) => m.role === 'assistant' && !m.tool_calls?.length).map((m: any) => m.content)).toEqual([TEXT])

    const persisted = addMessageMock.mock.calls.map(call => call[0])
    expect(persisted.filter(r => r.role === 'assistant' && !r.tool_calls).map(r => r.content)).toEqual([TEXT])
    expect(persisted.map(r => r.role)).toEqual(['assistant', 'assistant', 'tool'])

    const completedPayload = h.emitToChat.mock.calls.find(call => call[1] === 'run.completed')?.[2]
    expect(completedPayload).toBeDefined()
    // `output` is the aggregate run text contract; assistant_content names the streamed segment.
    expect(completedPayload.output).toBe(TEXT)
    expect(completedPayload.assistant_content).toBe(TEXT)
    expect(completedPayload.message_id).toBe('501')
    // The segment row is now bound to its persisted id.
    expect(h.run.state.messages[0].id).toBe(501)
  })

  it('text -> tool -> text -> result: item carries the last segment, output the aggregate, both rows persisted once', async () => {
    const h = harness()
    textThenTool(h)
    h.stream({ type: 'content_block_start', index: 2, content_block: { type: 'text' } })
    h.stream({ type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Final answer.' } })
    h.stream({ type: 'content_block_stop', index: 2 })
    h.line({ type: 'result', result: `${TEXT}Final answer.`, usage: {} })
    await settle()

    const { item } = completedItem()
    expect(item.content[0].text).toBe('Final answer.')

    expect(h.run.state.messages.map((m: any) => m.role)).toEqual(['assistant', 'assistant', 'tool', 'assistant'])
    const textRows = h.run.state.messages.filter((m: any) => m.role === 'assistant' && !m.tool_calls?.length)
    expect(textRows.map((m: any) => m.content)).toEqual([TEXT, 'Final answer.'])

    const persisted = addMessageMock.mock.calls.map(call => call[0])
    expect(persisted.filter(r => r.role === 'assistant' && !r.tool_calls).map(r => r.content)).toEqual([TEXT, 'Final answer.'])

    const completedPayload = h.emitToChat.mock.calls.find(call => call[1] === 'run.completed')?.[2]
    expect(completedPayload.output).toBe(`${TEXT}Final answer.`)
    expect(completedPayload.assistant_content).toBe('Final answer.')
  })

  it('single segment without tools: item text equals the streamed text (unchanged contract)', async () => {
    const h = harness()
    h.stream({ type: 'message_start', message: { id: 'resp_1' } })
    h.stream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })
    h.stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Just an answer.' } })
    h.line({ type: 'result', result: 'Just an answer.', usage: {} })
    await settle()

    const { item, response } = completedItem()
    expect(item.content[0].text).toBe('Just an answer.')
    expect(extractResponseText(response)).toBe('Just an answer.')
    expect(h.run.state.messages.map((m: any) => m.content)).toEqual(['Just an answer.'])
    expect(addMessageMock.mock.calls).toHaveLength(1)
    const completedPayload = h.emitToChat.mock.calls.find(call => call[1] === 'run.completed')?.[2]
    expect(completedPayload.output).toBe('Just an answer.')
  })
})
