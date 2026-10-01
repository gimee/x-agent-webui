/**
 * Response stream event handling — maps upstream /v1/responses events
 * to client-facing events and updates in-memory session state.
 */

import { randomUUID } from 'node:crypto'
import { logger } from '../../public/logging'
import { persistRunMessages } from './message-persistence'
import { summarizeToolArguments, responseFunctionCallToToolCall } from './response-utils'
import type { SessionState, ResponseRunState } from './types'

function textFromResponseMessageItem(item: any): string {
  const content = Array.isArray(item?.content) ? item.content : []
  return content
    .map((part: any) => {
      if (typeof part?.text === 'string') return part.text
      if (typeof part?.content === 'string') return part.content
      return ''
    })
    .filter(Boolean)
    .join('')
}

function reasoningTextFromEvent(parsed: any): string {
  if (typeof parsed?.delta === 'string') return parsed.delta
  if (typeof parsed?.text === 'string') return parsed.text
  if (typeof parsed?.summary === 'string') return parsed.summary
  if (typeof parsed?.reasoning === 'string') return parsed.reasoning
  if (Array.isArray(parsed?.summary)) {
    return parsed.summary
      .map((part: any) => typeof part?.text === 'string' ? part.text : typeof part === 'string' ? part : '')
      .filter(Boolean)
      .join('')
  }
  return ''
}

function isReasoningResponseItem(item: any): boolean {
  const type = String(item?.type || '')
  return type === 'reasoning' || type === 'reasoning_text' || type === 'reasoning_summary'
}

function appendedTextDelta(existing: string, next: string): string {
  if (!existing || !next) return next
  if (next.startsWith(existing)) return next.slice(existing.length)
  const max = Math.min(existing.length, next.length)
  for (let length = max; length >= 16; length--) {
    if (existing.endsWith(next.slice(0, length))) return next.slice(length)
  }
  return next
}

function appendReasoningToMessage(run: ResponseRunState, message: any, text: string): string {
  if (!text || message?.role !== 'assistant') return ''
  const existing = message.reasoning || message.reasoning_content || ''
  const delta = appendedTextDelta(existing, text)
  if (!delta) return ''
  const reasoning = `${existing}${delta}`
  message.reasoning = reasoning
  message.reasoning_content = reasoning
  run.reasoningMessageId = message.id
  return delta
}

function captureToolBoundaryReasoning(
  state: SessionState,
  run: ResponseRunState,
  callId: string,
): string {
  run.toolReasoning = run.toolReasoning || new Map<string, string>()
  const existing = run.toolReasoning.get(callId) || ''
  const target = run.reasoningMessageId != null
    ? state.messages.find(message => message.id === run.reasoningMessageId && message.role === 'assistant')
    : null
  const targetReasoning = String(target?.reasoning || target?.reasoning_content || '')
  const pendingReasoning = run.pendingReasoning || ''
  let reasoning = existing || targetReasoning || pendingReasoning || run.toolBoundaryReasoning || ''
  if (existing && pendingReasoning) {
    reasoning += appendedTextDelta(existing, pendingReasoning)
  }
  if (reasoning) {
    run.toolReasoning.set(callId, reasoning)
    run.toolBoundaryReasoning = reasoning
  }
  run.reasoningMessageId = undefined
  run.pendingReasoning = undefined
  return reasoning
}

/**
 * True when `finalText` (terminal `message` item of a Responses run) is already
 * covered by the assistant text segments this run streamed into state: it
 * equals the last text segment, equals the concatenation of all segments, or
 * the concatenation ends with it.
 */
function finalTextAlreadyStreamed(state: SessionState, runMarker: string | undefined, finalText: string): boolean {
  const segments = state.messages
    .filter(m => m.runMarker === runMarker && m.role === 'assistant' && !m.tool_calls?.length)
    .map(m => String(m.content || ''))
    .filter(Boolean)
  if (!segments.length) return false
  const target = finalText.trim()
  if (!target) return true
  if (segments[segments.length - 1].trim() === target) return true
  const joined = segments.join('').trim()
  return joined === target || joined.endsWith(target)
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === 'string') return output
  try {
    return JSON.stringify(output ?? '')
  } catch {
    return String(output ?? '')
  }
}

