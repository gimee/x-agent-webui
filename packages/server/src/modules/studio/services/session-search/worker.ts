/**
 * hermes-v050:S9: session search worker entry (bundled to
 * dist/server/session-search-worker.js by scripts/build-server.mjs).
 *
 * Opens its own read-only connection to the Web UI database. In WAL mode a
 * reader never blocks the main thread's writer, so the multi-hundred-ms LIKE
 * scan no longer freezes streaming output, sockets or other requests.
 */
import { parentPort, threadId, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { searchSessionsInDb } from '../../repositories/session-store'
import type { SessionSearchWorkerJob, SessionSearchWorkerMessage } from './protocol'

const port = parentPort
if (!port) throw new Error('session-search worker must run inside worker_threads')

function post(message: SessionSearchWorkerMessage): void {
  port!.postMessage(message)
}

let db: DatabaseSync | null = null
try {
  const dbPath = String((workerData as { dbPath?: unknown } | null)?.dbPath || '')
  if (!dbPath) throw new Error('session-search worker started without a database path')
  db = new DatabaseSync(dbPath, { readOnly: true })
  db.exec('PRAGMA busy_timeout=5000')
  db.exec('PRAGMA query_only=1')
  // Reads go through the memory map, so a small page cache is enough here.
  db.exec('PRAGMA cache_size=-16384')
  db.exec('PRAGMA mmap_size=268435456')
  // Fail at startup (not on the first search) when the schema is missing.
  db.prepare('SELECT 1 FROM sessions LIMIT 1').get()
  post({ type: 'ready', threadId })
} catch (error) {
  try { db?.close() } catch { /* already failing */ }
  db = null
  post({ type: 'fatal', error: error instanceof Error ? error.message : String(error) })
}

port.on('message', (job: SessionSearchWorkerJob) => {
  if (!db) return
  const started = performance.now()
  try {
    const rows = searchSessionsInDb(db, job.args.profile, job.args.query, job.args.limit, job.args.options)
    post({ type: 'result', id: job.id, ok: true, rows, threadId, elapsedMs: performance.now() - started })
  } catch (error) {
    post({
      type: 'result',
      id: job.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      threadId,
      elapsedMs: performance.now() - started,
    })
  }
})
