import test from 'node:test';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
// hermes-v051:A the flow fixture is shared with aux-summary.test.mjs.
import { fixture, waitStage, native } from './flow-fixture.mjs';

test('concurrent owners are rejected and SIGTERM releases all locks before retry',async t=>{
 const f=await fixture(t,{tokens:410000,hang:'summary'}), before=await readFile(f.source,'utf8');
 const first=f.start(); await waitStage(f,'summary');
 const second=await f.start('concurrent').done;
 assert.notEqual(second.code,0);assert.match(second.stderr,/locked/);
 first.child.kill('SIGTERM');const cancelled=await first.done;
 assert.equal(cancelled.code,143);assert.ok((await f.calls()).some(x=>x.signal==='SIGTERM'));
 assert.equal(await readFile(f.source,'utf8'),before);assert.equal(await f.records('checkpoint'),null);assert.equal(await f.records('pending'),null);
 assert.deepEqual((await readdir(f.state)).filter(x=>x.startsWith('lock-')),[]);
 await f.setScenario({tokens:100000});assert.equal((await f.start('retry after cancellation').done).code,0);
});

test('SIGINT after candidate starts leaves recoverable pending state, never commits or automatically replays',async t=>{
 const f=await fixture(t,{tokens:410000,hang:'request'}), before=await readFile(f.source,'utf8');
 const first=f.start();await waitStage(f,'request');first.child.kill('SIGINT');const cancelled=await first.done;
 assert.equal(cancelled.code,130);assert.ok((await f.calls()).some(x=>x.signal==='SIGINT'));
 assert.ok((await f.records('pending')).candidate);assert.equal(await f.records('checkpoint'),null);
 assert.equal(await readFile(f.source,'utf8'),before);
 const count=(await f.calls()).length;assert.notEqual((await f.start('retry').done).code,0);assert.equal((await f.calls()).length,count);
});

test('new native sessions and later resumes discover their project beneath config projects',async t=>{
 const f=await fixture(t,{tokens:100000});
 const fresh='22222222-2222-4222-8222-222222222222';
 const argv=f.args.map(v=>v==='--resume'?'--session-id':v===native?fresh:v);
 const overrides={HERMES_CC_PROJECT_DIR:''};
 const result=await f.start('new request',overrides,argv).done;
 assert.equal(result.code,0,result.stderr);
 const resume=argv.map(v=>v==='--session-id'?'--resume':v);
 const again=await f.start('resume request',overrides,resume).done;
 assert.equal(again.code,0,again.stderr);
});

test('ordinary small-context turns use fresh native usage without a second CLI startup',async t=>{
 const f=await fixture(t,{tokens:100000});
 const rows=(await readFile(f.source,'utf8')).trim().split('\n').map(JSON.parse);
 rows.at(-1).message.usage={input_tokens:2,cache_creation_input_tokens:1000,cache_read_input_tokens:99000,output_tokens:10};
 await writeFile(f.source,rows.map(JSON.stringify).join('\n')+'\n');
 const result=await f.start('small next input').done;assert.equal(result.code,0,result.stderr);
 assert.deepEqual((await f.calls()).map(c=>c.stage),['request']);
});

test('manual compact uses the host checkpoint even below the automatic trigger and does not send a slash command to an empty successor',async t=>{
 const f=await fixture(t,{tokens:100000});
 const result=await f.start('/compact preserve the regression details').done;
 assert.equal(result.code,0,result.stderr);
 const calls=await f.calls();assert.equal(calls[1].stage,'summary');
 assert.match(calls[1].input,/preserve the regression details/);
 assert.ok(calls[2].args.includes('--session-id'));
 assert.match(calls[2].input,/Context compacted/);
 assert.notEqual(calls[2].input.trim(),'/compact preserve the regression details');
 assert.equal((await f.records('checkpoint')).generation,1);
});

test('image base64 stays a visual block and is not charged as plain-text context',async t=>{
 const f=await fixture(t,{tokens:410000});
 const image={type:'image',source:{type:'base64',media_type:'image/png',data:'B'.repeat(250000)}};
 const input={type:'user',message:{role:'user',content:[{type:'text',text:'inspect image'},image]}};
 const argv=f.args.map(v=>v==='text'?'stream-json':v);
 const result=await f.start(JSON.stringify(input),{},argv).done;assert.equal(result.code,0,result.stderr);
 const actual=JSON.parse((await f.calls()).at(-1).input).message.content;
 assert.deepEqual(actual.at(-1),image);
 assert.ok((await f.records('checkpoint')).retention.currentInputTokens<1000);
});

