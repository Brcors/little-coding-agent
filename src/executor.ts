import { spawn } from 'node:child_process';
import type { Check, CheckResult, Task } from './types.js';

const OUTPUT_LIMIT = 24000;
function cleanEnvironment(): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP'];
  return Object.fromEntries(allowed.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
}
function terminate(pid: number): void {
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => { try { process.kill(pid); } catch { /* already ended */ } });
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already ended */ } }
  }
}
export async function runProcess(command: string, args: string[], cwd: string, timeout: number, signal: AbortSignal): Promise<CheckResult> {
  const started = Date.now();
  if (signal.aborted) return { status: 'cancelled', output: '', exit_code: null, truncated: false, duration_ms: 0 };
  return new Promise(resolve => {
    let output = '';
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let done = false;
    const child = spawn(command, args, { cwd, env: cleanEnvironment(), shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const append = (text: string) => {
      if (output.length + text.length > OUTPUT_LIMIT) truncated = true;
      output = (output + text).slice(-OUTPUT_LIMIT);
    };
    child.stdout?.setEncoding('utf8').on('data', append);
    child.stderr?.setEncoding('utf8').on('data', append);
    const stop = () => { if (child.pid) terminate(child.pid); };
    const abort = () => { cancelled = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    signal.addEventListener('abort', abort, { once: true });
    const finish = (exitCode: number | null, unavailable = false) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve({ status: cancelled ? 'cancelled' : timedOut ? 'timeout' : unavailable ? 'unavailable' : exitCode === 0 ? 'passed' : 'failed', exit_code: exitCode, output, truncated, duration_ms: Date.now() - started });
    };
    child.on('error', error => { output += `\n无法启动检查程序：${error.message}`; finish(null, true); });
    child.on('close', code => finish(code));
    if (signal.aborted) abort();
  });
}
export async function executeCheck(task: Task, check: Check, signal: AbortSignal): Promise<CheckResult> {
  if (task.execution === 'disabled') return { status: 'unavailable', exit_code: null, output: '执行已禁用；本次检查未验证。可安装 Docker 后使用 --execution docker。', truncated: false, duration_ms: 0 };
  if (task.execution === 'trusted') {
    // This is explicitly opted-in host execution, NOT a sandbox.
    const command = check.command === 'node' ? process.execPath : check.command;
    return runProcess(command, check.args, task.workspace, check.timeout_ms, signal);
  }
  if (task.workspace.includes(',')) return { status: 'unavailable', exit_code: null, output: 'Docker 挂载路径不能包含逗号，请调整数据目录。', truncated: false, duration_ms: 0 };
  const name = `little-agent-${task.id}`;
  const args = ['run', '--rm', '--pull=never', '--name', name, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '256m', '--cpus', '1', '--pids-limit', '64', '--user', '1000:1000', '--tmpfs', '/tmp:rw,nosuid,noexec,size=64m', '--mount', `type=bind,source=${task.workspace},target=/workspace,readonly`, '--workdir', '/workspace', task.config.docker_image, check.command, ...check.args];
  try {
    const result = await runProcess('docker', args, task.workspace, check.timeout_ms, signal);
    if (result.status === 'failed' && ([125, 126, 127].includes(result.exit_code ?? -1) || /cannot connect|error during connect|daemon is not running/i.test(result.output))) result.status = 'unavailable';
    return result;
  }
  finally {
    // Killing the Docker client alone does not guarantee the container stopped.
    await runProcess('docker', ['rm', '--force', name], task.workspace, 5000, new AbortController().signal);
  }
}
