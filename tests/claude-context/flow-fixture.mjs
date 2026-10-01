// Shared wrapper flow fixture (synthetic native CLI, private state, optional fake summary endpoint).
// hermes-v051:A extracted from wrapper.test.mjs so the auxiliary-summary tests reuse the same flow.
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, chmod } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
export const root=fileURLToPath(new URL('../../bin/claude-context/',import.meta.url));
const fixtures=fileURLToPath(new URL('./',import.meta.url));
export const native='11111111-1111-4111-8111-111111111111';
export async function fixture(t,scenario={}) {
 await mkdir(join(tmpdir(),'hermes-claude-wrapper-tests'),{recursive:true}); const dir=await mkdtemp(join(tmpdir(),'hermes-claude-wrapper-tests','flow-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const web=join(dir,'web'),state=join(web,'checkpoints'),config=join(dir,'claude'),project=join(config,'projects','fixture');
 await mkdir(state,{recursive:true});await mkdir(project,{recursive:true});
 const source=join(project,native+'.jsonl');
 await writeFile(source,[{type:'user',uuid:'u',parentUuid:null,sessionId:native,cwd:dir,message:{role:'user',content:'fixture history FIXTURE_MARKER '+('past '.repeat(30000))}},{type:'assistant',uuid:'a',parentUuid:'u',sessionId:native,cwd:dir,message:{role:'assistant',content:'done'}}].map(JSON.stringify).join('\n')+'\n');
 const configFile=join(dir,'scenario.json'),log=join(dir,'calls.jsonl');await writeFile(configFile,JSON.stringify(scenario));
 await chmod(join(fixtures,'fixture-cli.mjs'),0o755);
 const env={...process.env,HERMES_WEB_UI_HOME:web,HERMES_WEBUI_STATE_DIR:web,HERMES_CC_STATE_DIR:state,HERMES_CC_PROJECT_DIR:project,CLAUDE_CONFIG_DIR:config,HERMES_CC_PROFILE_ID:'profile-fixture',HERMES_STUDIO_SESSION_ID:'studio-fixture',HERMES_CC_REAL_BIN:join(fixtures,'fixture-cli.mjs'),FIXTURE_CONFIG:configFile,FIXTURE_LOG:log,FIXTURE_PROJECT_DIR:project};
 const args=['-p','--resume',native,'--model','claude-opus-5-5[1m]','--input-format','text','--output-format','stream-json','--verbose','--setting-sources','user'];
 const start=(input='current user input',overrides={},argv=args)=>{
  const child=spawn(process.execPath,[join(root,'claude-host-wrapper.mjs'),...argv],{cwd:dir,env:{...env,...overrides},stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.stdin.on('error',()=>{});if(input!==null)child.stdin.end(input);
  const done=new Promise(resolve=>child.on('close',(code,signal)=>resolve({code,signal,stdout,stderr})));
  return {child,done};
 };
 const calls=async()=>{try{return (await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);}catch(e){if(e.code==='ENOENT')return [];throw e;}};
 const recordPath=async(name)=>{for(const d of await readdir(state,{withFileTypes:true})){if(d.isDirectory()){const path=join(state,d.name,name+'.json');try{await readFile(path);return path;}catch(e){if(e.code!=='ENOENT')throw e;}}}return null;};
 const records=async(name)=>{const path=await recordPath(name);return path?JSON.parse(await readFile(path,'utf8')):null;};
 return {dir,state,project,source,env,args,start,calls,records,recordPath,setScenario:s=>writeFile(configFile,JSON.stringify(s))};
}

export async function waitStage(f, stage) {
 const deadline=Date.now()+5000;
 while(Date.now()<deadline) {if((await f.calls()).some(x=>x.stage===stage))return;await new Promise(r=>setTimeout(r,20));}
 throw new Error(`Fixture did not reach ${stage}`);
}

/**
 * Fake WebUI Claude-context endpoints on loopback. reply(entry, res) answers /summary;
 * settings(entry, res) answers /settings (default 404: the wrapper keeps its launch env).
 */
export async function summaryServer(t, reply, settings=(entry,res)=>json(res,404,{ok:false,reason:'not_found'})) {
 const requests=[],settingsRequests=[];
 const server=createServer((req,res)=>{
  const chunks=[];req.on('data',c=>chunks.push(c));
  req.on('end',()=>{
   const entry={method:req.method,url:req.url,headers:req.headers,body:JSON.parse(Buffer.concat(chunks).toString('utf8')||'null'),closed:false};
   res.on('close',()=>{entry.closed=!res.writableFinished;});
   if(req.url.endsWith('/settings')){settingsRequests.push(entry);settings(entry,res);}
   else {requests.push(entry);reply(entry,res);}
  });
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{server.closeAllConnections?.();server.close(r);}));
 const url=`http://127.0.0.1:${server.address().port}/api/coding-agents/claude-context/summary`;
 return {url,requests,settingsRequests,env:{HERMES_CC_SUMMARY_URL:url,HERMES_CC_SUMMARY_TOKEN:'fixture-summary-token'}};
}
export const json=(res,status,value,headers={})=>{res.writeHead(status,{'content-type':'application/json',...headers});res.end(JSON.stringify(value));};