test('native ownership is bound persistently across Studio/profile scopes',async t=>{
 const f=await fixture(t,{tokens:100000});assert.equal((await f.start().done).code,0);
 const count=(await f.calls()).length;
 for(const overrides of [{HERMES_CC_PROFILE_ID:'other-profile'},{HERMES_STUDIO_SESSION_ID:'other-studio'}]) {
  const out=await f.start('cross-session',overrides).done;assert.notEqual(out.code,0);assert.match(out.stderr,/ownership/);
 }
 assert.equal((await f.calls()).length,count);
});

test('stream-json image input remains one real user message and second compaction omits the prior bootstrap',async t=>{
 const f=await fixture(t,{tokens:410000});
 const message={type:'user',message:{role:'user',content:[{type:'text',text:'IMAGE_QUERY'},{type:'image',source:{type:'base64',media_type:'image/png',data:'fixture-not-an-image'}}]}};
 const argv=f.args.map(v=>v==='text'?'stream-json':v);
 const out=await f.start(JSON.stringify(message)+'\n',{},argv).done;assert.equal(out.code,0,out.stderr);
 const first=(await f.calls()).at(-1);const parsed=JSON.parse(first.input);
 assert.equal(parsed.message.content.filter(b=>b.type==='image').length,1);assert.deepEqual(parsed.message.content.at(-1),message.message.content.at(-1));
 assert.equal(parsed.message.content.filter(b=>b.type==='text'&&b.text.includes('HOST CONTINUATION')).length,1);
 const firstId=(await f.records('checkpoint')).current;
 const second=await f.start('AFTER_SECOND_COMPACTION').done;assert.equal(second.code,0,second.stderr);
 const last=(await f.calls()).at(-1);
 assert.equal((last.input.match(/HOST CONTINUATION/g)??[]).length,1);assert.match(last.input,/IMAGE_QUERY/);
 assert.equal((await f.records('checkpoint')).generation,2);assert.notEqual((await f.records('checkpoint')).current,firstId);
});

test('failed candidate remains journaled; automatic retries of source or candidate do not replay tools; explicit recovery resumes candidate',async t=>{
 const f=await fixture(t,{tokens:410000,fail:'request'});
 const out=await f.start('original').done;assert.notEqual(out.code,0);
 const pending=await f.records('pending');assert.ok(pending?.candidate);assert.equal(await f.records('checkpoint'),null);
 assert.equal(out.stdout.split('\n').filter(Boolean).map(JSON.parse).find(e=>e.subtype!=='host_compaction').session_id,pending.candidate);
 const count=(await f.calls()).length;
 for(const id of [native,pending.candidate]) {
   const argv=f.args.map(v=>v===native?id:v);
   const retry=await f.start('original',{},argv).done;assert.notEqual(retry.code,0);assert.match(retry.stderr,/pending.*candidate/i);
 }
 assert.equal((await f.calls()).length,count);
 await f.setScenario({tokens:80000});
 const argv=f.args.map(v=>v===native?pending.candidate:v);
 const same=await f.start('original',{HERMES_CC_RECOVER_PENDING:'resume'},argv).done;assert.notEqual(same.code,0);assert.equal((await f.calls()).length,count);
 const recovery=await f.start('Inspect previous effects before continuing. Do not repeat completed actions.',{HERMES_CC_RECOVER_PENDING:'resume'},argv).done;
 assert.equal(recovery.code,0,recovery.stderr);
 const last=(await f.calls()).at(-1);assert.ok(last.args.includes('--resume'));assert.equal(last.args[last.args.indexOf('--resume')+1],pending.candidate);assert.doesNotMatch(last.input,/HOST CONTINUATION/);
 assert.equal((await f.records('checkpoint')).current,pending.candidate);assert.equal(await f.records('pending'),null);
});

