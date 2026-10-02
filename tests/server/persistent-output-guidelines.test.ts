import { describe, expect, it } from 'vitest'
import { AI_OUTPUT_FORMAT_GUIDELINES, AI_OUTPUT_FORMAT_GUIDELINES_EN } from '../../packages/server/src/modules/studio/public/runs/prompt'
describe('persistent generated-file delivery', () => {
  for (const [locale, text] of [['zh', AI_OUTPUT_FORMAT_GUIDELINES], ['en', AI_OUTPUT_FORMAT_GUIDELINES_EN]]) {
    it(`${locale} keeps deliverables under the active profile rather than ephemeral tmp examples`, () => {
      expect(text).toContain('$HERMES_HOME/workspace')
      expect(text).not.toMatch(/\]\(\/tmp\//)
      expect(text).toContain('persistent/workspace')
    })
  }
})
