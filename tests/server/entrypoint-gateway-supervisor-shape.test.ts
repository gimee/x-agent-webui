import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// hermes-v050:S1 source-shape guard for the build layer (it lives next to source/ in the
// product directory, like pi-native-install.test.ts reads ../Dockerfile).
const sourceRoot = resolve(__dirname, '../..')
const supervisorPath = resolve(sourceRoot, '../hermes-entrypoint.py')

describe.skipIf(!existsSync(supervisorPath))('PID1 gateway supervisor', () => {
  const supervisor = existsSync(supervisorPath) ? readFileSync(supervisorPath, 'utf8') : ''

  it('tells the WebUI which gateway it owns so autostart does not --replace it', () => {
    expect(supervisor).toContain('webui_env["HERMES_WEB_UI_EXTERNAL_GATEWAY_PROFILES"] = "default"')
    expect(supervisor).toMatch(/webui = subprocess\.Popen\(\s*\["node", "dist\/server\/index\.js", \*sys\.argv\[1:\]\],\s*env=webui_env,/)
  })

  it('backs off clean fast gateway exits instead of a fixed 3s respawn loop', () => {
    expect(supervisor).toContain('def next_gateway_restart_delay(')
    expect(supervisor).toContain('GATEWAY_MAX_RESTART_DELAY_S = 60.0')
    // hermes-v050:F-02 the backoff now goes through the planned-restart check first.
    expect(supervisor).toMatch(/delay = next_gateway_restart_delay\(rc, ran_for, previous_delay\)/)
    expect(supervisor).toMatch(/wait_s, restart_delay = gateway_exit_restart_plan\(gateway_rc, time\.monotonic\(\) - gateway_started, restart_delay\)/)
    expect(supervisor).not.toContain('restarting in 3s')
  })

  it('hermes-v050:F-02 respawns a WebUI-requested restart at once: marker read on exit and during the wait', () => {
    expect(supervisor).toContain('GATEWAY_PLANNED_RESTART_MARKER = HERMES_HOME / ".pid1-planned-gateway-restart"')
    expect(supervisor).toMatch(/if sleep_until_gateway_restart\(wait_s\):\s*restart_delay = 0\.0/)
  })

  it('keeps the existing single-owner lifecycle: no-supervise child, gateway stopped before WebUI', () => {
    expect(supervisor).toContain('["/opt/hermes/.venv/bin/hermes", "gateway", "run", "--no-supervise"]')
    expect(supervisor.indexOf('terminate_group(gateway, "gateway")')).toBeLessThan(supervisor.indexOf('terminate_group(webui, "WebUI")'))
  })
})
