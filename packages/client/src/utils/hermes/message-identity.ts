export interface MessageIdentityLike {
  id?: string | number | null
  clientMessageId?: string | null
  client_message_id?: string | null
  optimisticQueueId?: string | null
}

export function normalizeClientMessageId(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const normalized = String(value).trim()
  return normalized || null
}

export function clientMessageIdOf(value: MessageIdentityLike | null | undefined): string | null {
  return normalizeClientMessageId(value?.clientMessageId ?? value?.client_message_id)
}

export function messageIdOf(value: MessageIdentityLike | null | undefined): string | null {
  return normalizeClientMessageId(value?.id)
}

/**
 * Match a local message with a peer/server representation without using text.
 * The client id is preferred; server ids and optimistic queue ids are only
 * fallback transport identities and never become the client id themselves.
 */
export function sameMessageIdentity(
  left: MessageIdentityLike | null | undefined,
  right: MessageIdentityLike | null | undefined,
): boolean {
  const leftClientId = clientMessageIdOf(left)
  const rightClientId = clientMessageIdOf(right)
  if (leftClientId && rightClientId) return leftClientId === rightClientId

  const rightId = messageIdOf(right)
  if (!rightId) return false
  return messageIdOf(left) === rightId || normalizeClientMessageId(left?.optimisticQueueId) === rightId
}
