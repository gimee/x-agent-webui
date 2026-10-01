#!/usr/bin/env node
// Synthetic protocol fixture: no network access and no model calls.
import { readFileSync, appendFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
const args=process.argv.slice(2), value=k=>args[args.indexOf(k)+1];
const cfg=JSON.parse(readFileSync(process.env.FIXTURE_CONFIG,'utf8'));
if (args.includes('--version')) { process.stdout.write('2.1.281 (Claude Code)\n'); process.exit(0); }
if (args.includes('--help')) { process.stdout.write('--fork-session --no-session-persistence --resume --session-id --tools --strict-mcp-config\n'); process.exit(0); }
const chunks=[];for await(const b of process.stdin)chunks.push(b);const input=Buffer.concat(chunks).toString('utf8');
const stage=input==='/context'?'context':args.includes('--fork-session')?'summary':'request';
const id=args.includes('--session-id')?value('--session-id'):value('--resume');
const settingsPath=args.includes('--settings')?value('--settings'):null;
const settings=settingsPath?(settingsPath.startsWith('{')?JSON.parse(settingsPath):JSON.parse(readFileSync(settingsPath,'utf8'))):null;
const settingsMode=settingsPath&&!settingsPath.startsWith('{')?statSync(settingsPath).mode&0o777:null;
const settingsDirMode=settingsPath&&!settingsPath.startsWith('{')?statSync(dirname(settingsPath)).mode&0o777:null;
// hermes-v051:A hostEnv: wrapper-only variables that must not appear in a native child's env.
appendFileSync(process.env.FIXTURE_LOG,JSON.stringify({stage,args,input,envWindow:process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,envPct:process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE,settings,settingsMode,settingsDirMode,hostEnv:Object.keys(process.env).filter(k=>/^HERMES_CC_(?:SUMMARY|COMPACT)_/.test(k))})+'\n');
const event=x=>process.stdout.write(JSON.stringify(x)+'\n');
const outputId=stage==='request'?id:randomUUID();
event({type:'system',subtype:'init',session_id:outputId});
// Native API error after retries: an assistant error message, then a 'success' result with is_error, exit 1.
if (cfg.apiError===stage) {
 const text='API Error: 502 Bad gateway (fixture). This is a server-side issue, usually temporary — try again in a moment.';
 event({type:'assistant',session_id:outputId,error:'server_error',is_api_error_message:true,message:{id:randomUUID(),role:'assistant',model:'<synthetic>',content:[{type:'text',text}]}});
 event({type:'result',subtype:'success',is_error:true,session_id:outputId,result:text});
 process.exit(1);
}
if (cfg.hang===stage) { for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{appendFileSync(process.env.FIXTURE_LOG,JSON.stringify({signal})+'\n');process.exit(signal==='SIGINT'?130:143);}); setInterval(()=>{},1000);await new Promise(()=>{}); }
if (stage==='context') {
 // hermes-v051:R1-01 cfg.base: non-message context (system prompt, tools), 1000 by default.
 event({type:'assistant',context_usage:{total_tokens:cfg.tokens??410000,categories:[{name:'Messages',tokens:(cfg.tokens??410000)-(cfg.base??1000)}]},session_id:outputId});
} else {
 const content=stage==='summary'?'SYNTHETIC SUMMARY: remember FIXTURE_MARKER.':'SYNTHETIC USER RESPONSE';
 event({type:'assistant',session_id:outputId,message:{id:randomUUID(),role:'assistant',content:[{type:'text',text:content}],usage:{input_tokens:stage==='summary'?400000:78000,cache_creation_input_tokens:7,cache_read_input_tokens:23,output_tokens:20}}});
 if(stage==='request' && !cfg.noTranscript){
  const path=join(process.env.FIXTURE_PROJECT_DIR||process.env.HERMES_CC_PROJECT_DIR,id+'.jsonl');
  const old=existsSync(path)?readFileSync(path,'utf8').trim().split('\n').map(JSON.parse):[];
  const u=randomUUID(),a=randomUUID();
  const msg=args.includes('--input-format')&&value('--input-format')==='stream-json'?JSON.parse(input).message.content:input;
  const rows=[{type:'user',uuid:u,parentUuid:old.at(-1)?.uuid??null,sessionId:id,cwd:process.cwd(),message:{role:'user',content:msg}},{type:'assistant',uuid:a,parentUuid:u,sessionId:id,cwd:process.cwd(),message:{role:'assistant',content}}];
  writeFileSync(path,[...old,...rows].map(JSON.stringify).join('\n')+'\n');
 }
}
if(cfg.corrupt===stage) process.stdout.write('not JSON\n');
if(cfg.nullEvent===stage)process.stdout.write('null\n');
if(stage==='request'&&cfg.sabotageCommit) {
 for(const d of readdirSync(process.env.HERMES_CC_STATE_DIR,{withFileTypes:true}))if(d.isDirectory())mkdirSync(join(process.env.HERMES_CC_STATE_DIR,d.name,'checkpoint.json'));
}
// Background task notification: an extra native turn with its own result in the same process.
if(cfg.extraResult===stage)event({type:'result',subtype:cfg.extraResultError?'error_during_execution':'success',is_error:!!cfg.extraResultError,session_id:outputId,result:'FIRST_TURN_RESULT'});
if(cfg.omitResult!==stage)event({type:'result',subtype:cfg.fail===stage?'error_during_execution':'success',is_error:cfg.fail===stage,session_id:outputId,result:'fixture',usage:{input_tokens:9999999}});
process.exitCode=cfg.fail===stage?1:0;
