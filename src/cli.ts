#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createTask, dataDirectory, loadTask, acceptTask, discardTask, taskChanges, formatDiff } from './workspace.js';
import { DemoProvider, createDemoProject } from './demo.js';
import { OpenAIProvider } from './provider.js';
import { runAgent } from './agent.js';
import { runProcess } from './executor.js';
import { AgentError, message, type ExecutionMode, type Task } from './types.js';

const HELP = `Little Coding Agent v0.5 — 本地编程助手

首次使用：
  npm run ui                         打开浏览器工作台（http://127.0.0.1:4317）
  npm run demo                       无密钥演示（固定脚本，非真实 LLM）
  npm run doctor                     检查模型配置、Node、Git、Docker

真实模型任务：
  npm run agent -- run --project "项目路径" --task "任务目标"
  npm run agent -- run --project "项目路径" --task "任务目标" --execution disabled

查看和审阅：
  npm run agent -- tasks
  npm run agent -- show 任务ID
  npm run agent -- accept 任务ID      冲突检查后写回原项目
  npm run agent -- discard 任务ID     标记丢弃；保留副本与证据

run 选项：
  --model ID                         默认读取 OPENAI_MODEL
  --execution docker|disabled|trusted 默认 docker；trusted 是宿主执行，不是沙箱
  --read-only                       只读工具权限，不修改文件或运行项目检查
  --max-turns N                      默认最多 20 轮
  --max-tokens N                     默认总 token 用量预算 100000
  --max-output-tokens N              默认每轮最多 4000 输出 tokens
  --timeout-seconds N                默认总时限 600 秒

在项目本地 .env 配置 OPENAI_API_KEY 和 OPENAI_MODEL，勿在聊天中提供密钥。
只复制允许的文本文件；真实项目的检查通过 .coding-agent.json 预配置。
所有修改先保存在任务副本，运行结束不会自动覆盖原项目。`;

