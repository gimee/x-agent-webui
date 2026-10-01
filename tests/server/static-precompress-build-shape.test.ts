import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// hermes-v050:S2 source-shape guard for the build chain: precompression must be the last write
// to dist/client, otherwise a .br/.gz sibling would no longer match the file it encodes.
const sourceRoot = resolve(__dirname, '../..')
const viteConfig = readFileSync(resolve(sourceRoot, 'vite.config.ts'), 'utf8')
const plugin = readFileSync(resolve(sourceRoot, 'scripts/vite-precompress.ts'), 'utf8')
const packageJson = JSON.parse(readFileSync(resolve(sourceRoot, 'package.json'), 'utf8'))
const dockerfilePath = resolve(sourceRoot, '../Dockerfile')

describe('static precompression build wiring', () => {
  it('runs as the final vite hook, after index.html and public/ are written', () => {
    expect(viteConfig).toMatch(/plugins:\s*\[vue\(\),\s*precompressPlugin\(\)\]/)
    expect(plugin).toContain("apply: 'build'")
    expect(plugin).toContain('async closeBundle()')
    expect(plugin).toContain('BROTLI_PARAM_QUALITY]: 11')
  })

  it('has no build step that rewrites dist/client after vite build', () => {
    const build = String(packageJson.scripts.build)
    const afterVite = build.slice(build.indexOf('vite build') + 'vite build'.length)
    expect(build).toContain('vite build')
    expect(afterVite).not.toMatch(/dist\/client|index\.html/)
    expect(readFileSync(resolve(sourceRoot, 'scripts/build-server.mjs'), 'utf8')).not.toMatch(/dist\/client|['"]client['"]/)
  })

  it.skipIf(!existsSync(dockerfilePath))('keeps the image build free of later dist/client edits', () => {
    const dockerfile = readFileSync(dockerfilePath, 'utf8')
    const afterBuild = dockerfile.slice(dockerfile.indexOf('npm run build'))
    expect(dockerfile).toContain('npm run build')
    expect(afterBuild).not.toMatch(/dist\/client|index\.html|hermes-drawer-css/)
  })
})
