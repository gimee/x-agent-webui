// hermes-v050:S2 build-time precompression: every .br/.gz sibling must decompress to exactly
// the bytes of the file it stands for, otherwise koa-send would serve different content.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { precompressDirectory } from '../../scripts/vite-precompress'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-precompress-'))
  tempDirs.push(dir)
  return dir
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  })
}

function expectSiblingsMatch(root: string): number {
  let checked = 0
  for (const path of walk(root)) {
    if (!path.endsWith('.br') && !path.endsWith('.gz')) continue
    const original = readFileSync(path.slice(0, -3))
    const decoded = path.endsWith('.br') ? brotliDecompressSync(readFileSync(path)) : gunzipSync(readFileSync(path))
    expect(decoded.equals(original), path).toBe(true)
    expect(statSync(path).mtimeMs, path).toBeGreaterThanOrEqual(statSync(path.slice(0, -3)).mtimeMs)
    checked += 1
  }
  return checked
}

describe('build-time static precompression', () => {
  it('writes byte-identical .br and .gz siblings for text assets and index.html', async () => {
    const root = tempDir()
    mkdirSync(join(root, 'assets', 'js'), { recursive: true })
    mkdirSync(join(root, 'assets', 'css'), { recursive: true })
    const files: Record<string, string | Buffer> = {
      'index.html': `<!doctype html><html><head><title>Hermes Studio</title></head><body>${'<div class="x">中文 ✓</div>'.repeat(200)}</body></html>`,
      'assets/js/index-abc.js': 'export const route = "/chat";\n'.repeat(4000),
      'assets/css/index-abc.css': '.button{color:#123456}\n'.repeat(500),
      'assets/logo.svg': `<svg xmlns="http://www.w3.org/2000/svg">${'<path d="M0 0L10 10"/>'.repeat(100)}</svg>`,
      'assets/data.json': JSON.stringify({ items: Array.from({ length: 300 }, (_, i) => ({ i, label: `item-${i}` })) }),
      'manifest.webmanifest': JSON.stringify({ name: 'Hermes Studio', icons: Array.from({ length: 80 }, (_, i) => ({ src: `/icon-${i}.png` })) }),
    }
    for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body)
    writeFileSync(join(root, 'assets', 'tiny.js'), 'export {}\n')
    writeFileSync(join(root, 'logo.png'), Buffer.alloc(8192, 7))
    writeFileSync(join(root, 'font.woff2'), Buffer.alloc(8192, 3))

    const result = await precompressDirectory(root)

    for (const name of Object.keys(files)) {
      expect(existsSync(join(root, `${name}.br`)), name).toBe(true)
      expect(existsSync(join(root, `${name}.gz`)), name).toBe(true)
    }
    // below the runtime middleware threshold, or not a text type the middleware would compress
    for (const name of ['assets/tiny.js', 'logo.png', 'font.woff2']) {
      expect(existsSync(join(root, `${name}.br`)), name).toBe(false)
      expect(existsSync(join(root, `${name}.gz`)), name).toBe(false)
    }
    expect(expectSiblingsMatch(root)).toBe(Object.keys(files).length * 2)
    expect(result.files).toBe(Object.keys(files).length)
  })

  it('replaces siblings left over from an earlier build instead of trusting them', async () => {
    const root = tempDir()
    writeFileSync(join(root, 'index.html'), '<html>old</html>'.repeat(200))
    await precompressDirectory(root)
    writeFileSync(join(root, 'index.html'), '<html>new injected css</html>'.repeat(200))

    await precompressDirectory(root)

    expect(brotliDecompressSync(readFileSync(join(root, 'index.html.br'))).toString()).toContain('new injected css')
    expect(expectSiblingsMatch(root)).toBe(2)
  })

  const distClient = resolve(__dirname, '../../dist/client')
  const builtWithPrecompression = existsSync(join(distClient, 'index.html.br'))
  it.skipIf(!builtWithPrecompression)('keeps every sibling in the real vite build output byte-identical to its original', () => {
    expect(expectSiblingsMatch(distClient)).toBeGreaterThan(100)
  })
})