function errorFromValue(value: unknown): string | true | undefined {
  if (value === true) return true
  if (typeof value === 'string') return value || true
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (typeof record.message === 'string' && record.message) return record.message
  if (typeof record.error === 'string' && record.error) return record.error
  try {
    return JSON.stringify(record)
  } catch {
    return true
  }
}

function toolOutputError(item: any): string | true | undefined {
  const directError = errorFromValue(item?.error)
  if (directError) return directError

  const status = typeof item?.status === 'string' ? item.status.toLowerCase() : ''
  if (status === 'failed' || status === 'error' || status === 'errored') return true

  const output = item?.output
  if (typeof output === 'string') return output.startsWith('Error') ? true : undefined
  if (!output || typeof output !== 'object') return undefined

  const record = output as Record<string, unknown>
  const outputError = errorFromValue(record.error)
  if (outputError) return outputError
  if (record.is_error === true || record.ok === false) return true
  const outputStatus = typeof record.status === 'string' ? record.status.toLowerCase() : ''
  if (outputStatus === 'failed' || outputStatus === 'error' || outputStatus === 'errored') return true
  return undefined
}

// hermes-runtime-row-identity: runtime rows created while a Responses-based
// coding agent streams get a provisional NEGATIVE id (same contract as
// bridge-message.ts ensureOpenBridgeAssistantMessage). SQLite rowids are
// always positive, so a provisional id can never collide with a DB row that
// loadSessionStateFromDb already placed in state.messages. persistRunMessages
// rebinds the row to its persisted positive id on flush.
function isProvisionalRuntimeId(id: unknown): id is number {
  return typeof id === 'number' && Number.isFinite(id) && id < 0
}

function nextProvisionalRuntimeId(state: SessionState): number {
  let id = -(state.messages.length + 1)
  // A provisional row that failed to persist (or one left by another path)
  // may still hold this slot; never hand out an id that is already in state.
  while (state.messages.some(message => message.id === id)) id--
  return id
}

/** Merge a runtime row with the DB snapshot already held in session state. */
function appendRuntimeMessage(state: SessionState, message: any): any {
  const run = String(message.runMarker || message.run_marker || '').trim()
  const existing = state.messages.find((candidate: any) => {
    if (message.client_message_id && candidate.client_message_id === message.client_message_id) return true
    // Merge-by-id is only legal between two provisional runtime ids of the
    // same run. A DB row (positive id) must never absorb a runtime row just
    // because the runtime sequence number happens to equal its rowid, and a
    // stale provisional row left by another run must not be absorbed either.
    const candidateRun = String(candidate.runMarker || candidate.run_marker || '').trim()
    if (
      isProvisionalRuntimeId(message.id)
      && isProvisionalRuntimeId(candidate.id)
      && candidate.id === message.id
      && candidateRun === run
    ) return true
    if (!run || String(candidate.runMarker || candidate.run_marker || '') !== run) return false
    return message.role === 'tool'
      && candidate.role === 'tool'
      && !!message.tool_call_id
      && candidate.tool_call_id === message.tool_call_id
  })
  if (existing) {
    const stableId = existing.id
    Object.assign(existing, message)
    existing.id = stableId
    return existing
  }
  state.messages.push(message)
  return message
}

// hermes-coding-agent-identity: every assistant segment produced by a
// Responses-based coding agent (Claude Code / Codex / Pi) owns an am_
// client_message_id, exactly like Hermes bridge segments. The wire must never
// present the user's cm_ id as an assistant identity: the client would bind the
// first text segment to it and drop every later segment as a late duplicate.
function ensureAssistantSegmentIdentity(message: any): string {
  if (!message.client_message_id) message.client_message_id = `am_${randomUUID()}`
  return message.client_message_id
}

