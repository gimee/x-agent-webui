import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
const path = new URL('../../bin/claude-context/process.mjs', import.meta.url);

test('stdin limit counts raw bytes, not decoded characters',async()=>{
 const { readInput }=await import(path.href);
 await assert.rejects(readInput(Readable.from([Buffer.from('中'),Buffer.from('文')]),{maxBytes:5}),/Input exceeds/);
 assert.equal((await readInput(Readable.from([Buffer.from('中'),Buffer.from('文')]),{maxBytes:6})).toString('utf8'),'中文');
});

test('uncooperative native child is killed before the WebUI 1500ms supervisor deadline', async () => {
  const {runChild}=await import(path.href);
  const controller=new AbortController();let started=0;
  const result=await runChild(process.execPath,['-e','process.on("SIGINT",()=>{});process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},1000)'],{
    input:'',signal:controller.signal,onStdout:()=>{if(!started){started=Date.now();controller.abort('SIGINT');}},
  });
  assert.equal(result.signal,'SIGKILL');
  assert.ok(Date.now()-started<1450,'wrapper must leave time to release locks before its parent sends SIGKILL');
});

test('process adapter preserves byte-for-byte stdio and real exit status without a model', async () => {
  const { runChild } = await import(path.href);
  let stdout = '', stderr = '';
  const result = await runChild(process.execPath, ['-e', 'process.stdin.pipe(process.stdout);process.stderr.write("native diagnostic\\n");process.exitCode=7'], {
    input: '原文\n{"type":"real-fixture"}\n', onStdout: s => { stdout += s; }, onStderr: s => { stderr += s; },
  });
  assert.equal(result.code, 7);
  assert.equal(stdout, '原文\n{"type":"real-fixture"}\n');
  assert.equal(stderr, 'native diagnostic\n');
});
