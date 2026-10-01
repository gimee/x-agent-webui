import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { brotliCompress, constants as zlibConstants, gzip } from 'node:zlib'
import type { Plugin } from 'vite'

// hermes-v050:S2 Build-time .br (q11) and .gz siblings for the text assets and index.html.
// koa-send (behind koa-static and the SPA fallback) sends an accepted sibling before the
// original, and the runtime static compression middleware then sees Content-Encoding and
// skips its per-request compression (q11 cost ~370ms of threadpool time for a 204KB chunk).
// This must stay the last write to dist/client: a sibling that no longer matches its
// original would be served as-is (the middleware also refuses siblings older than it).

const brotliCompressAsync = promisify(brotliCompress)
const gzipAsync = promisify(gzip)

// The types the runtime middleware compresses; fonts/images are already compressed.
const PRECOMPRESSED_EXTENSIONS = new Set(['.js', '.mjs', '.css', '.html', '.svg', '.json', '.webmanifest'])
// Same floor as the runtime middleware (static-compression.ts DEFAULT_MIN_BYTES).
const MIN_BYTES = 1024
// zlib runs on the libuv threadpool (4 threads by default).
const CONCURRENCY = 4

export interface PrecompressResult {
  files: number
  bytes: number
  brotliBytes: number
  gzipBytes: number
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(entries.map(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return listFiles(path)
    return Promise.resolve(entry.isFile() ? [path] : [])
  }))
  return nested.flat()
}

async function writeOrRemove(path: string, encoded: Buffer | null): Promise<number> {
  if (!encoded) {
    await rm(path, { force: true })
    return 0
  }
  await writeFile(path, encoded)
  return encoded.byteLength
}

export async function precompressDirectory(root: string): Promise<PrecompressResult> {
  const files = (await listFiles(root)).filter(path => PRECOMPRESSED_EXTENSIONS.has(extname(path).toLowerCase()))
  const result: PrecompressResult = { files: 0, bytes: 0, brotliBytes: 0, gzipBytes: 0 }
  let next = 0

  const worker = async () => {
    while (next < files.length) {
      const path = files[next++]
      const original = await readFile(path)
      if (original.byteLength < MIN_BYTES) {
        await Promise.all([rm(`${path}.br`, { force: true }), rm(`${path}.gz`, { force: true })])
        continue
      }
      const [br, gz] = await Promise.all([
        brotliCompressAsync(original, {
          params: {
            [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
            [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
            [zlibConstants.BROTLI_PARAM_SIZE_HINT]: original.byteLength,
          },
        }),
        gzipAsync(original, { level: 9 }),
      ])
      // A sibling that is not smaller is useless; drop any stale one instead of keeping it.
      const brotliBytes = await writeOrRemove(`${path}.br`, br.byteLength < original.byteLength ? br : null)
      const gzipBytes = await writeOrRemove(`${path}.gz`, gz.byteLength < original.byteLength ? gz : null)
      if (!brotliBytes && !gzipBytes) continue
      result.files += 1
      result.bytes += original.byteLength
      result.brotliBytes += brotliBytes
      result.gzipBytes += gzipBytes
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker))
  return result
}

export function precompressPlugin(): Plugin {
  let outDir = ''
  return {
    name: 'hermes-precompress',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    // closeBundle runs after every bundle file, index.html and the public/ copy are on disk.
    async closeBundle() {
      const started = Date.now()
      const result = await precompressDirectory(outDir)
      console.log(
        `[hermes-precompress] ${result.files} files ${(result.bytes / 1024).toFixed(0)}KB -> `
        + `br ${(result.brotliBytes / 1024).toFixed(0)}KB / gzip ${(result.gzipBytes / 1024).toFixed(0)}KB `
        + `in ${Date.now() - started}ms`,
      )
    },
  }
}
