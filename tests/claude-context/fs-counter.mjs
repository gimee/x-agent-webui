// Test-only preload (node --import): counts the host wrapper's realpath/readFile calls per path.
// hermes-v050:S4 lets the protocol tests observe snapshot cost without timing assertions.
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
if(process.argv[1]?.endsWith('claude-host-wrapper.mjs')&&process.env.FS_COUNT_LOG) {
 const counts={realpath:{},readFile:{}};
 for(const name of Object.keys(counts)) {
  const original=fsp[name];
  fsp[name]=function(path,...rest){const key=String(path);counts[name][key]=(counts[name][key]??0)+1;return original.call(this,path,...rest);};
 }
 syncBuiltinESMExports();
 process.on('exit',()=>appendFileSync(process.env.FS_COUNT_LOG,JSON.stringify(counts)+'\n'));
}
