/**
 * Bridge message management — flush pending content to DB,
 * track tool calls, manage assistant message lifecycle.
 */

import { randomUUID } from 'node:crypto'
import { logger } from '../../public/logging'
import { persistRunMessages } from './message-persistence'
import type { SessionMessage, SessionState } from './types'

export function flushBridgePendingToDb(state: SessionState, sessionId: string, runMarker?: string, includeReasoningOnly = true): string | undefined {
  const content = state.bridgePendingAssistantContent || ''
  const reasoning = state.bridgePendingReasoningContent || ''
  if (!content.trim() && (!includeReasoningOnly || !reasoning.trim())) return state.bridgeAssistantMessageId
  const effectiveRunMarker = runMarker || state.activeRunMarker
  const assistantMessage = ensureOpenBridgeAssistantMessage(state, sessionId, effectiveRunMarker)
  assistantMessage.content = content
  syncBridgeReasoningToMessage(assistantMessage, reasoning)
  // Seal before persistence: subsequent tool metadata must belong to a fresh
  // row, not be discarded by the client_message_id insert-only conflict guard.
  assistantMessage.finish_reason = 'stop'
  const { ids: [persistedId] } = persistRunMessages(state, {
    sessionId,
    runMarker: effectiveRunMarker,
    messages: [assistantMessage],
  })
  state.bridgePendingAssistantContent = ''
  state.bridgePendingReasoningContent = ''
  if (persistedId != null) {
    state.bridgeAssistantMessageId = String(persistedId)
    assistantMessage.id = persistedId
  }
  return state.bridgeAssistantMessageId
}

export function findOpenBridgeAssistantMessage(state: SessionState, runMarker: string): SessionMessage | undefined {
  return [...state.messages]
    .reverse()
    .find(m => m.runMarker === runMarker && m.role === 'assistant' && m.finish_reason == null)
}

export function ensureOpenBridgeAssistantMessage(
  state: SessionState,
  sessionId: string,
  runMarker?: string,
): SessionMessage {
  const existing = runMarker ? findOpenBridgeAssistantMessage(state, runMarker) : undefined
  if (existing) {
    existing.client_message_id ||= `am_${randomUUID()}`
    state.bridgeAssistantClientMessageId = existing.client_message_id
    return existing
  }
  state.bridgeAssistantMessageId = undefined
  const message: SessionMessage = {
    // Provisional IDs must never collide with positive SQLite rowids on resume.
    id: -(state.messages.length + 1),
    session_id: sessionId,
    runMarker,
    client_message_id: `am_${randomUUID()}`,
    role: 'assistant',
    content: '',
    timestamp: Math.floor(Date.now() / 1000),
  }
  state.messages.push(message)
  state.bridgeAssistantClientMessageId = message.client_message_id!
  return message
}

export function syncBridgeReasoningToMessage(message: SessionMessage, reasoning?: string) {
  if (!reasoning) return
  message.reasoning = reasoning
  message.reasoning_content = reasoning
}

export function recordBridgeToolStarted(
  state: SessionState,
  sessionId: string,
  runMarker: string,
  toolName: string,
  args: Record<string, unknown> | undefined,
  rawToolCallId: unknown,
): { id: string; name: string; arguments: string; assistantClientMessageId: string; assistantMessageId?: number } {
  const id = bridgeToolCallId(state, rawToolCallId, toolName)
  const argsString = args ? JSON.stringify(args) : '{}'
  const reasoning = state.bridgePendingReasoningContent || ''
  const toolCall = {
    id,
    type: 'function',
    function: {
      name: toolName,
      arguments: argsString,
    },
  }
  const timestamp = Math.floor(Date.now() / 1000)

  state.bridgePendingTools = state.bridgePendingTools || []
  state.bridgePendingTools.push({
    id,
    name: toolName,
    arguments: argsString,
    startedAt: Date.now(),
  })

  const openMessage = ensureOpenBridgeAssistantMessage(state, sessionId, runMarker)
  let message: SessionMessage
  if (openMessage && !openMessage.content && !openMessage.tool_calls?.length) {
    openMessage.tool_calls = [toolCall]
    openMessage.finish_reason = 'tool_calls'
    openMessage.reasoning = reasoning || openMessage.reasoning || null
    openMessage.reasoning_content = reasoning || openMessage.reasoning_content || null
    openMessage.timestamp = timestamp
    message = openMessage
  } else {
    message = {
      id: state.messages.length + 1,
      session_id: sessionId,
      runMarker,
      client_message_id: `am_${randomUUID()}`,
      role: 'assistant',
      content: '',
      tool_calls: [toolCall],
      finish_reason: 'tool_calls',
      reasoning: reasoning || null,
      reasoning_content: reasoning || null,
      timestamp,
    }
    state.messages.push(message)
  }
  const { ids: [persistedId] } = persistRunMessages(state, {
    sessionId,
    runMarker,
    messages: [message],
  })
  state.bridgePendingReasoningContent = ''
  state.bridgeAssistantClientMessageId = message.client_message_id!
  state.bridgeAssistantMessageId = persistedId == null ? undefined : String(persistedId)

  return { id, name: toolName, arguments: argsString, assistantClientMessageId: message.client_message_id!, assistantMessageId: persistedId }
}

