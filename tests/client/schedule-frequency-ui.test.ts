// @vitest-environment node

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('scheduled task frequency-first UI', () => {
  it('lets Jobs choose common frequencies before exposing a custom expression', () => {
    const source = readFileSync('packages/client/src/components/hermes/jobs/JobFormModal.vue', 'utf8')

    expect(source).toContain("value: 'every-30-minutes'")
    expect(source).toContain('data-testid="job-schedule-frequency"')
    expect(source).toContain('data-testid="job-schedule-weekday"')
    expect(source).toContain('data-testid="job-schedule-month-day"')
    expect(source).toContain("scheduleFrequency === 'custom'")
  })

})
