import { open, mkdir, lstat, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash } from './core.mjs';

export function inside(root, path) { const rel=relative(root,path); return rel!=='' && !rel.startsWith('..') && !isAbsolute(rel); }
export async function openStore(root, scope) {
  root=await realpath(root);
  const dir=join(root,hash(JSON.stringify(scope)));
  await mkdir(dir,{recursive:true,mode:0o700});
  if ((await lstat(dir)).isSymbolicLink() || !inside(root,await realpath(dir))) throw new Error('State symlink escape');
  const info=await lstat(dir);
  if(!info.isDirectory()||(info.mode&0o077)!==0||(process.getuid&&info.uid!==process.getuid()))throw new Error('State directory must be private and owned by this user');
  const file=name=>join(dir,`${name}.json`);
  async function syncDir() { const h=await open(dir,'r'); try { await h.sync(); } finally { await h.close(); } }
  async function read(name) {
    let text;
    try {
      if ((await lstat(file(name))).isSymbolicLink()) throw new Error('State file symlink rejected');
      text=await readFile(file(name),'utf8');
    } catch(e) { if(e.code==='ENOENT') return null; throw e; }
    const value=JSON.parse(text);
    if (JSON.stringify(value.scope)!==JSON.stringify(scope)) throw new Error('Checkpoint scope mismatch');
    return value;
  }
  async function write(name,value) {
    const temp=file(name)+'.'+randomUUID()+'.tmp';
    const h=await open(temp,'wx',0o600);
    try { await h.writeFile(JSON.stringify(value));await h.sync(); } finally { await h.close(); }
    try { await rename(temp,file(name));await syncDir(); } catch(e) { await unlink(temp).catch(()=>{});throw e; }
  }
  async function remove(name) { await unlink(file(name)).catch(e=>{if(e.code!=='ENOENT')throw e;}); await syncDir(); }
  async function lock(key) {
    // Shared native lock lives above scope directory, so two Studio sessions cannot drive one native ID.
    const path=join(root,`lock-${hash(key==='session'?JSON.stringify(scope):key)}.json`);
    let h;
    try { h=await open(path,'wx',0o600); } catch(e) { if(e.code==='EEXIST') throw new Error('Session locked; stale locks require explicit operator inspection');throw e; }
    try { await h.writeFile(JSON.stringify({pid:process.pid,scope,key}));await h.sync(); } finally { await h.close(); }
    return async()=>{await unlink(path);};
  }
  async function claim(nativeId) {
    const path=join(root,`owner-${hash(`${scope.config}:${nativeId}`)}.json`);
    try {
      const handle=await open(path,'wx',0o600);
      try { await handle.writeFile(JSON.stringify({scope,nativeId})); await handle.sync(); }
      finally { await handle.close(); }
    } catch(error) {
      if(error.code!=='EEXIST')throw error;
      if((await lstat(path)).isSymbolicLink())throw new Error('Native ownership symlink rejected');
      const owner=JSON.parse(await readFile(path,'utf8'));
      if(owner.nativeId!==nativeId||JSON.stringify(owner.scope)!==JSON.stringify(scope))throw new Error('Native ownership belongs to another X-Agent/profile scope');
    }
  }
  return { scope,dir,file,read,write,remove,lock,claim };
}