test('every failed recovery instruction is durable and cannot be replayed',async t=>{
 const f=await fixture(t,{tokens:410000,fail:'request'});
 await f.start('request A').done;
 const first=await f.records('pending'), argv=f.args.map(v=>v===native?first.candidate:v);
 const recoveryEnv={HERMES_CC_RECOVER_PENDING:'resume'};
 assert.notEqual((await f.start('recovery B',recoveryEnv,argv).done).code,0);
 const count=(await f.calls()).length;
 for(const input of ['request A','recovery B']) {
  const retry=await f.start(input,recoveryEnv,argv).done;
  assert.notEqual(retry.code,0);assert.match(retry.stderr,/replay/);
  assert.equal((await f.calls()).length,count,'failed instructions must not execute again');
 }
 const pending=await f.records('pending');
 assert.equal(pending.attempts.length,2);assert.equal(pending.requestHash,pending.attempts.at(-1).requestHash);
 assert.equal(pending.attempts.at(-1).inputIdentity.format,'text');
 await f.setScenario({tokens:80000});
 assert.equal((await f.start('new recovery C',recoveryEnv,argv).done).code,0);
 assert.equal(await f.records('pending'),null);
});

test('ordinary request failures have durable pending before the child starts',async t=>{
 const f=await fixture(t,{tokens:100000,hang:'request'});
 const first=f.start('ordinary A');await waitStage(f,'request');
 const pending=await f.records('pending');
 first.child.kill('SIGTERM');await first.done;
 assert.equal(pending?.candidate,native);assert.equal(pending?.source,native);
 assert.ok(pending?.requestHash);assert.equal(pending?.attempts.length,1);
 const count=(await f.calls()).length;
 const retry=await f.start('ordinary A').done;assert.notEqual(retry.code,0);
 assert.equal((await f.calls()).length,count);
});

for(const scenario of [{noTranscript:true},{sabotageCommit:true},{corrupt:'request'},{nullEvent:'request'},{fail:'request'}])test(`terminal result is withheld when validation or commit fails: ${JSON.stringify(scenario)}`,async t=>{
 const f=await fixture(t,{tokens:410000,...scenario});
 const out=await f.start().done;
 assert.equal(out.code,75,out.stderr);
 const events=out.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
 assert.ok(events.some(e=>e.type==='assistant'),'nonterminal events still stream');
 assert.equal(events.filter(e=>e.type==='result').length,0,'failure exposes diagnostics and exit status, never native terminal success');
 assert.ok(await f.records('pending'));
 assert.deepEqual((await readdir(f.state)).filter(x=>x.startsWith('lock-')),[]);
});

test('explicit abandon archives a missing candidate without replay, then permits a new source instruction',async t=>{
 const f=await fixture(t,{tokens:410000,noTranscript:true,fail:'request'}),before=await readFile(f.source,'utf8');
 await f.start('request A with possible external effects').done;
 const pending=await f.records('pending'),count=(await f.calls()).length;
 const opts={HERMES_CC_ABANDON_PENDING:pending.candidate,HERMES_CC_ABANDON_SOURCE:native};
 const missingGate=await f.start('',{...opts,HERMES_CC_ABANDON_SOURCE:''}).done;
 assert.notEqual(missingGate.code,0);assert.ok(await f.records('pending'));
 const abandoned=await f.start('',opts).done;
 assert.equal(abandoned.code,0,abandoned.stderr);assert.equal(abandoned.stdout,'');
 assert.match(abandoned.stderr,/effects.*not.*rolled back/i);
 assert.equal((await f.calls()).length,count);assert.equal(await f.records('pending'),null);
 assert.equal(await readFile(f.source,'utf8'),before);
 const audit=await f.records(`abandoned-${pending.candidate}`);
 assert.equal(audit.status,'abandoned');assert.equal(audit.source,native);assert.deepEqual(audit.attempts,pending.attempts);
 assert.equal((await f.records('checkpoint')).current,native);
 const cross=await f.start('cross-scope',{HERMES_STUDIO_SESSION_ID:'other-studio'},f.args.map(v=>v===native?pending.candidate:v)).done;
 assert.notEqual(cross.code,0);assert.match(cross.stderr,/ownership/);
 await f.setScenario({tokens:100000});
 const replay=await f.start('request A with possible external effects').done;
 assert.notEqual(replay.code,0);assert.match(replay.stderr,/replay/);assert.equal((await f.calls()).length,count);
 const next=await f.start('new instruction: inspect prior effects first').done;
 assert.equal(next.code,0,next.stderr);assert.equal((await f.records('checkpoint')).current,native);
 assert.equal((await f.records(`abandoned-${pending.candidate}`)).status,'abandoned');
});

