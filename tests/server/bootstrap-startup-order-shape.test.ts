import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// hermes-v050:S5 source-shape guard: Docker bootstrap must not hold the listening socket back
// for the Python agent bridge (5s attach probe + spawn). Runtime semantics are covered by
// bridge-startup-after-listen.test.ts.
const bootstrap = readFileSync('packages/server/src/bootstrap/http.ts', 'utf8')

function functionBody(name: string): string {
  const start = bootstrap.indexOf(`async function ${name}(`)
  expect(start, name).toBeGreaterThan(-1)
  const end = bootstrap.indexOf('\n}\n', start)
  return bootstrap.slice(start, end)
}

describe('bootstrap startup order', () => {
  it('only checks profile gateways before listening in Docker mode', () => {
    const beforeListen = functionBody('startRuntimeServicesBeforeListen')
    expect(beforeListen).toContain('ensureProfileGatewaysRunning()')
    expect(beforeListen).not.toContain('startAgentBridge')
  })

  it('starts the agent bridge only after the HTTP server is listening', () => {
    const main = functionBody('bootstrap')
    const listen = main.indexOf('await listenWithFallback(')
    const ready = main.indexOf('bootstrapReady = true', listen)
    const bridge = main.indexOf('startAgentBridge()')
    expect(listen).toBeGreaterThan(-1)
    expect(main.indexOf('startAgentBridge')).toBeGreaterThan(ready)
    expect(bridge).toBeGreaterThan(ready)
    // startup complete is still logged only once the bridge attempt has settled
    expect(main.indexOf("console.log('[bootstrap] startup complete')")).toBeGreaterThan(main.indexOf('await dockerAgentBridgeStartup'))
  })

  it('keeps Desktop on its existing after-listen runtime path', () => {
    const afterListen = functionBody('startRuntimeServicesAfterListen')
    expect(afterListen).toContain('ensureProfileGatewaysRunning()')
    expect(afterListen).toContain('startAgentBridge()')
  })
})
