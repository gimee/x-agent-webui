import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Frozen product: Pi is one of the three independently updated agent layers.
// The Dockerfile lives next to source/ in the product directory.
const sourceRoot = resolve(__dirname, '../..')
const service = readFileSync(resolve(sourceRoot, 'packages/server/src/modules/coding-agents/services/index.ts'), 'utf8')
const dockerfilePath = resolve(sourceRoot, '../Dockerfile')
const entrypointPath = resolve(sourceRoot, '../docker-entrypoint.sh')

describe('Pi agent layer wiring', () => {
  it('installs Pi and its MCP adapter from @latest through the native service', () => {
    expect(service).toContain("PI_CODING_AGENT_INSTALL_SPEC = '@earendil-works/pi-coding-agent@latest'")
    expect(service).toContain("PI_MCP_ADAPTER_INSTALL_SPEC = 'pi-mcp-adapter@latest'")
    expect(service).toContain("runNpm(['view', tool.packageName, 'version'")
    expect(service).not.toContain('PI_CODING_AGENT_VERSION')
    expect(service).not.toContain('PI_MCP_ADAPTER_VERSION')
  })

  it.skipIf(!existsSync(dockerfilePath))('preinstalls the Pi CLI and seeds the adapter with the native npm layout', () => {
    const dockerfile = readFileSync(dockerfilePath, 'utf8')
    const entrypoint = readFileSync(entrypointPath, 'utf8')
    expect(dockerfile).toContain('npm install -g @earendil-works/pi-coding-agent@latest && pi --version')
    expect(dockerfile).toContain('npm install --prefix /opt/hermes-pi-seed/pi-mcp-adapter --save-exact --no-audit --no-fund pi-mcp-adapter@latest')
    expect(dockerfile).toContain('test -f /opt/hermes-pi-seed/pi-mcp-adapter/node_modules/pi-mcp-adapter/index.ts')
    expect(entrypoint).toContain('PI_ADAPTER_DIR="${HERMES_WEB_UI_HOME}/coding-agent/pi-mcp-adapter"')
    expect(entrypoint).toContain('cp -a "${HERMES_PI_SEED}/." "$PI_ADAPTER_DIR/"')
  })
})