export function applyResponseStreamEvent(
  state: SessionState,
  sessionId: string,
  runMarker: string | undefined,
  eventType: string,
  parsed: any,
): { event: string; payload: any; runId?: string } | null {
  const run = getResponseRunState(state, runMarker)
  const now = () => Math.floor(Date.now() / 1000)

  if (eventType === 'response.created') {
    const response = parsed.response || parsed
    run.responseId = response.id || run.responseId
    return {
      event: 'run.started',
      runId: run.responseId,
      payload: {
        event: 'run.started',
        run_id: run.responseId,
        run_marker: runMarker,
        response_id: run.responseId,
        status: response.status || 'in_progress',
        queue_length: state.queue.length || 0,
      },
    }
  }

  if (eventType === 'response.output_text.delta') {
    const deltaText = parsed.delta || parsed.text || ''
    if (!deltaText) return null

    const last = [...state.messages].reverse().find(m => m.runMarker === runMarker)
    let segment: any
    if (last?.role === 'assistant' && last.finish_reason == null && !last.tool_calls?.length) {
      if (run.pendingReasoning) {
        appendReasoningToMessage(run, last, run.pendingReasoning)
        run.pendingReasoning = undefined
      }
      last.content += deltaText
      segment = last
    } else {
      const message = {
        id: nextProvisionalRuntimeId(state),
        session_id: sessionId,
        runMarker,
        client_message_id: `am_${randomUUID()}`,
        role: 'assistant',
        content: deltaText,
        timestamp: now(),
        reasoning: run.pendingReasoning || null,
        reasoning_content: run.pendingReasoning || null,
      }
      segment = appendRuntimeMessage(state, message)
      if (run.pendingReasoning) {
        run.reasoningMessageId = message.id
        run.pendingReasoning = undefined
      }
    }
    return {
      event: 'message.delta',
      payload: {
        event: 'message.delta',
        run_id: run.responseId,
        run_marker: runMarker,
        response_id: run.responseId,
        client_message_id: ensureAssistantSegmentIdentity(segment),
        delta: deltaText,
      },
    }
  }

  if (
    eventType === 'response.reasoning.delta' ||
    eventType === 'response.reasoning_text.delta' ||
    eventType === 'response.reasoning_summary_text.delta'
  ) {
    const deltaText = reasoningTextFromEvent(parsed)
    if (!deltaText) return null

    const existingTarget = run.reasoningMessageId != null
      ? state.messages.find(m => m.id === run.reasoningMessageId)
      : null
    const lastMessage = state.messages[state.messages.length - 1]
    const fallbackTarget =
      lastMessage?.runMarker === runMarker &&
      lastMessage.role === 'assistant' &&
      !lastMessage.tool_calls?.length
        ? lastMessage
        : null
    const target = existingTarget?.role === 'assistant' ? existingTarget : fallbackTarget
    let appendedDelta = ''
    if (target) {
      appendedDelta = appendReasoningToMessage(run, target, deltaText)
    } else {
      appendedDelta = appendedTextDelta(run.pendingReasoning || '', deltaText)
      if (appendedDelta) {
        run.pendingReasoning = `${run.pendingReasoning || ''}${appendedDelta}`
      }
    }
    if (!appendedDelta) return null
    const responseId = run.responseId || parsed?.response?.id || parsed?.id || parsed?.item_id
    return {
      event: 'reasoning.delta',
      runId: responseId,
      payload: {
        event: 'reasoning.delta',
        run_id: responseId,
        run_marker: runMarker,
        response_id: responseId,
        ...(target ? { client_message_id: ensureAssistantSegmentIdentity(target) } : {}),
        delta: appendedDelta,
      },
    }
  }

  if (eventType === 'response.output_text.done') {
    const last = [...state.messages].reverse().find(m => m.runMarker === runMarker)
    if (last?.role === 'assistant' && last.finish_reason == null) {
      last.finish_reason = 'stop'
    }
    return null
  }

  if (eventType === 'response.output_item.added') {
    const item = parsed.item || parsed.output_item || parsed
    if (item.type !== 'function_call') return null
    const callId = item.call_id || item.id
    if (!callId) return null
    captureToolBoundaryReasoning(state, run, callId)
    const toolCall = responseFunctionCallToToolCall(item)
    const existing = run.toolCalls.get(callId)
    const rawArguments = item.arguments ?? item.function?.arguments
    const hasCompleteArguments = rawArguments != null &&
      (typeof rawArguments !== 'string' || !['', '{}'].includes(rawArguments.trim()))
    const startedAt = existing?.startedAt ?? (hasCompleteArguments ? Date.now() : undefined)
    run.toolCalls.set(callId, {
      ...toolCall,
      ...(startedAt != null ? { startedAt } : {}),
    })
    if (!hasCompleteArguments || existing?.startedAt != null) return null
    return {
      event: 'tool.started',
      payload: {
        event: 'tool.started',
        run_id: run.responseId,
        run_marker: runMarker,
        response_id: run.responseId,
        tool_call_id: callId,
        tool: toolCall.function.name,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
        preview: summarizeToolArguments(toolCall.function.arguments),
      },
    }
  }

  if (eventType === 'response.function_call_arguments.delta') {
    const callId = parsed.call_id || parsed.item_id || parsed.id
    if (!callId) return null
    const existing = run.toolCalls.get(callId)
    if (!existing) return null
    const delta = typeof parsed.delta === 'string' ? parsed.delta : ''
    if (!delta) return null
    const rawPreviousArgs = typeof existing.function?.arguments === 'string' ? existing.function.arguments : ''
    const previousArgs = rawPreviousArgs === '{}' && /^[\[{]/.test(delta.trim()) ? '' : rawPreviousArgs
    const nextToolCall = {
      ...existing,
      function: {
        ...existing.function,
        arguments: `${previousArgs}${delta}`,
      },
    }
    run.toolCalls.set(callId, nextToolCall)
    return null
  }

  if (eventType === 'response.output_item.done') {
    const item = parsed.item || parsed.output_item || parsed
    if (item.type === 'function_call') {
      const callId = item.call_id || item.id
      if (!callId) return null
      const toolCall = responseFunctionCallToToolCall(item)
      const existing = run.toolCalls.get(callId)
      run.toolCalls.set(callId, { ...toolCall, startedAt: existing?.startedAt ?? Date.now() })
      const toolReasoning = captureToolBoundaryReasoning(state, run, callId)

      const key = `assistant:${callId}`
      let toolCallMessage: any
      if (!run.insertedKeys.has(key)) {
        run.insertedKeys.add(key)
        toolCallMessage = appendRuntimeMessage(state, {
          id: nextProvisionalRuntimeId(state),
          session_id: sessionId,
          runMarker,
          client_message_id: `am_${randomUUID()}`,
          role: 'assistant',
          content: '',
          tool_calls: [toolCall],
          finish_reason: 'tool_calls',
          reasoning: toolReasoning || null,
          reasoning_content: toolReasoning || null,
          timestamp: now(),
        })
      } else {
        toolCallMessage = state.messages.find(message =>
          message.runMarker === runMarker &&
          message.role === 'assistant' &&
          message.tool_calls?.some(tool => tool.id === callId),
        )
        if (toolCallMessage && toolReasoning) {
          toolCallMessage.reasoning = toolReasoning
          toolCallMessage.reasoning_content = toolReasoning
        }
      }
      if (existing?.startedAt != null) return null
      return {
        event: 'tool.started',
        payload: {
          event: 'tool.started',
          run_id: run.responseId,
          run_marker: runMarker,
          response_id: run.responseId,
          ...(toolCallMessage ? { assistant_client_message_id: ensureAssistantSegmentIdentity(toolCallMessage) } : {}),
          tool_call_id: callId,
          tool: toolCall.function.name,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
          preview: summarizeToolArguments(toolCall.function.arguments),
        },
      }
    }

    if (item.type === 'function_call_output') {
      const callId = item.call_id || item.id
      if (!callId) return null
      const key = `tool:${callId}`
      const output = stringifyToolOutput(item.output)
      const toolCallEntry = run.toolCalls.get(callId)
      const toolName = toolCallEntry?.function?.name || null
      const startedAt = toolCallEntry?.startedAt
      const duration = startedAt ? Math.round((Date.now() - startedAt) / 10) / 100 : undefined
      const error = toolOutputError(item)
      const eventName = error ? 'tool.failed' : 'tool.completed'
      if (!run.insertedKeys.has(key)) {
        run.insertedKeys.add(key)
        appendRuntimeMessage(state, {
          id: nextProvisionalRuntimeId(state),
          session_id: sessionId,
          runMarker,
          role: 'tool',
          content: output,
          tool_call_id: callId,
          tool_name: toolName,
          finish_reason: error ? 'error' : null,
          timestamp: now(),
        })
      }
      run.toolBoundaryReasoning = undefined
      return {
        event: eventName,
        payload: {
          event: eventName,
          run_id: run.responseId,
          run_marker: runMarker,
          response_id: run.responseId,
          tool_call_id: callId,
          tool: toolName,
          name: toolName,
          output,
          duration,
          error: error || undefined,
        },
      }
    }
  }

  if (eventType === 'response.completed') {
    const response = parsed.response || parsed
    run.responseId = response.id || run.responseId
    const output = Array.isArray(response.output) ? response.output : []
    for (const item of output) {
      if (item.type === 'message') {
        const finalText = textFromResponseMessageItem(item)
        if (!finalText) continue
        const last = [...state.messages].reverse().find(m => m.runMarker === runMarker)
        if (last?.role === 'assistant' && !last.tool_calls?.length) {
          if (run.pendingReasoning) {
            appendReasoningToMessage(run, last, run.pendingReasoning)
            run.pendingReasoning = undefined
          }
          if (!last.content) last.content = finalText
          last.finish_reason = last.finish_reason || 'stop'
        } else if (finalTextAlreadyStreamed(state, runMarker, finalText)) {
          // The turn ended on a tool boundary and the terminal `message` item
          // repeats text that earlier segments of this run already streamed
          // (run-manager aggregates every delta of the turn into it). Creating
          // a new segment here would persist the assistant text twice.
          continue
        } else {
          const message = {
            id: nextProvisionalRuntimeId(state),
            session_id: sessionId,
            runMarker,
            client_message_id: `am_${randomUUID()}`,
            role: 'assistant',
            content: finalText,
            finish_reason: 'stop',
            timestamp: now(),
            reasoning: run.pendingReasoning || null,
            reasoning_content: run.pendingReasoning || null,
          }
          appendRuntimeMessage(state, message)
          if (run.pendingReasoning) {
            run.reasoningMessageId = message.id
            run.pendingReasoning = undefined
          }
        }
      } else if (item.type === 'function_call') {
        applyResponseStreamEvent(state, sessionId, runMarker, 'response.output_item.added', { item })
        applyResponseStreamEvent(state, sessionId, runMarker, 'response.output_item.done', { item })
      } else if (item.type === 'function_call_output') {
        applyResponseStreamEvent(state, sessionId, runMarker, 'response.output_item.done', { item })
      } else if (isReasoningResponseItem(item)) {
        applyResponseStreamEvent(state, sessionId, runMarker, 'response.reasoning.delta', item)
      }
    }
  }

  return null
}

export function getResponseRunState(state: SessionState, runMarker?: string): ResponseRunState {
  if (!state.responseRun || state.responseRun.runMarker !== runMarker) {
    state.responseRun = {
      runMarker,
      insertedKeys: new Set<string>(),
      toolCalls: new Map<string, any>(),
      toolReasoning: new Map<string, string>(),
    }
  }
  return state.responseRun
}

/** Flush all non-user messages for this run to DB in order. */
export function flushResponseRunToDb(state: SessionState, sessionId: string): string | undefined {
  const run = state.responseRun
  if (!run?.runMarker) return undefined
  const messages = state.messages.filter(msg => msg.runMarker === run.runMarker && msg.role !== 'user')
  const previousIds = messages.map(message => message.id)
  const { ids } = persistRunMessages(state, {
    sessionId,
    runMarker: run.runMarker,
    messages,
  })
  let finalAssistantMessageId: string | undefined
  messages.forEach((msg, index) => {
    const persistedId = ids[index]
    if (persistedId != null) {
      const previousId = previousIds[index]
      if (run.reasoningMessageId === previousId) run.reasoningMessageId = persistedId
      if (msg.role === 'assistant' && String(msg.content || '').trim()) {
        finalAssistantMessageId = String(persistedId)
      }
    }
  })
  logger.info('[chat-run-socket] flushResponseRunToDb: flushed %d messages for session %s', messages.length, sessionId)
  return finalAssistantMessageId
}
