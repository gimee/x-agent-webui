/**
 * hermes-v050:S9: run session search off the main thread.
 *
 * The search is a synchronous LIKE scan over ~300MB of message bodies
 * (0.2–0.6s after S3). On the main thread it froze the whole process: socket
 * streaming, other requests and /livez. The pool keeps one worker_thread with
 * its own read-only connection (WAL: readers never block the writer) and
 * serves searches one at a time from a queue.
 *
 * - No worker bundle next to this module (TS sources, dev, tests), a
 *   non-file or non-WAL database, or HERMES_WEB_UI_SESSION_SEARCH_WORKER=0:
 *   searches run on the main thread exactly as before.
 * - The worker fails to start (missing script, cannot open the database):
 *   queued and following searches fall back to the main thread; the worker is
 *   retried after `retryAfterMs`.
 * - A request aborted while queued never reaches the worker; one aborted while
 *   running is answered immediately and its result discarded.
 * - A search still unanswered after `timeoutMs` rejects with
 *   SESSION_SEARCH_TIMEOUT; a stuck worker is terminated and replaced.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { getDb, getStoragePath, isSqliteAvailable } from '../../infrastructure/database'
import { searchSessions, type HermesSessionSearchRow, type SessionSearchOptions } from '../../repositories/session-store'
import { logger } from '../../public/logging'
import type { SessionSearchArgs, SessionSearchWorkerJob, SessionSearchWorkerMessage } from './protocol'

export type { SessionSearchArgs } from './protocol'

export const SESSION_SEARCH_WORKER_FILE = 'session-search-worker.js'
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_RETRY_AFTER_MS = 60_000
const DEFAULT_IDLE_MS = 5 * 60_000

export interface SessionSearchRun {
  rows: HermesSessionSearchRow[]
  via: 'worker' | 'main'
  threadId: number
  elapsedMs: number
}

export interface SessionSearchWorkerPoolOptions {
  /** Worker script; null disables the worker. */
  scriptPath: string | null
  /** Database file the worker opens read-only; null disables the worker. */
  dbPath: string | null
  /** Main-thread search used when the worker is unavailable. */
  fallback: (
    profile: string | null | undefined,
    query: string,
    limit?: number,
    options?: SessionSearchOptions,
  ) => HermesSessionSearchRow[]
  timeoutMs?: number
  retryAfterMs?: number
  idleMs?: number
}

export interface SessionSearchCallOptions {
  signal?: AbortSignal
}

class SessionSearchError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'SessionSearchError'
  }
}

function abortError(): Error {
  const error = new Error('Session search was aborted')
  error.name = 'AbortError'
  return error
}

export function isSessionSearchTimeout(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'SESSION_SEARCH_TIMEOUT'
}

export function isSessionSearchAbort(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'AbortError'
}

interface PendingJob {
  id: number
  args: SessionSearchArgs
  signal?: AbortSignal
  onAbort?: () => void
  deadline?: ReturnType<typeof setTimeout>
  settled: boolean
  resolve: (run: SessionSearchRun) => void
  reject: (error: unknown) => void
}

export class SessionSearchWorkerPool {
  private worker: Worker | null = null
  private ready = false
  private queue: PendingJob[] = []
  private active: PendingJob | null = null
  private nextId = 1
  private failedUntil = 0
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private readonly counters = { executed: 0, fallback: 0, startupFailures: 0, terminated: 0, crashed: 0 }

  constructor(private readonly config: SessionSearchWorkerPoolOptions) {}

  stats() {
    return { ...this.counters, queued: this.queue.length, active: this.active ? 1 : 0 }
  }

  async search(args: SessionSearchArgs, call: SessionSearchCallOptions = {}): Promise<HermesSessionSearchRow[]> {
    return (await this.searchDetailed(args, call)).rows
  }

