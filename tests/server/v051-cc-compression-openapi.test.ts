// hermes-v051:C OpenAPI: only the two compression operations are documented (the rest of cc-api returns
// API keys and stays out of the catalog that hermes-studio-mcp uses as its allow-list), and Hermes chat
// compression reads its ranges from the same normalizer Claude's "follow main settings" uses.
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(__dirname, '../..')
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// The generator always writes <root>/docs/openapi.json; run a copy against the real sources instead.
function generate(): any {
  const dir = mkdtempSync(join(tmpdir(), 'v051-openapi-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'scripts'))
  mkdirSync(join(dir, 'docs'))
  copyFileSync(join(root, 'scripts/generate-openapi.mjs'), join(dir, 'scripts/generate-openapi.mjs'))
  copyFileSync(join(root, 'package.json'), join(dir, 'package.json'))
  symlinkSync(join(root, 'packages'), join(dir, 'packages'))
  execFileSync(process.execPath, [join(dir, 'scripts/generate-openapi.mjs')], { stdio: 'ignore' })
  return JSON.parse(readFileSync(join(dir, 'docs/openapi.json'), 'utf8'))
}

describe('hermes-v051:C API docs and shared compression ranges', () => {
  it('documents GET/PUT /api/hermes/cc-api/compression and nothing else under cc-api', () => {
    const doc = generate()
    const entry = doc.paths['/api/hermes/cc-api/compression']
    expect(entry?.get?.operationId).toBe('getCompression')
    expect(entry?.put?.operationId).toBe('setCompression')
    const body = entry.put.requestBody.content['application/json'].schema
    expect(Object.keys(body.properties).sort()).toEqual(['follow_main', 'own'])
    expect(body.properties.own.properties.threshold).toMatchObject({ minimum: 0.1, maximum: 0.95 })
    expect(body.properties.own.properties.target_ratio).toMatchObject({ minimum: 0.05, maximum: 0.8 })
    expect(body.properties.own.properties.protect_last_n).toMatchObject({ type: 'integer', minimum: 0, maximum: 200 })
    expect(body.properties.own.properties.protect_first_n).toMatchObject({ type: 'integer', minimum: 0, maximum: 50 })
    expect(entry.get.responses['200'].content['application/json'].schema.required.sort()).toEqual(['effective', 'follow_main', 'main', 'own'])
    expect(Object.keys(doc.paths).filter(path => path.startsWith('/api/hermes/cc-api'))).toEqual(['/api/hermes/cc-api/compression'])
  })

  it('bootstrap loads the adapter that wires the Studio port for the Hermes cc-api controller', () => {
    const routes = readFileSync(join(root, 'packages/server/src/bootstrap/routes.ts'), 'utf8')
    expect(routes).toMatch(/^import '\.\/claude-compression-adapter'/m)
    const controller = readFileSync(join(root, 'packages/server/src/modules/hermes/controllers/cc-api.ts'), 'utf8')
    expect(controller).toContain("from '../../studio/public/claude-compression'")
    expect(controller).not.toMatch(/coding-agents/)
  })

  it('Hermes chat compression uses the shared normalizer instead of its own clamps', () => {
    const source = readFileSync(join(root, 'packages/server/src/modules/studio/services/chat-run/compression.ts'), 'utf8')
    expect(source).toContain("import { normalizeCompressionSection } from '../../public/compression-config'")
    expect(source).toMatch(/= normalizeCompressionSection\(raw\)/)
    expect(source).not.toMatch(/function clamp(Ratio|Int)\(/)
    const claude = readFileSync(join(root, 'packages/server/src/modules/coding-agents/services/claude-compression-settings.ts'), 'utf8')
    expect(claude).toContain("import { normalizeCompressionSection } from '../../studio/public/compression-config'")
  })
})