test('abandon rejects mismatched candidate, source and cross-scope requests',async t=>{
 const f=await fixture(t,{tokens:410000,noTranscript:true,fail:'request'});
 await f.start('request A').done;
 const pending=await f.records('pending'),count=(await f.calls()).length;
 for(const overrides of [
  {HERMES_CC_ABANDON_PENDING:native,HERMES_CC_ABANDON_SOURCE:native},
  {HERMES_CC_ABANDON_PENDING:pending.candidate,HERMES_CC_ABANDON_SOURCE:pending.candidate},
  {HERMES_CC_ABANDON_PENDING:pending.candidate,HERMES_CC_ABANDON_SOURCE:native,HERMES_STUDIO_SESSION_ID:'other-studio'},
 ])assert.notEqual((await f.start('',overrides).done).code,0);
 assert.equal((await f.calls()).length,count);assert.deepEqual(await f.records('pending'),pending);
});

test('UTF-8 stdin survives real chunks split inside Chinese and emoji bytes',async t=>{
 const f=await fixture(t,{tokens:100000}),run=f.start(null),input='中文分块🙂保留原文';
 await new Promise(r=>setTimeout(r,150));
 for(const byte of Buffer.from(input)) {run.child.stdin.write(Buffer.from([byte]));await new Promise(r=>setTimeout(r,10));}
 run.child.stdin.end();
 const out=await run.done;assert.equal(out.code,0,out.stderr);
 assert.equal((await f.calls()).at(-1).input,input);
});

for(const signal of ['SIGTERM','SIGINT'])test(`${signal} aborts open stdin and releases locks without running native`,async t=>{
 const f=await fixture(t),run=f.start(null);
 const deadline=Date.now()+5000;
 while(!(await readdir(f.state)).some(n=>n.startsWith('lock-'))) {
  if(Date.now()>deadline)throw new Error('No stdin-stage lock');await new Promise(r=>setTimeout(r,10));
 }
 await new Promise(r=>setTimeout(r,50));
 run.child.stdin.write(Buffer.from([0xe4]));run.child.kill(signal);
 const watchdog=setTimeout(()=>run.child.kill('SIGKILL'),1000);
 const out=await run.done;clearTimeout(watchdog);
 assert.equal(out.code,signal==='SIGINT'?130:143,JSON.stringify(out));
 assert.deepEqual((await readdir(f.state)).filter(x=>x.startsWith('lock-')),[]);
 assert.equal((await f.calls()).length,0);assert.equal(await f.records('pending'),null);
});

test('nonterminal output is live before the request completes',async t=>{
 const f=await fixture(t,{tokens:100000,hang:'request'}), run=f.start();
 let streamed='';run.child.stdout.on('data',b=>streamed+=b);
 await waitStage(f,'request');await new Promise(r=>setTimeout(r,50));
 run.child.kill('SIGTERM');await run.done;
 assert.match(streamed,/"subtype":"init"/);assert.doesNotMatch(streamed,/"type":"result"/);
});

test('success becomes observable only after checkpoint, pending removal and cleanup',async t=>{
 const f=await fixture(t,{tokens:410000}),run=f.start();
 let seen='',verification;
 run.child.stdout.on('data',chunk=>{
  seen+=chunk.toString('utf8');
  if(seen.includes('"type":"result"')&&!verification)verification=(async()=>{
   assert.ok(await f.records('checkpoint'));assert.equal(await f.records('pending'),null);
   assert.deepEqual((await readdir(f.state)).filter(x=>x.startsWith('lock-')),[]);
   for(const d of await readdir(f.state,{withFileTypes:true}))if(d.isDirectory())assert.deepEqual((await readdir(join(f.state,d.name))).filter(n=>n.startsWith('policy-')),[]);
  })();
 });
 const out=await run.done;assert.equal(out.code,0,out.stderr);assert.ok(verification);await verification;
 assert.equal(out.stdout.trim().split('\n').map(JSON.parse).filter(e=>e.type==='result').length,1);
});