  searchDetailed(args: SessionSearchArgs, call: SessionSearchCallOptions = {}): Promise<SessionSearchRun> {
    if (call.signal?.aborted) return Promise.reject(abortError())
    if (!this.workerAvailable()) return this.runOnMainThread(args)
    return new Promise<SessionSearchRun>((resolvePromise, rejectPromise) => {
      const job: PendingJob = {
        id: this.nextId++,
        args,
        signal: call.signal,
        settled: false,
        resolve: resolvePromise,
        reject: rejectPromise,
      }
      job.deadline = setTimeout(() => this.timeoutJob(job), this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      job.deadline.unref?.()
      if (job.signal) {
        job.onAbort = () => this.abortJob(job)
        job.signal.addEventListener('abort', job.onAbort, { once: true })
      }
      this.queue.push(job)
      this.clearIdleTimer()
      this.pump()
    })
  }

  async close(): Promise<void> {
    this.closed = true
    this.clearIdleTimer()
    const pending = [...this.queue.splice(0), ...(this.active ? [this.active] : [])]
    this.active = null
    for (const job of pending) this.settle(job, new SessionSearchError('SESSION_SEARCH_CLOSED', 'Session search pool closed'))
    const worker = this.worker
    this.worker = null
    this.ready = false
    if (worker) await worker.terminate().catch(() => undefined)
  }

  private workerAvailable(): boolean {
    return !this.closed
      && Boolean(this.config.scriptPath && this.config.dbPath)
      && Date.now() >= this.failedUntil
  }

  private runOnMainThread(args: SessionSearchArgs): Promise<SessionSearchRun> {
    this.counters.fallback += 1
    const started = performance.now()
    try {
      const rows = this.config.fallback(args.profile, args.query, args.limit, args.options)
      return Promise.resolve({ rows, via: 'main', threadId: 0, elapsedMs: performance.now() - started })
    } catch (error) {
      return Promise.reject(error)
    }
  }

  private pump(): void {
    if (this.closed || this.active) return
    while (this.queue.length > 0 && this.queue[0].settled) this.queue.shift()
    if (this.queue.length === 0) {
      this.scheduleIdle()
      return
    }
    if (!this.worker) this.startWorker()
    const worker = this.worker
    if (!worker || !this.ready) return
    const job = this.queue.shift()!
    this.active = job
    worker.ref()
    worker.postMessage({ id: job.id, args: job.args } satisfies SessionSearchWorkerJob)
  }

  private startWorker(): void {
    let worker: Worker
    try {
      worker = new Worker(this.config.scriptPath!, { workerData: { dbPath: this.config.dbPath } })
    } catch (error) {
      this.handleStartupFailure(error)
      return
    }
    this.worker = worker
    this.ready = false
    worker.on('message', (message: SessionSearchWorkerMessage) => this.handleMessage(worker, message))
    worker.on('error', (error: unknown) => this.handleWorkerGone(worker, error))
    worker.on('exit', (code: number) => this.handleWorkerGone(worker, new Error(`session search worker exited with code ${code}`)))
  }

  private handleMessage(worker: Worker, message: SessionSearchWorkerMessage): void {
    if (worker !== this.worker) return
    if (message.type === 'ready') {
      this.ready = true
      this.pump()
      return
    }
    if (message.type === 'fatal') {
      this.handleStartupFailure(new Error(message.error))
      return
    }
    const job = this.active
    if (!job || job.id !== message.id) return
    this.active = null
    this.counters.executed += 1
    if (message.ok) {
      this.settle(job, null, {
        rows: message.rows ?? [],
        via: 'worker',
        threadId: message.threadId,
        elapsedMs: message.elapsedMs,
      })
    } else {
      this.settle(job, new SessionSearchError('SESSION_SEARCH_FAILED', message.error || 'Session search failed'))
    }
    this.pump()
  }

  private handleWorkerGone(worker: Worker, error: unknown): void {
    if (worker !== this.worker) return
    if (!this.ready) {
      this.handleStartupFailure(error)
      return
    }
    this.counters.crashed += 1
    logger.warn({ err: error }, '[session-search] worker stopped unexpectedly; it will be restarted on the next search')
    this.worker = null
    this.ready = false
    const job = this.active
    this.active = null
    if (job) this.settle(job, new SessionSearchError('SESSION_SEARCH_WORKER_EXITED', 'Session search worker stopped unexpectedly'))
    this.pump()
  }

  private handleStartupFailure(error: unknown): void {
    this.counters.startupFailures += 1
    this.failedUntil = Date.now() + (this.config.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS)
    logger.warn({ err: error }, '[session-search] worker failed to start; searching on the main thread')
    this.disposeWorker()
    for (const job of this.queue.splice(0)) {
      if (job.settled) continue
      this.runOnMainThread(job.args).then(
        run => this.settle(job, null, run),
        err => this.settle(job, err),
      )
    }
  }

  private timeoutJob(job: PendingJob): void {
    // hermes-v050:F-18 an aborted job still running in the worker keeps this watchdog.
    if (job.settled && this.active !== job) return
    const error = new SessionSearchError('SESSION_SEARCH_TIMEOUT', 'Session search timed out')
    if (this.active === job) {
      // terminate() stops the worker's JS; a native SQLite step in progress
      // finishes on that (now detached) thread, never on the main thread.
      this.counters.terminated += 1
      this.active = null
      this.disposeWorker()
      this.settle(job, error)
      this.pump()
      return
    }
    this.queue = this.queue.filter(item => item !== job)
    this.settle(job, error)
  }

  private abortJob(job: PendingJob): void {
    if (job.settled) return
    if (this.active !== job) this.queue = this.queue.filter(item => item !== job)
    // hermes-v050:F-18 answer the caller now, but a running job's deadline must still recycle
    // the worker if it never finishes; otherwise every later search queues behind it and 503s.
    this.settle(job, abortError(), undefined, { keepDeadline: this.active === job })
  }

  private settle(job: PendingJob, error: unknown, run?: SessionSearchRun, options: { keepDeadline?: boolean } = {}): void {
    // hermes-v050:F-18 the worker answered, died or was replaced: the kept watchdog is done too.
    if (job.deadline && !options.keepDeadline) {
      clearTimeout(job.deadline)
      job.deadline = undefined
    }
    if (job.settled) return
    job.settled = true
    if (job.signal && job.onAbort) job.signal.removeEventListener('abort', job.onAbort)
    if (error) job.reject(error)
    else job.resolve(run!)
  }

  private disposeWorker(): void {
    const worker = this.worker
    this.worker = null
    this.ready = false
    if (worker) void worker.terminate().catch(() => undefined)
  }

  private scheduleIdle(): void {
    const worker = this.worker
    if (!worker) return
    worker.unref()
    this.clearIdleTimer()
    const idleMs = this.config.idleMs ?? DEFAULT_IDLE_MS
    if (idleMs <= 0) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (!this.active && this.queue.length === 0) this.disposeWorker()
    }, idleMs)
    this.idleTimer.unref?.()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }
}

