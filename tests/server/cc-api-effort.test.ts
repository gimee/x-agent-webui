import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getEffort, setEffort } from '../../packages/server/src/modules/hermes/controllers/cc-api'
import { ccApiRoutes } from '../../packages/server/src/modules/hermes/routes/cc-api'

let dir = ''
const previous = process.env.CLAUDE_CONFIG_DIR
const settingsFile = () => join(dir, 'settings.json')
const readSettings = async () => JSON.parse(await readFile(settingsFile(), 'utf-8'))
const put = async (level: unknown) => {
  const ctx: any = { request: { body: { level } } }
  await setEffort(ctx)
  return ctx
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cc-effort-'))
  process.env.CLAUDE_CONFIG_DIR = dir
})

afterEach(async () => {
  if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previous
  await rm(dir, { recursive: true, force: true })
})

describe('Claude Code reasoning effort (Agent 管理 → Claude → 推理强度)', () => {
  it('writes env.CLAUDE_CODE_EFFORT_LEVEL (applies to every model) and mirrors effortLevel, keeping other keys', async () => {
    await writeFile(settingsFile(), JSON.stringify({ model: 'claude-opus-5-5', effortLevel: 'xhigh', env: { ANTHROPIC_BASE_URL: 'http://x' }, theme: 'dark' }))
    const ctx: any = {}
    await getEffort(ctx)
    // A bare top-level effortLevel is ignored by current CLIs for Opus 5.x, so it is not reported as active.
    expect(ctx.body.level).toBe('auto')

    expect((await put('max')).body.level).toBe('max')
    expect(await readSettings()).toEqual({ model: 'claude-opus-5-5', effortLevel: 'max', env: { ANTHROPIC_BASE_URL: 'http://x', CLAUDE_CODE_EFFORT_LEVEL: 'max' }, theme: 'dark' })
    const again: any = {}
    await getEffort(again)
    expect(again.body.level).toBe('max')
    expect(JSON.parse(await readFile(`${settingsFile()}.ccbak`, 'utf-8')).effortLevel).toBe('xhigh')
  })

  it("'auto' removes both keys so the model default applies", async () => {
    await put('low')
    await put('auto')
    const settings = await readSettings()
    expect(settings.effortLevel).toBeUndefined()
    expect(settings.env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined()
  })

  it('rejects unknown levels without touching settings.json', async () => {
    await writeFile(settingsFile(), '{"effortLevel":"high"}')
    for (const level of ['ultra', 'none', '', 7]) {
      const ctx = await put(level)
      expect(ctx.status).toBe(400)
    }
    expect(await readSettings()).toEqual({ effortLevel: 'high' })
  })

  it('effort routes are registered before /:id so "effort" is never treated as a profile id', () => {
    const paths = ccApiRoutes.stack.map((layer: any) => `${layer.methods.filter((m: string) => m !== 'HEAD').join(',')} ${layer.path}`)
    expect(paths.indexOf('PUT /api/hermes/cc-api/effort')).toBeGreaterThanOrEqual(0)
    expect(paths.indexOf('PUT /api/hermes/cc-api/effort')).toBeLessThan(paths.indexOf('PUT /api/hermes/cc-api/:id'))
    expect(paths).toContain('GET /api/hermes/cc-api/effort')
  })
})