test('400K boundary uses read-only fork summary and a new native; second turn never reinjects bootstrap',async t=>{
 const f=await fixture(t,{tokens:410000});const before=await readFile(f.source,'utf8');
 const argv=[...f.args,'--tools','Read','--mcp-config','{"mcpServers":{"fixture":{}}}'];
 const out=await f.start('CURRENT_SECRET_DO_NOT_SUMMARIZE',{},argv).done;
 assert.equal(out.code,0,out.stderr);
 const calls=await f.calls();assert.deepEqual(calls.map(x=>x.stage),['context','summary','request']);
 assert.ok(calls[1].args.includes('--fork-session'));assert.ok(calls[1].args.includes('--no-session-persistence'));
 assert.equal(calls[1].args[calls[1].args.indexOf('--tools')+1],'');
 assert.equal(calls[1].args[calls[1].args.indexOf('--mcp-config')+1],'{"mcpServers":{}}');
 assert.ok(!calls[1].input.includes('CURRENT_SECRET_DO_NOT_SUMMARIZE'));
 assert.match(calls[2].input,/SYNTHETIC SUMMARY/);assert.match(calls[2].input,/CURRENT_SECRET_DO_NOT_SUMMARIZE/);
 assert.equal(await readFile(f.source,'utf8'),before);
 const cp=await f.records('checkpoint');assert.notEqual(cp.current,native);assert.equal(cp.generation,1);assert.equal(cp.usage.latestInputTokens,78030);
 const ev=out.stdout.trim().split('\n').map(JSON.parse);
 // Host-only progress lines come before the successor starts and never carry a native identity.
 const host=ev.filter(e=>e.subtype==='host_compaction');
 assert.deepEqual(host.map(e=>e.status),['started','completed']);
 assert.equal(host[0].pre_tokens,410000);assert.equal(host[1].pre_tokens,410000);
 assert.equal(host[1].post_tokens,cp.retention.estimatedTotalTokens);assert.ok(host[1].post_tokens>0);
 assert.ok(host.every(e=>!('session_id' in e)));
 assert.ok(ev.indexOf(host[1])<ev.findIndex(e=>e.subtype==='init'));
 assert.ok(ev.filter(e=>e.subtype!=='host_compaction').every(e=>e.session_id===cp.current));
 assert.equal(await f.records('pending'),null);
 await f.setScenario({tokens:80000});
 const next=await f.start('NEXT_REQUEST').done;assert.equal(next.code,0,next.stderr);
 const last=(await f.calls()).at(-1);assert.equal(last.input,'NEXT_REQUEST');assert.equal(last.args[last.args.indexOf('--resume')+1],cp.current);
 assert.equal((await f.records('checkpoint')).generation,1);
});

