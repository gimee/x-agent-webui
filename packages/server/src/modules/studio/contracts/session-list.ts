/**
 * hermes-v050:S6: `GET /api/studio/sessions?fields=lite`.
 *
 * The columns the Web UI chat store reads from a session-list row
 * (packages/client/src/stores/hermes/chat.ts: mapHermesSession and
 * sessionActivitySeconds). The default response is unchanged and keeps every
 * column for the App, the MCP server and released clients on the legacy alias.
 */
export const SESSION_LIST_LITE_FIELDS = [
  'id',
  'profile',
  'source',
  'agent',
  'agent_mode',
  'agent_session_id',
  'agent_native_session_id',
  'model',
  'provider',
  'billing_provider',
  'api_mode',
  'reasoning_effort',
  'title',
  'parent_session_id',
  'fork_point_message_id',
  'parent_title',
  'parent_last_message',
  'parent_last_message_role',
  'started_at',
  'ended_at',
  'last_active',
  'message_count',
  'input_tokens',
  'output_tokens',
  'is_archived',
  'push_enabled',
  'workspace',
] as const

export type SessionListLiteField = typeof SESSION_LIST_LITE_FIELDS[number]

export function toSessionListLiteRow<T extends object>(row: T): Partial<Pick<T, Extract<SessionListLiteField, keyof T>>> {
  const source = row as Record<string, unknown>
  const lite: Record<string, unknown> = {}
  for (const field of SESSION_LIST_LITE_FIELDS) {
    if (field in source) lite[field] = source[field]
  }
  return lite as Partial<Pick<T, Extract<SessionListLiteField, keyof T>>>
}
