// @vitest-environment node
// File-access hardening regression suite; real local filesystem, no sensitive data.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const state = vi.hoisted(() => ({ profile: '', upload: '', other: '' }))
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ config: { get uploadDir() { return state.upload } } }))
vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  getActiveProfileDir: () => state.profile,
  getProfileDir: (profile: string) => profile === 'other' ? state.other : state.profile,
}))
import { resolveReadableFilePath } from '../../packages/server/src/modules/studio/services/files/file-provider'
let base: string
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'sd01-safe-'))
  state.profile = join(base, 'profile'); state.upload = join(base, 'upload'); state.other = join(base, 'other')
  await mkdir(state.profile); await mkdir(state.other)
  await writeFile(join(state.profile, 'normal.txt'), 'fixture only')
  await writeFile(join(state.other, 'outside.txt'), 'fixture outside')
})
afterEach(async () => { await rm(base, { recursive: true, force: true }) })
describe('SD-01 local readable path (not remote-provider or TOCTOU proof)', () => {
  it('imports and calls the real helper; absent upload does not block a normal profile read', async () => {
    const path = await resolveReadableFilePath('normal.txt')
    expect(await readFile(path, 'utf8')).toBe('fixture only')
  })
  it.each([false, true])('rejects escaping symlink with upload present=%s', async present => {
    if (present) await mkdir(state.upload)
    await symlink(join(state.other, 'outside.txt'), join(state.profile, 'escape.txt'))
    await expect(resolveReadableFilePath('escape.txt')).rejects.toMatchObject({ code: 'invalid_path' })
  })
  it.each(['missing.txt', 'dangling.txt', 'normal.txt/child'])('rejects unresolvable candidate %s', async path => {
    await symlink(join(base, 'nonexistent'), join(state.profile, 'dangling.txt'))
    await expect(resolveReadableFilePath(path)).rejects.toHaveProperty('code')
  })
  it('allows a normal upload even when the unrelated profile root is absent', async () => {
    await mkdir(state.upload); const path = join(state.upload, 'ok.txt'); await writeFile(path, 'upload')
    state.profile = join(base, 'absent-profile')
    expect(await resolveReadableFilePath(path)).toBe(path)
  })
  it('allows internal symlink', async () => {
    await symlink(join(state.profile, 'normal.txt'), join(state.profile, 'internal.txt'))
    const resolved = await resolveReadableFilePath('internal.txt')
    expect(resolved).toBe(join(state.profile, 'internal.txt'))
    expect(await readFile(resolved, 'utf8')).toBe('fixture only')
  })
  it('rejects a profile symlink into the separate upload root', async () => {
    await mkdir(state.upload)
    await writeFile(join(state.upload, 'ok.txt'), 'upload')
    await symlink(join(state.upload, 'ok.txt'), join(state.profile, 'cross-root.txt'))
    await expect(resolveReadableFilePath('cross-root.txt')).rejects.toMatchObject({ code: 'invalid_path' })
  })
  it.each(['.env', 'auth.json'])('rejects direct and linked sensitive target %s', async name => {
    await writeFile(join(state.profile, name), 'fake fixture only')
    await symlink(join(state.profile, name), join(state.profile, 'alias.txt'))
    await expect(resolveReadableFilePath(name)).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(resolveReadableFilePath('alias.txt')).rejects.toMatchObject({ code: 'permission_denied' })
  })
  it('rejects absolute paths in a different profile and traversal', async () => {
    await expect(resolveReadableFilePath(join(state.other, 'outside.txt'))).rejects.toMatchObject({ code: 'invalid_path' })
    await expect(resolveReadableFilePath('../other/outside.txt')).rejects.toMatchObject({ code: 'invalid_path' })
  })
})
