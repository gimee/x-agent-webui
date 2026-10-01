/** hermes-v050:S9: messages between the session-search pool and its worker. */
import type { HermesSessionSearchRow, SessionSearchOptions } from '../../repositories/session-store'

export interface SessionSearchArgs {
  profile: string | null | undefined
  query: string
  limit?: number
  options: SessionSearchOptions
}

export interface SessionSearchWorkerJob {
  id: number
  args: SessionSearchArgs
}

export type SessionSearchWorkerMessage =
  | { type: 'ready'; threadId: number }
  | { type: 'fatal'; error: string }
  | {
    type: 'result'
    id: number
    ok: boolean
    rows?: HermesSessionSearchRow[]
    error?: string
    threadId: number
    elapsedMs: number
  }