test('memory-first retention carries every user message across generations, archives transcripts and hooks native fallback',async t=>{
 const f=await fixture(t,{tokens:410000});
 // Existing session already compacted natively once: its earliest rule sits before the boundary.
 const rows=[{type:'user',uuid:'u0',parentUuid:null,sessionId:native,message:{role:'user',content:'PRE_NATIVE_RULE 永远不要修改原生 JSONL'}},{type:'assistant',uuid:'a0',parentUuid:'u0',sessionId:native,message:{role:'assistant',content:'ok'}},
  {type:'system',subtype:'compact_boundary',uuid:'cb',parentUuid:null,logicalParentUuid:'a0',sessionId:native},{type:'user',uuid:'s',parentUuid:'cb',sessionId:native,isCompactSummary:true,message:{role:'user',content:'NATIVE_SHORT_SUMMARY'}},
  {type:'user',uuid:'u1',parentUuid:'s',sessionId:native,message:{role:'user',content:'SECOND_USER_MESSAGE 接口保持向后兼容'}},{type:'assistant',uuid:'a1',parentUuid:'u1',sessionId:native,message:{role:'assistant',content:'filler '.repeat(200000)}}];
 // ~1.4MB keeps the fixture's bytes-to-410K-token calibration realistic.
 await writeFile(f.source,rows.map(JSON.stringify).join('\n')+'\n');const before=await readFile(f.source);
 const first=await f.start('GEN1_REQUEST').done;assert.equal(first.code,0,first.stderr);
 let calls=await f.calls();
 assert.match(calls[1].input,/verbatim separately/);assert.doesNotMatch(calls[1].input,/1500 words/);
 const gen1=calls[2].input;
 for(const marker of ['PRE_NATIVE_RULE 永远不要修改原生 JSONL','SECOND_USER_MESSAGE 接口保持向后兼容','SYNTHETIC SUMMARY','GEN1_REQUEST'])assert.ok(gen1.includes(marker),marker);
 assert.doesNotMatch(gen1.split('=== [2/4]')[0],/NATIVE_SHORT_SUMMARY/);
 const cp1=await f.records('checkpoint');
 assert.deepEqual(cp1.ledger.map(e=>e.uuid),['u0','u1']);assert.equal(cp1.archive.length,1);
 assert.deepEqual(await readFile(cp1.archive[0].path),before);assert.equal((await stat(cp1.archive[0].path)).mode&0o777,0o600);
 assert.ok(gen1.includes(cp1.archive[0].path));
 for(const c of calls)assert.match(c.settings.hooks.PreCompact.at(-1).hooks[0].command,/precompact-hook\.mjs'$/);
 const second=await f.start('GEN2_REQUEST').done;assert.equal(second.code,0,second.stderr);
 calls=await f.calls();const gen2=calls.at(-1).input;
 assert.equal((gen2.match(/HOST CONTINUATION/g)??[]).length,1);
 const memory=gen2.split('=== [2/4]')[0];
 for(const marker of ['PRE_NATIVE_RULE','SECOND_USER_MESSAGE','GEN1_REQUEST'])assert.ok(memory.includes(marker),marker);
 assert.ok(memory.indexOf('PRE_NATIVE_RULE')<memory.indexOf('GEN1_REQUEST'));
 const cp2=await f.records('checkpoint');assert.equal(cp2.generation,2);
 assert.equal(cp2.ledger.length,3);assert.equal(cp2.ledger[2].text,'GEN1_REQUEST');
 assert.deepEqual(cp2.archive.map(a=>[a.generation,a.native]),[[0,native],[1,cp1.current]]);
 for(const a of cp2.archive)assert.ok(gen2.includes(a.path));
});

for(const mode of ['inline','file','global'])for(const fail of [false,true])test(`managed policy reaches all children and cleans private overlay: ${mode}, failure=${fail}`,async t=>{
 const f=await fixture(t,{tokens:410000,...(fail?{fail:'request'}:{})});
 const settings={model:'claude-opus-5-5',permissions:{allow:['Read']},hooks:{},env:{CLAUDE_CODE_AUTO_COMPACT_WINDOW:'200000',CLAUDE_AUTOCOMPACT_PCT_OVERRIDE:'50',UNRELATED:'keep'}};
 const text=JSON.stringify(settings),source=mode==='global'?join(f.env.CLAUDE_CONFIG_DIR,'settings.json'):join(f.dir,'settings.json');
 await writeFile(source,text);
 const argv=f.args.filter((_,i)=>i!==f.args.indexOf('--model')&&i!==f.args.indexOf('--model')+1);
 if(mode!=='global')argv.push('--settings',mode==='inline'?text:source);
 const out=await f.start('policy input',{CLAUDE_CODE_AUTO_COMPACT_WINDOW:'1234'},argv).done;
 assert.equal(out.code,fail?75:0,out.stderr);
 const calls=await f.calls();assert.deepEqual(calls.map(x=>x.stage),['context','summary','request']);
 const paths=new Set();
 for(const c of calls) {
  assert.equal(c.envWindow,'600000');assert.equal(c.envPct,'100');
  assert.equal(c.args[c.args.indexOf('--model')+1],'claude-opus-5-5[1m]');
  assert.equal(c.settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,'600000');
  assert.equal(c.settings.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE,'100');
  if(mode!=='global') {assert.deepEqual(c.settings.permissions,settings.permissions);assert.equal(c.settings.env.UNRELATED,'keep');}
  assert.equal(c.settingsMode,0o600);assert.equal(c.settingsDirMode,0o700);
  const path=c.args[c.args.indexOf('--settings')+1];assert.ok(path.startsWith(f.state+'/'));paths.add(path);
 }
 assert.equal(paths.size,1);for(const path of paths)await assert.rejects(readFile(path),{code:'ENOENT'});
 assert.equal(await readFile(source,'utf8'),text);
});

test('background task notification turns (several successful results in one native call) succeed and forward only the final result',async t=>{
 const f=await fixture(t,{tokens:100000,extraResult:'request'});
 const out=await f.start('launch a background agent').done;
 assert.equal(out.code,0,out.stderr);
 const results=out.stdout.trim().split('\n').map(JSON.parse).filter(e=>e.type==='result');
 assert.equal(results.length,1);assert.equal(results[0].result,'fixture');
 assert.equal((await f.records('checkpoint')).current,native);assert.equal(await f.records('pending'),null);
 await f.setScenario({tokens:100000,extraResult:'request',extraResultError:true});
 const bad=await f.start('another request').done;
 assert.notEqual(bad.code,0);assert.match(bad.stderr,/2 result\(s\)/);
 assert.doesNotMatch(bad.stdout,/"type":"result"/);
});

test('a native API error is named and keeps its text in the failure line',async t=>{
 const f=await fixture(t,{tokens:100000,apiError:'request'});
 const out=await f.start('request during a gateway outage').done;
 assert.equal(out.code,75);
 assert.match(out.stderr,/Native call failed \(1, 1 result\(s\), error\): API Error: 502 Bad gateway \(fixture\)\. This is a server-side issue/);
 const events=out.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
 assert.ok(events.some(e=>e.type==='assistant'&&e.is_api_error_message),'the native API error message still streams');
 assert.equal(events.filter(e=>e.type==='result').length,0);
 assert.ok(await f.records('pending'));
 const fork=await fixture(t,{tokens:410000,apiError:'context'});
 const failed=await fork.start().done;
 assert.equal(failed.code,75);
 assert.match(failed.stderr,/Native call failed \(1, 1 result\(s\), error\): API Error: 502 Bad gateway/);
 assert.deepEqual((await fork.calls()).map(x=>x.stage),['context']);
 assert.equal(await fork.records('pending'),null);
});

test('unsupported model passes exact raw args and env without managed scope',async t=>{
 const f=await fixture(t,{tokens:410000});
 const argv=f.args.map(v=>v==='claude-opus-5-5[1m]'?'unverified-model':v);
 const out=await f.start('unmanaged',{HERMES_CC_PROFILE_ID:'',HERMES_STUDIO_SESSION_ID:'',HERMES_CC_STATE_DIR:'',CLAUDE_CODE_AUTO_COMPACT_WINDOW:'12345'},argv).done;
 assert.equal(out.code,0,out.stderr);
 const calls=await f.calls();assert.equal(calls.length,1);assert.deepEqual(calls[0].args,argv);assert.equal(calls[0].envWindow,'12345');
 assert.equal(await f.records('checkpoint'),null);assert.equal(await f.records('pending'),null);
});

test('missing managed scope never silently executes a verified-model request',async t=>{
 const f=await fixture(t,{tokens:100000});
 const out=await f.start('must not execute',{HERMES_STUDIO_SESSION_ID:''}).done;
 assert.equal(out.code,75);assert.match(out.stderr,/scope/);assert.equal((await f.calls()).length,0);
});

test('disabled policy and unresolved native settings sources stay exact pass-through',async t=>{
 const f=await fixture(t,{tokens:410000});
 await writeFile(join(f.env.CLAUDE_CONFIG_DIR,'settings.json'),JSON.stringify({env:{DISABLE_AUTO_COMPACT:'1'}}));
 const disabled=await f.start('disabled').done;assert.equal(disabled.code,0,disabled.stderr);
 assert.deepEqual((await f.calls()).at(-1).args,f.args);assert.equal((await f.calls()).length,1);
 await writeFile(join(f.env.CLAUDE_CONFIG_DIR,'settings.json'),'{}');
 const argv=f.args.slice(0,-2),unresolved=await f.start('native settings policy',{},argv).done;
 assert.equal(unresolved.code,0,unresolved.stderr);assert.deepEqual((await f.calls()).at(-1).args,argv);assert.equal((await f.calls()).length,2);
 assert.equal(await f.records('checkpoint'),null);
});

test('below threshold forwards only native events, preserves prompt and stores single-call usage',async t=>{
 const f=await fixture(t,{tokens:100000});
 const out=await f.start().done;
 assert.equal(out.code,0,out.stderr);
 const calls=await f.calls();assert.deepEqual(calls.map(x=>x.stage),['context','request']);
 assert.equal(calls[1].input,'current user input');
 const events=out.stdout.trim().split('\n').map(JSON.parse);assert.equal(events[0].session_id,native);
 assert.ok(!events.some(e=>e.subtype==='host_compaction'));
 const cp=await f.records('checkpoint');assert.equal(cp.current,native);assert.equal(cp.usage.latestInputTokens,78030);
});

// hermes-v051:B3 a compaction that fails after it started ends with status failed and a short reason.
test('a failed summary fork reports compaction start then failure, exits 75 and commits nothing',async t=>{
 const f=await fixture(t,{tokens:410000,fail:'summary'}),before=await readFile(f.source,'utf8');
 const out=await f.start().done;
 assert.equal(out.code,75);
 const host=out.stdout.trim().split('\n').filter(Boolean).map(JSON.parse).filter(e=>e.subtype==='host_compaction');
 assert.deepEqual(host.map(e=>e.status),['started','failed']);
 assert.deepEqual(host[1],{type:'system',subtype:'host_compaction',status:'failed',pre_tokens:410000,reason:'summary_failed'});
 assert.deepEqual((await f.calls()).map(x=>x.stage),['context','summary']);
 assert.equal(await f.records('checkpoint'),null);assert.equal(await f.records('pending'),null);
 assert.equal(await readFile(f.source,'utf8'),before);
});

// hermes-v050:S4 snapshot cost: one realpath per distinct transcript cwd, and no second
// read+hash of the source on the cheap path (no fork ran that could have changed it).
const fsCounter=new URL('./fs-counter.mjs',import.meta.url).href;
async function countedTurn(t,rowsFor) {
 const f=await fixture(t,{tokens:100000});
 const rows=rowsFor(f);
 await writeFile(f.source,rows.map(JSON.stringify).join('\n')+'\n');
 const log=join(f.dir,'fs-count.jsonl');
 const out=await f.start('small next input',{NODE_OPTIONS:`--import=${fsCounter}`,FS_COUNT_LOG:log}).done;
 return {f,out,counts:JSON.parse((await readFile(log,'utf8')).trim().split('\n').at(-1))};
}
const cheapUsage={input_tokens:2,cache_creation_input_tokens:1000,cache_read_input_tokens:99000,output_tokens:10};
function longChain(dir,n,cwdFor=()=>dir) {
 const rows=[];
 for(let i=0;i<n;i++)rows.push({type:i%2?'assistant':'user',uuid:`r${i}`,parentUuid:i?`r${i-1}`:null,sessionId:native,cwd:cwdFor(i),message:{role:i%2?'assistant':'user',content:`turn ${i}`}});
 rows.push({type:'assistant',uuid:`r${n}`,parentUuid:`r${n-1}`,sessionId:native,cwd:dir,message:{role:'assistant',content:'done',usage:cheapUsage}});
 return rows;
}

test('snapshot resolves each distinct transcript cwd once instead of once per row',async t=>{
 const {f,out,counts}=await countedTurn(t,f=>longChain(f.dir,3000));
 assert.equal(out.code,0,out.stderr);
 assert.deepEqual((await f.calls()).map(c=>c.stage),['request']);
 // process.cwd() plus the transcript's single cwd; previously 3,001 serial realpath calls
 assert.ok((counts.realpath[f.dir]??0)<=2,JSON.stringify(counts.realpath[f.dir]));
});

test('cheap small-context turns read the source transcript once',async t=>{
 const {f,out,counts}=await countedTurn(t,f=>longChain(f.dir,20));
 assert.equal(out.code,0,out.stderr);
 assert.deepEqual((await f.calls()).map(c=>c.stage),['request']);
 assert.equal(counts.readFile[f.source],1);
});

// hermes-v050:worktree Claude records each row's shell cwd: a Bash `cd` elsewhere (reset
// afterwards) or an entered worktree changes row.cwd without changing the session's
// workspace. Only the session origin binds the transcript to this workspace.
test('rows recorded in another or since-deleted directory keep an owned session resumable',async t=>{
 const other=await mkdtemp(join(tmpdir(),'hermes-claude-wrapper-tests','elsewhere-'));
 t.after(()=>rm(other,{recursive:true,force:true}));
 const {f,out}=await countedTurn(t,f=>longChain(f.dir,12,i=>i===5?other:i===7?join(f.dir,'.claude','worktrees','removed'):i===9?'/nonexistent-hermes-worktree':f.dir));
 assert.equal(out.code,0,out.stderr);
 assert.doesNotMatch(out.stderr,/Native workspace mismatch/);
 assert.deepEqual((await f.calls()).map(c=>c.stage),['request']);
});

test('a native session that started in another workspace is still rejected before any native call',async t=>{
 const other=await mkdtemp(join(tmpdir(),'hermes-claude-wrapper-tests','foreign-'));
 t.after(()=>rm(other,{recursive:true,force:true}));
 const {f,out}=await countedTurn(t,f=>longChain(f.dir,6,i=>i<2?other:f.dir));
 assert.equal(out.code,75);
 assert.match(out.stderr,/Native workspace mismatch/);
 assert.deepEqual(await f.calls(),[]);
 assert.equal(await f.records('checkpoint'),null);
});
