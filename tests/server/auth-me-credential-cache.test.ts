// hermes-v050:S10 /api/auth/me flags the default password without a synchronous scrypt on
// every request, and the flag can never be stale or leak into authentication.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const scryptState = vi.hoisted(() => ({ calls: 0 }))

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>()
  const scryptSync = ((...args: Parameters<typeof actual.scryptSync>) => {
    scryptState.calls += 1
    return actual.scryptSync(...args)
  }) as typeof actual.scryptSync
  return { ...actual, default: { ...actual, scryptSync }, scryptSync }
})

describe('/api/auth/me default-password flag', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    vi.stubEnv('AUTH_JWT_SECRET', 'test-secret')
    vi.stubEnv('HERMES_DESKTOP', 'false')
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
    }))
    vi.doMock('../../packages/server/src/modules/studio/public/profile-config', () => ({
      listProfileNamesFromDisk: () => ['default'],
    }))
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.doUnmock('../../packages/server/src/modules/studio/public/profile-config')
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  async function setup() {
    const schemas = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    schemas.initAllHermesTables()
    const users = await import('../../packages/server/src/modules/studio/repositories/users-store')
    const ctrl = await import('../../packages/server/src/modules/studio/controllers/auth')
    const me = async (user: { id: number; username: string }) => {
      const ctx = { state: { user: { ...user, role: 'super_admin' } }, status: 200, body: null } as any
      await ctrl.currentUser(ctx)
      return ctx
    }
    const login = async (username: string, password: string) => {
      const ctx = { request: { body: { username, password } }, headers: {}, ip: '127.0.0.1', status: 200, body: null } as any
      await ctrl.login(ctx)
      return ctx
    }
    return { users, me, login }
  }

  it('runs scrypt once per stored password hash, not once per request', async () => {
    const { users, me } = await setup()
    const admin = users.bootstrapDefaultSuperAdmin('admin', '123456')!
    const before = scryptState.calls

    for (let i = 0; i < 5; i += 1) {
      expect((await me(admin)).body.user.requiresCredentialChange).toBe(true)
    }

    expect(scryptState.calls - before).toBe(1)
  })

  it('follows password changes, resets and user deletion immediately', async () => {
    const { users, me } = await setup()
    const admin = users.bootstrapDefaultSuperAdmin('admin', '123456')!
    expect((await me(admin)).body.user.requiresCredentialChange).toBe(true)

    users.updateUserPassword(admin.id, 'stronger-password')
    expect((await me(admin)).body.user.requiresCredentialChange).toBe(false)

    users.updateUser({ userId: admin.id, password: '123456' })
    expect((await me(admin)).body.user.requiresCredentialChange).toBe(true)

    expect(users.deleteUser(admin.id)).toBe(true)
    const gone = await me(admin)
    expect(gone.status).toBe(404)
  })

  it('never lets the cached flag stand in for a password check at login', async () => {
    const { users, me, login } = await setup()
    const admin = users.bootstrapDefaultSuperAdmin('admin', '123456')!
    expect((await me(admin)).body.user.requiresCredentialChange).toBe(true)
    const before = scryptState.calls

    const wrong = await login('admin', 'not-the-password')
    expect(wrong.status).toBe(401)
    expect(wrong.body.token).toBeUndefined()
    const right = await login('admin', '123456')
    expect(right.status).toBe(200)
    expect(right.body.token).toMatch(/^[^.]+\.[^.]+\.[^.]+$/)
    // both logins verified the submitted password for real
    expect(scryptState.calls - before).toBeGreaterThanOrEqual(2)
  })
})
