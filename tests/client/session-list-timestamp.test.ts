import { describe, expect, it } from 'vitest'
import { formatSessionListTimestamp } from '@/shared/session-display'

describe('session list timestamp', () => {
  it.each([
    [new Date(2026, 8, 3, 13, 55).getTime(), '09-03 13:55'],
    [new Date(2026, 0, 1, 0, 5).getTime(), '01-01 00:05'],
    [new Date(2025, 11, 31, 23, 59).getTime(), '12-31 23:59'],
    [new Date(2024, 1, 29, 8, 9).getTime(), '02-29 08:09'],
  ])('formats local month/day and 24-hour time: %s', (timestamp, expected) => {
    expect(formatSessionListTimestamp(timestamp)).toBe(expected)
  })
  it.each([0, NaN, Infinity, -Infinity, 9e20])('keeps absent/invalid timestamps empty: %s', timestamp => {
    expect(formatSessionListTimestamp(timestamp)).toBe('')
  })
})
