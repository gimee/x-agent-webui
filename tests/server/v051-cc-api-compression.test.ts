// hermes-v051:C GET/PUT /api/hermes/cc-api/compression — registered before /:id, profile from the request,
// served by the Hermes cc-api controller through the Studio port that bootstrap wires to Coding Agents.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const readConfigYamlForProfile = vi.hoisted(() => vi.fn())
vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({ readConfigYamlForProfile }))
vi.mock('../../packages/server/src/modules/hermes/services/profiles/profile', () => ({ getActiveProfileName: () => 'active-one' }))

import Koa from 'koa'
import { createRequestBodyParser } from '../../packages/server/src/modules/studio/middleware/request-body-parser'
import '../../packages/server/src/bootstrap/claude-compression-adapter'
import { ccApiRoutes } from '../../packages/server/src/modules/hermes/routes/cc-api'

let home = ''
let server: Server
let baseUrl = ''
const previousHome = process.env.HERMES_WEB_UI_HOME
const previousClaude = process.env.CLAUDE_CONFIG_DIR

beforeAll(async () => {
  const app = new Koa()
  app.use(createRequestBodyParser())
  app.use(ccApiRoutes.routes())
  server = createServer(app.callback())
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), 'v051-cc-compression-api-'))
  process.env.HERMES_WEB_UI_HOME = home
  process.env.CLAUDE_CONFIG_DIR = join(home, 'claude')
  readConfigYamlForProfile.mockReset()
  readConfigYamlForProfile.mockResolvedValue({ compression: { threshold: 0.8, target_ratio: 0.5 } })
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HERMES_WEB_UI_HOME
  else process.env.HERMES_WEB_UI_HOME = previousHome
  if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousClaude
  await fs.rm(home, { recursive: true, force: true })
})

const call = (method: string, body?: unknown, headers: Record<string, string> = {}) => fetch(`${baseUrl}/api/hermes/cc-api/compression`, {
  method,
  headers: { 'content-type': 'application/json', ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
})

describe('hermes-v051:C cc-api compression routes', () => {
  it('compression routes are registered before /:id so "compression" is never treated as a profile id', () => {
    const paths = ccApiRoutes.stack.map((layer: any) => `${layer.methods.filter((m: string) => m !== 'HEAD').join(',')} ${layer.path}`)
    expect(paths).toContain('GET /api/hermes/cc-api/compression')
    expect(paths.indexOf('PUT /api/hermes/cc-api/compression')).toBeGreaterThanOrEqual(0)
    expect(paths.indexOf('PUT /api/hermes/cc-api/compression')).toBeLessThan(paths.indexOf('PUT /api/hermes/cc-api/:id'))
  })

  it('GET returns follow_main / own / main / effective for the request profile', async () => {
    const res = await call('GET', undefined, { 'x-hermes-profile': 'work' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      follow_main: false,
      own: { enabled: true, threshold: 0.4, target_ratio: 0.08, protect_last_n: 20, protect_first_n: 3 },
      main: { enabled: true, threshold: 0.8, target_ratio: 0.5, protect_last_n: 20, protect_first_n: 3 },
      effective: { enabled: true, threshold: 0.4, target_ratio: 0.08, protect_last_n: 20, protect_first_n: 3 },
    })
    expect(readConfigYamlForProfile).toHaveBeenLastCalledWith('work')
    await call('GET')
    expect(readConfigYamlForProfile).toHaveBeenLastCalledWith('active-one')
  })

  it('PUT /compression reaches the compression handler, not the /:id profile editor', async () => {
    const res = await call('PUT', { follow_main: true })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.follow_main).toBe(true)
    expect(body.effective).toEqual(body.main)
    const saved = JSON.parse(await fs.readFile(join(home, 'coding-agent', 'claude-context', 'compression.json'), 'utf8'))
    expect(saved.follow_main).toBe(true)
    await expect(fs.stat(join(home, 'claude', 'cc-api-profiles.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('PUT rejects invalid input with 400 and an error message', async () => {
    const res = await call('PUT', { own: { threshold: 0.99 } })
    expect(res.status).toBe(400)
    expect(typeof (await res.json()).error).toBe('string')
    await expect(fs.stat(join(home, 'coding-agent', 'claude-context', 'compression.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
