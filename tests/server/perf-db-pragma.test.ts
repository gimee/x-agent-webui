import { mkdtempSync, rmSync } from 'fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { applyProductionPragmas } from '../../packages/server/src/modules/studio/infrastructure/database/index'

describe('production SQLite pragmas', () => {
  it('raises the page cache and enables mmap for the WAL database', () => {
    // mmap_size is only reported for file-backed databases, so use a temp file.
    const dir = mkdtempSync(join(tmpdir(), 'perf-db-pragma-'))
    const db = new DatabaseSync(join(dir, 'pragma.db'))
    try {
      db.exec('PRAGMA journal_mode=WAL')
      applyProductionPragmas(db)
      expect((db.prepare('PRAGMA cache_size').get() as any).cache_size).toBe(-65536)
      expect((db.prepare('PRAGMA mmap_size').get() as any).mmap_size).toBe(268435456)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
