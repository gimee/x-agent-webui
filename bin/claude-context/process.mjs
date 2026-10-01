import { spawn } from 'node:child_process';

/** Decode only after EOF; abort destroys the reader even while stdin is idle. */
export async function readInput(stream, { signal, maxBytes = 64 * 1024 * 1024 } = {}) {
  if(signal?.aborted)throw new Error('Cancelled');
  const abort=()=>stream.destroy(new Error('Cancelled'));
  signal?.addEventListener('abort',abort,{once:true});
  const chunks=[];let size=0;
  try {
    for await(const chunk of stream) {
      const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
      size+=bytes.length;
      if(size>maxBytes)throw new Error(`Input exceeds ${maxBytes} bytes`);
      chunks.push(bytes);
    }
    if(signal?.aborted)throw new Error('Cancelled');
    return Buffer.concat(chunks,size);
  } finally {signal?.removeEventListener('abort',abort);}
}

/** Argument arrays only. Output callbacks receive the original Buffer bytes. */
export function runChild(command, args, { input, onStdout, onStderr, env = process.env, cwd = process.cwd(), signal, inherit = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let timer;
    const kill = (sig) => {
      try { process.platform === 'win32' ? child.kill(sig) : process.kill(-child.pid, sig); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    };
    const abort = () => { kill(signal?.reason === 'SIGINT' ? 'SIGINT' : 'SIGTERM'); timer = setTimeout(() => kill('SIGKILL'), 1000); timer.unref(); };
    signal?.addEventListener('abort', abort, { once: true });
    child.once('spawn', () => { if (signal?.aborted) abort(); });
    child.once('error', reject);
    child.once('close', (code, sig) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      resolve({ code: code ?? (sig === 'SIGINT' ? 130 : 143), signal: sig });
    });
    if (!inherit) {
      child.stdout.on('data', chunk => onStdout?.(chunk));
      child.stderr.on('data', chunk => onStderr?.(chunk));
      child.stdin.on('error', e => { if (e.code !== 'EPIPE') reject(e); });
      if (input?.pipe) input.pipe(child.stdin);
      else child.stdin.end(input ?? '');
    }
  });
}
