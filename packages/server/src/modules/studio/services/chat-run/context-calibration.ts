import { getLatestModelCallContextTokens } from '../../repositories/usage-store'

// hermes-context-calibration: the local character-based estimate can undercount
// the provider's real prompt (observed 403K local vs 500K real for a Chinese,
// tool-heavy session), so compression triggered only after the real context had
// already reached the model limit. Scale local estimates by the session's
// observed real/local ratio. The ratio only ever raises estimates (1-2x); a raw
// ratio outside 0.5-2 means the real reading predates a history change (e.g. a
// compression) and is ignored rather than trusted.
const MIN_REAL_TOKENS = 10_000
const ratios = new Map<string, number>()

function observedRatio(sessionId: string, localTokens: number): number | null {
  const real = getLatestModelCallContextTokens(sessionId)
  if (real == null || real < MIN_REAL_TOKENS || !(localTokens > 0)) return null
  const raw = real / localTokens
  if (raw < 0.5 || raw > 2) return null
  return Math.max(1, raw)
}

/** Call after a run with the final local estimate of the same history the last model call saw. */
export function updateContextCalibration(sessionId: string, finalLocalTokens: number | undefined): void {
  if (typeof finalLocalTokens !== 'number') return
  const ratio = observedRatio(sessionId, finalLocalTokens)
  if (ratio != null) ratios.set(sessionId, ratio)
}

/**
 * Calibrated context tokens for a compression decision. After a restart the
 * ratio is seeded from the latest stored real usage against the history before
 * the current input (localTokens minus currentInputTokens).
 */
export function calibrateContextTokens(sessionId: string, localTokens: number, currentInputTokens = 0): { tokens: number; ratio: number } {
  let ratio = ratios.get(sessionId)
  if (ratio == null) {
    ratio = observedRatio(sessionId, Math.max(1, localTokens - Math.max(0, currentInputTokens))) ?? 1
    ratios.set(sessionId, ratio)
  }
  return { tokens: Math.ceil(localTokens * ratio), ratio }
}

export function resetContextCalibrationForTests(): void {
  ratios.clear()
}
