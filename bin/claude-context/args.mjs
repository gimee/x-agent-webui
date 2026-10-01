// Managed mode deliberately supports the WebUI one-shot stdin contract, not arbitrary CLI subcommands.
const scalar=new Set(['--resume','-r','--session-id','--model','--input-format','--output-format','--settings','--setting-sources','--append-system-prompt','--append-system-prompt-file','--system-prompt','--system-prompt-file','--permission-mode','--max-turns','--max-budget-usd','--effort','--agent','--agents','--json-schema','--fallback-model','--permission-prompt-tool','--tools','--autocompact']);
const multi=new Set(['--mcp-config','--add-dir','--allowedTools','--allowed-tools','--disallowedTools','--disallowed-tools','--plugin-dir','--betas']);
const switches=new Set(['-p','--print','--verbose','--include-partial-messages','--include-hook-events','--strict-mcp-config','--dangerously-skip-permissions','--allow-dangerously-skip-permissions','--disable-slash-commands','--no-chrome','--chrome','--bare']);
export function parseArgs(args) {
  const groups=[];
  for(let i=0;i<args.length;i++) {
    const arg=args[i], eq=arg.indexOf('='), key=eq>0?arg.slice(0,eq):arg;
    if(scalar.has(key)||multi.has(key)) {
      let values=[];
      if(eq>0) values=[arg.slice(eq+1)];
      else {
        if(i+1>=args.length || args[i+1].startsWith('--')) throw new Error(`Missing value: ${key}`);
        values.push(args[++i]);
        if(multi.has(key))while(i+1<args.length&&!args[i+1].startsWith('-'))values.push(args[++i]);
      }
      if(groups.some(g=>g[0]===key))throw new Error(`Duplicate option: ${key}`);
      groups.push([key,...values]);
    } else if(switches.has(arg)) groups.push([arg]);
    else throw new Error(`Unsupported managed argument ${arg}; use one-shot stdin, not positional prompts or control commands`);
  }
  const get=key=>groups.find(g=>g[0]===key)?.[1];
  const ids=[get('--resume'),get('-r'),get('--session-id')].filter(x=>x!==undefined);
  if(ids.length!==1||!uuid(ids[0]))throw new Error('Exactly one native UUID (--resume or --session-id) required');
  if(get('--output-format')!=='stream-json'||!groups.some(g=>g[0]==='--verbose'))throw new Error('Managed mode requires verbose stream-json output');
  const inputFormat=get('--input-format')??'text';
  if(!['text','stream-json'].includes(inputFormat))throw new Error('Unsupported input format');
  const remove=new Set(['--resume','-r','--session-id']);
  return {raw:[...args],nativeId:ids[0],resume:!get('--session-id'),inputFormat,groups,base:groups.filter(g=>!remove.has(g[0])).flat(),get};
}
export function uuid(s){return typeof s==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);}
export function internalArgs(parsed,id) {
  const remove=new Set(['--resume','-r','--session-id','--input-format','--output-format','--tools','--mcp-config','--strict-mcp-config','--max-turns','--json-schema','--include-partial-messages','--include-hook-events']);
  return [...parsed.groups.filter(g=>!remove.has(g[0])).flat(),'--resume',id,'--fork-session','--no-session-persistence','--input-format','text','--output-format','stream-json','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--max-turns','1'];
}