function numberOption(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new AgentError('INVALID_OPTION', `${name} 必须为正整数。`);
  return parsed;
}
async function printTask(task: Task): Promise<void> {
  const changes = await taskChanges(task);
  console.log(`\n任务 ID：${task.id}\n状态：${task.status}\n验证：${task.verification}\n提供器：${task.provider} / ${task.model}\n执行模式：${task.execution}\n修改文件：${changes.length}\n任务目录：${task.directory}\n报告：${path.join(task.directory, 'report.md')}`);
  if (task.error) console.log(`停止原因：${task.error}`);
  if (task.summary) console.log(`\n${task.summary}`);
  if (changes.length) console.log(`\n${formatDiff(changes)}`);
  if (!['accepted', 'discarded'].includes(task.status)) console.log(`审阅后接受：npm run agent -- accept ${task.id}\n丢弃本次修改：npm run agent -- discard ${task.id}`);
}
export async function main(argv = process.argv.slice(2)): Promise<number> {
  try { process.loadEnvFile(path.resolve('.env')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const parsed = parseArgs({ args: argv, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, project: { type: 'string' }, task: { type: 'string' }, model: { type: 'string' },
    execution: { type: 'string' }, 'read-only': { type: 'boolean' }, 'max-turns': { type: 'string' }, 'max-tokens': { type: 'string' }, 'max-output-tokens': { type: 'string' }, 'timeout-seconds': { type: 'string' }
  } });
  const [command, id] = parsed.positionals;
  const values = parsed.values;
  if (!command || values.help) { console.log(HELP); return 0; }
  if (command === 'doctor') {
    const signal = AbortSignal.timeout(10000);
    const git = await runProcess('git', ['--version'], process.cwd(), 5000, signal);
    const docker = await runProcess('docker', ['version', '--format', '{{.Server.Version}}'], process.cwd(), 5000, signal);
    console.log(`Node：${process.version}\nGit：${git.status === 'passed' ? git.output.trim() : '不可用'}\nDocker：${docker.status === 'passed' ? docker.output.trim() : '不可用（真实项目默认检查无法运行）'}\nAPI Key：${process.env.OPENAI_API_KEY ? '已配置（未发起请求）' : '未配置'}\n模型：${process.env.OPENAI_MODEL || '未配置'}\n任务数据：${dataDirectory()}\n下一步：npm run demo，或配置 .env 后运行真实任务。`);
    return 0;
  }
  if (command === 'tasks') {
    const directory = path.join(dataDirectory(), 'tasks');
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { console.log('还没有任务。运行 npm run demo 开始。'); return 0; } throw error; }
    for (const entry of entries.filter(entry => entry.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
      const task = await loadTask(entry.name);
      console.log(`${task.id}  ${task.status}  ${task.verification}  ${task.provider}  ${task.goal.slice(0, 70)}`);
    }
    return 0;
  }
  if (['show', 'accept', 'discard'].includes(command)) {
    if (!id) throw new AgentError('MISSING_ID', '请提供任务 ID；可以运行 npm run agent -- tasks 查看。');
    const task = await loadTask(id);
    if (command === 'accept') console.log(`已接受 ${await acceptTask(task)} 个文件的修改。`);
    else if (command === 'discard') { await discardTask(task); console.log('已标记丢弃；原项目未被本次操作修改，副本与报告保留。'); }
    await printTask(task);
    return 0;
  }
  if (command !== 'run' && command !== 'demo') throw new AgentError('UNKNOWN_COMMAND', `未知命令：${command}。使用 --help 查看。`);
  const mode = values.execution ?? 'docker';
  if (!['docker', 'disabled', 'trusted'].includes(mode)) throw new AgentError('INVALID_EXECUTION', 'execution 必须为 docker、disabled 或 trusted。');
  const budget = { maxTurns: numberOption(values['max-turns'], 20, 'max-turns'), maxTokens: numberOption(values['max-tokens'], 100000, 'max-tokens'), maxOutputTokens: numberOption(values['max-output-tokens'], 4000, 'max-output-tokens'), maxDurationMs: numberOption(values['timeout-seconds'], 600, 'timeout-seconds') * 1000 };
  let task: Task;
  let provider: OpenAIProvider | DemoProvider;
  if (command === 'demo') {
    console.log('演示模式：使用固定脚本代替 LLM；仅运行程序自带的购物车样例测试（宿主执行）。');
    const source = path.join(dataDirectory(), 'demos', randomUUID());
    await createDemoProject(source);
    provider = new DemoProvider();
    task = await createTask({ source, goal: '修复空购物车总价计算错误，保留现有测试。', provider: provider.name, model: provider.model, execution: 'trusted' });
  } else {
    if (!values.project || !values.task?.trim()) throw new AgentError('MISSING_INPUT', 'run 必须提供 --project 和 --task。');
    provider = new OpenAIProvider(values.model || process.env.OPENAI_MODEL || '');
    if (mode === 'trusted') console.log('已显式启用 trusted：项目配置的命令在本机运行，不提供沙箱隔离。');
    task = await createTask({ source: path.resolve(values.project), goal: values.task, provider: provider.name, model: provider.model, execution: mode as ExecutionMode, toolPolicy: values['read-only'] ? 'read_only' : undefined });
    console.log('真实模型模式：相关代码片段会通过 API 发送给模型。');
  }
  console.log(`任务已创建：${task.id}`);
  const controller = new AbortController();
  const interrupt = () => { console.log('\n正在取消任务与检查进程…'); controller.abort(); };
  process.on('SIGINT', interrupt);
  try { await runAgent(task, provider, { ...budget, signal: controller.signal, onProgress: text => console.log(text) }); }
  finally { process.off('SIGINT', interrupt); }
  await printTask(task);
  return task.status === 'review_ready' ? 0 : task.status === 'cancelled' ? 130 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`错误：${message(error).replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[REDACTED]')}`);
    process.exitCode = 1;
  });
}
