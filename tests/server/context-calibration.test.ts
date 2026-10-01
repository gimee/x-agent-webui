import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const latest = vi.fn<(sessionId: string) => number | null>()
vi.mock('../../packages/server/src/modules/studio/repositories/usage-store', () => ({
  getLatestModelCallContextTokens: (sessionId: string) => latest(sessionId),
}))

const { calibrateContextTokens, updateContextCalibration, resetContextCalibrationForTests } = await import('../../packages/server/src/modules/studio/services/chat-run/context-calibration')

describe('hermes context calibration', () => {
  beforeEach(() => { resetContextCalibrationForTests(); latest.mockReset() })

  it('seeds from the latest real model call after a restart (observed 403K local vs 500K real)', () => {
    latest.mockReturnValue(500_000)
    const out = calibrateContextTokens('s', 404_000, 1_000)
    expect(out.ratio).toBeCloseTo(500_000 / 403_000, 5)
    expect(out.tokens).toBeGreaterThan(409_600)
  })

  it('leaves estimates unchanged without real usage and never lowers them', () => {
    latest.mockReturnValue(null)
    expect(calibrateContextTokens('none', 300_000)).toEqual({ tokens: 300_000, ratio: 1 })
    latest.mockReturnValue(250_000)
    expect(calibrateContextTokens('lower', 300_000).ratio).toBe(1)
  })

  it('ignores a real reading that predates a history change instead of forcing repeated compression', () => {
    latest.mockReturnValue(500_000)
    expect(calibrateContextTokens('compressed', 100_000)).toEqual({ tokens: 100_000, ratio: 1 })
    latest.mockReturnValue(5_000)
    expect(calibrateContextTokens('tiny', 2_000).ratio).toBe(1)
  })

  it('updates the ratio from each run final estimate and applies it to the next decision', () => {
    latest.mockReturnValue(null)
    expect(calibrateContextTokens('s2', 200_000).ratio).toBe(1)
    latest.mockReturnValue(260_000)
    updateContextCalibration('s2', 200_000)
    expect(calibrateContextTokens('s2', 210_000)).toEqual({ tokens: 273_000, ratio: 1.3 })
    latest.mockReturnValue(900_000)
    updateContextCalibration('s2', 210_000)
    expect(calibrateContextTokens('s2', 210_000).ratio).toBe(1.3)
  })

  it('is wired into the pre-run compression estimate, the final estimate and the bridge warning', () => {
    const run = readFileSync('packages/server/src/modules/studio/services/chat-run/handle-bridge-run.ts', 'utf8')
    expect(run).toContain('calibrateContextTokens(session_id, localContextTokens, currentInputTokens)')
    expect(run).toContain('updateContextCalibration(args.sessionId, contextTokens)')
    const pool = readFileSync('packages/server/src/modules/hermes/services/bridge/python/bridge_pool.py', 'utf8')
    expect(pool).toMatch(/agent\.compression_enabled = False\n(?:\s*#.*\n)*\s*agent\._warn_uncompressed_context_overflow = lambda/)
  })
})
