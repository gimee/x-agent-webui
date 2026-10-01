import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, stat, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = join(tmpdir(),'hermes-claude-store-tests')+'/';
async function fixture(t) { await mkdir(root,{recursive:true}); const dir=await mkdtemp(root+'store-'); t.after(()=>rm(dir,{recursive:true,force:true})); return dir; }

test('checkpoint is atomic, private, scope bound and locks exclude concurrent owners', async t => {
  const { openStore } = await import('../../bin/claude-context/store.mjs');
  const dir=await fixture(t), scope={profile:'p',studio:'s',project:dir,cwd:dir};
  const store=await openStore(dir,scope);
  const release=await store.lock('session');
  await assert.rejects(store.lock('session'),/locked/);
  await store.write('checkpoint',{scope,current:'N',generation:1});
  assert.deepEqual(await store.read('checkpoint'),{scope,current:'N',generation:1});
  assert.equal((await stat(store.file('checkpoint'))).mode & 0o777,0o600);
  await release(); const second=await store.lock('session'); await second();
  await store.write('checkpoint',{scope:{...scope,profile:'other'},current:'N'});
  await assert.rejects(store.read('checkpoint'),/scope/);
});

test('existing scope directories must remain private before storing policy or state',async t=>{
 const { openStore }=await import('../../bin/claude-context/store.mjs');
 const dir=await fixture(t),scope={profile:'p',studio:'s'},store=await openStore(dir,scope);
 await chmod(store.dir,0o755);
 await assert.rejects(openStore(dir,scope),/private/);
});

test('state file symlinks are rejected rather than read across conversations', async t => {
  const { openStore } = await import('../../bin/claude-context/store.mjs');
  const dir=await fixture(t), store=await openStore(dir,{profile:'p',studio:'s'});
  await symlink('/etc/passwd',store.file('checkpoint'));
  await assert.rejects(store.read('checkpoint'),/symlink/);
});