export function recordBridgeToolCompleted(
  state: SessionState,
  sessionId: string,
  runMarker: string,
  toolName: string,
  ev: Record<string, unknown>,
): { id: string; output: string; duration?: number; messageId?: number | string } {
  state.bridgePendingTools = state.bridgePendingTools || []
  const rawId = ev.tool_call_id
  let idx = rawId
    ? state.bridgePendingTools.findIndex(tool => tool.id === String(rawId))
    : -1
  if (idx < 0 && toolName) {
    idx = state.bridgePendingTools.findIndex(tool => tool.name === toolName)
  }
  if (idx < 0) {
    idx = state.bridgePendingTools.length - 1
  }
  const pending = idx >= 0 ? state.bridgePendingTools.splice(idx, 1)[0] : undefined
  const id = pending?.id || bridgeToolCallId(state, rawId, toolName)
  const output = bridgeToolOutput(ev)
  const timestamp = Math.floor(Date.now() / 1000)
  logger.info(
    '[chat-run-socket][bridge] recording CLI tool result session=%s tool=%s tool_call_id=%s raw_tool_call_id=%s output_len=%d has_result=%s has_output=%s has_result_preview=%s has_preview=%s event_keys=%s',
    sessionId,
    toolName,
    id,
    String(rawId || ''),
    output.length,
    String(ev.result != null),
    String(ev.output != null),
    String(ev.result_preview != null),
    String(ev.preview != null),
    Object.keys(ev).join(','),
  )

  const { ids: [persistedId], messages: [message] } = persistRunMessages(state, {
    sessionId,
    runMarker,
    appendToState: true,
    messages: [{
      role: 'tool',
      content: output,
      tool_call_id: id,
      tool_name: toolName || pending?.name || null,
      timestamp,
    }],
  })

  const duration = pending?.startedAt
    ? Math.round((Date.now() - pending.startedAt) / 10) / 100
    : undefined

  return { id, output, duration, messageId: persistedId ?? message.id }
}

export function recordBridgeMoaDisplayTool(
  state: SessionState,
  sessionId: string,
  runMarker: string,
  toolName: 'moa_reference' | 'moa_aggregating',
  toolCallId: string,
  content: string,
) {
  const timestamp = Math.floor(Date.now() / 1000)
  persistRunMessages(state, {
    sessionId,
    runMarker,
    appendToState: true,
    messages: [{
      role: 'moa',
      content,
      display_role: 'tool',
      tool_call_id: toolCallId,
      tool_name: toolName,
      timestamp,
    }],
  })
}

export function bridgeToolCallId(state: SessionState, rawToolCallId: unknown, toolName: string): string {
  const raw = String(rawToolCallId || '').trim()
  if (raw) return raw
  state.bridgeToolCounter = (state.bridgeToolCounter || 0) + 1
  const safeName = (toolName || 'tool').replace(/[^a-zA-Z0-9_-]/g, '_')
  return `cli_${safeName}_${state.bridgeToolCounter}`
}

export function bridgeToolOutput(ev: Record<string, unknown>): string {
  const value = ev.result ?? ev.output ?? ev.result_preview ?? ev.preview ?? ''
  return typeof value === 'string' ? value : JSON.stringify(value ?? '')
}
