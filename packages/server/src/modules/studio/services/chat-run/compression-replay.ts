/**
 * hermes-v051:B2 compression events in the resume replay.
 *
 * A finished compression row is shown for 5 seconds live. The replay list of a
 * working session is resent on every session switch, tab return and reconnect,
 * so a compression at the start of a long turn kept coming back for the whole
 * turn. Five seconds after a compression completes (or fails) its
 * started/completed entries leave the replay list; one that starts later keeps
 * its own entries until it completes.
 */

import type { SessionState } from '../../contracts/runs/session'

export const COMPRESSION_REPLAY_CLEAR_MS = 5_000

const COMPRESSION_REPLAY_EVENTS = new Set(['compression.started', 'compression.completed'])

export function scheduleCompressionReplayClear(state: Pick<SessionState, 'events'> | null | undefined): void {
  if (!state) return
  const finished = new Set(state.events.filter(entry => COMPRESSION_REPLAY_EVENTS.has(entry?.event)))
  if (!finished.size) return
  const timer = setTimeout(() => {
    for (let index = state.events.length - 1; index >= 0; index--) {
      if (finished.has(state.events[index])) state.events.splice(index, 1)
    }
  }, COMPRESSION_REPLAY_CLEAR_MS)
  timer.unref?.()
}
