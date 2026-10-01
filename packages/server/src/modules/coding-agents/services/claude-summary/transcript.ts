import type { ChatMessage } from '../../../studio/contracts/runs/messages'

/**
 * hermes-v051:A one record of a Claude native transcript as sent by bin/claude-context
 * (summaryRecords): role, native message id and native content (string or Anthropic blocks).
 */
export interface ClaudeSummaryRecord {
  role: string
  id?: string | null
  content: unknown
}

type Block = Record<string, any>
type ToolCall = NonNullable<ChatMessage['tool_calls']>[number]
const MEDIA = new Set(['image', 'document', 'audio', 'video'])

const blocksOf = (content: unknown): Block[] => Array.isArray(content)
  ? content.filter((block): block is Block => !!block && typeof block === 'object')
  : typeof content === 'string' ? [{ type: 'text', text: content }] : []
const textOf = (block: Block): string => typeof block.text === 'string' ? block.text : ''

function toolResultText(block: Block): string {
  const body = typeof block.content === 'string'
    ? block.content
    : blocksOf(block.content).map(part => part.type === 'text' ? textOf(part) : `[${String(part.type || 'content')}]`).join('\n')
  return block.is_error === true ? `[tool error] ${body}` : body
}

/**
 * Claude native records → WebUI ChatMessage for the shared summarizer. Rows of one API message
 * (same message.id) merge; tool_use becomes tool_calls; tool_result becomes a role=tool message
 * named after its call; thinking is dropped; images/documents become placeholders.
 */
export function claudeRecordsToChatMessages(records: readonly ClaudeSummaryRecord[]): ChatMessage[] {
  const out: ChatMessage[] = []
  const toolNames = new Map<string, string>()
  // Native id of the assistant message currently last in `out`: the only merge target.
  let openId: string | null = null
  for (const record of records) {
    const blocks = blocksOf(record?.content)
    if (record?.role === 'assistant') {
      const id = typeof record.id === 'string' && record.id ? record.id : null
      const text = blocks.filter(block => block.type === 'text').map(textOf).filter(Boolean).join('\n')
      const calls: ToolCall[] = blocks.filter(block => block.type === 'tool_use' && typeof block.id === 'string').map(block => {
        const name = typeof block.name === 'string' && block.name ? block.name : 'unknown'
        toolNames.set(block.id, name)
        return { id: block.id, type: 'function', function: { name, arguments: JSON.stringify(block.input ?? {}) } }
      })
      const last = out.at(-1)
      if (id && id === openId && last?.role === 'assistant') {
        if (text) last.content = last.content ? `${last.content as string}\n${text}` : text
        if (calls.length) last.tool_calls = [...(last.tool_calls || []), ...calls]
      } else if (text || calls.length) {
        out.push({ role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls } : {}) })
        openId = id
      }
      continue
    }
    if (record?.role !== 'user') continue
    openId = null
    const texts: string[] = []
    for (const block of blocks) {
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        out.push({ role: 'tool', tool_call_id: block.tool_use_id, name: toolNames.get(block.tool_use_id) || 'unknown', content: toolResultText(block) })
      } else if (block.type === 'text' && textOf(block).trim()) texts.push(textOf(block))
      else if (MEDIA.has(block.type)) texts.push(`[${block.type} attached]`)
    }
    if (texts.length) out.push({ role: 'user', content: texts.join('\n') })
  }
  return out
}