/**
 * The bundled worker sits next to dist/server/index.js. TS sources (dev,
 * vitest) have no bundle and keep searching on the main thread.
 */
export function resolveSessionSearchWorkerScript(
  env: Record<string, string | undefined> = process.env,
  baseDir: string = __dirname,
): string | null {
  const override = env.HERMES_WEB_UI_SESSION_SEARCH_WORKER?.trim()
  if (override && ['0', 'false', 'off', 'no'].includes(override.toLowerCase())) return null
  const candidate = override || resolve(baseDir, SESSION_SEARCH_WORKER_FILE)
  return existsSync(candidate) ? candidate : null
}

function resolveWorkerDbPath(): string | null {
  if (!isSqliteAvailable()) return null
  const db = getDb()
  const dbPath = getStoragePath()
  if (!db || !dbPath || dbPath === ':memory:' || !existsSync(dbPath)) return null
  // In rollback-journal mode (dev) a reader would block the main writer.
  const mode = (db.prepare('PRAGMA journal_mode').get() as { journal_mode?: unknown } | undefined)?.journal_mode
  return String(mode || '').toLowerCase() === 'wal' ? dbPath : null
}

let defaultPool: SessionSearchWorkerPool | null = null

export function getSessionSearchPool(): SessionSearchWorkerPool {
  if (!defaultPool) {
    const scriptPath = resolveSessionSearchWorkerScript()
    defaultPool = new SessionSearchWorkerPool({
      scriptPath,
      dbPath: scriptPath ? resolveWorkerDbPath() : null,
      fallback: searchSessions,
    })
  }
  return defaultPool
}

export function searchSessionsOffMainThread(
  profile: string | null | undefined,
  query: string,
  limit: number | undefined,
  options: SessionSearchOptions,
  call: SessionSearchCallOptions = {},
): Promise<HermesSessionSearchRow[]> {
  return getSessionSearchPool().search({ profile, query, limit, options }, call)
}

export async function closeSessionSearchPool(): Promise<void> {
  const pool = defaultPool
  defaultPool = null
  await pool?.close()
}
