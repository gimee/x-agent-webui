/**
 * Unified initializer for all Hermes SQLite stores.
 * Call this once at bootstrap to create/migrate all tables.
 *
 * All table schemas, creation, and migration logic are now centralized
 * in schemas.ts to avoid duplication and ensure consistency.
 */

import { initAllHermesTables } from './schemas'
import { backfillSessionPreviews } from '../../repositories/session-store'

export function initAllStores(): void {
  // Initialize all tables with centralized schema definitions and migrations
  initAllHermesTables()
  // One-off data migration: persist sessions.preview so the session list no
  // longer runs a correlated sub-select per row (see session-store.ts).
  try {
    const result = backfillSessionPreviews()
    if (result.updated > 0 || result.elapsedMs > 100) {
      console.log(`[bootstrap] backfilled ${result.updated}/${result.scanned} session preview(s) in ${result.elapsedMs}ms`)
    }
  } catch (err) {
    console.warn('[bootstrap] session preview backfill failed (non-fatal):', err)
  }
}
