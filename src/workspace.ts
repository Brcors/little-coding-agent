import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import { z } from 'zod';
import { AgentError, type Task, type SnapshotFile, type Change, type ProjectConfig, type ExecutionMode, type ToolPolicy } from './types.js';
import { exists, hash, listFiles, readText, safePath, within, writeJson, writeText } from './files.js';

const configSchema = z.object({
  checks: z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/), z.object({
    command: z.string().min(1).max(200),
    args: z.array(z.string().max(2000)).max(30),
    timeout_ms: z.number().int().min(100).max(120000).default(30000)
  }).strict()).refine(checks => Object.keys(checks).length <= 10).default({}),
  docker_image: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/).default('node:24-alpine'),
  tool_policy: z.enum(['read_only', 'workspace']).default('workspace')
}).strict();

export function dataDirectory(): string {
  return path.resolve(process.env.CODING_AGENT_DATA_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'LittleCodingAgent'));
}
export async function projectConfig(source: string): Promise<ProjectConfig> {
  const filename = path.join(source, '.coding-agent.json');
  if (!await exists(filename)) return configSchema.parse({});
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new AgentError('CONFIG_INVALID', '项目配置必须是小于 16 KiB 的普通 JSON 文件。');
  return configSchema.parse(JSON.parse(await fs.readFile(filename, 'utf8')));
}
export async function createTask(options: { source: string; goal: string; execution: ExecutionMode; provider: Task['provider']; model: string; dataDir?: string; toolPolicy?: ToolPolicy }): Promise<Task> {
  const source = await fs.realpath(options.source);
  const dataDir = path.resolve(options.dataDir || dataDirectory());
  if (within(source, dataDir)) throw new AgentError('INVALID_DATA_DIR', '任务数据目录必须位于源项目之外，避免递归复制。');
  const config = await projectConfig(source);
  const requestedPolicy = z.enum(['read_only', 'workspace']).parse(options.toolPolicy ?? config.tool_policy ?? 'workspace');
  const toolPolicy = config.tool_policy === 'read_only' || requestedPolicy === 'read_only' ? 'read_only' : 'workspace';
  const files = await listFiles(source);
  const snapshot: Record<string, SnapshotFile> = Object.create(null);
  // Validate all candidate contents before making a task copy.
  for (const relative of files) snapshot[relative] = { content: await readText(source, relative), hash: '' };
  const id = randomUUID();
  const directory = path.join(dataDir, 'tasks', id);
  const workspace = path.join(directory, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  for (const [relative, file] of Object.entries(snapshot)) {
    file.hash = hash(file.content);
    await writeText(workspace, relative, file.content);
  }
  const task: Task = {
    id, source, directory, workspace, goal: options.goal, provider: options.provider, model: options.model,
    execution: options.execution, config, status: 'running', created_at: new Date().toISOString(),
    turns: 0, usage: { input_tokens: 0, output_tokens: 0 }, revision: 0, verification: 'unverified', checks: {}, summary: '', tool_policy: toolPolicy
  };
  await writeJson(path.join(directory, 'baseline.json'), snapshot);
  await saveTask(task);
  return task;
}
export const saveTask = (task: Task) => writeJson(path.join(task.directory, 'task.json'), task);
export async function event(task: Task, type: string, data: unknown): Promise<void> {
  await fs.appendFile(path.join(task.directory, 'events.jsonl'), JSON.stringify({ time: new Date().toISOString(), type, data }) + '\n');
}
export async function loadTask(id: string, dataDir = dataDirectory()): Promise<Task> {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new AgentError('INVALID_TASK', '无效的任务 ID。');
  const directory = path.join(path.resolve(dataDir), 'tasks', id);
  const task: Task = JSON.parse(await fs.readFile(path.join(directory, 'task.json'), 'utf8'));
  if (task.id !== id || path.resolve(task.directory) !== directory || path.resolve(task.workspace) !== path.join(directory, 'workspace')) throw new AgentError('INVALID_TASK', '任务路径与记录不匹配。');
  return task;
}
export async function taskChanges(task: Task): Promise<Change[]> {
  const baseline: Record<string, SnapshotFile> = JSON.parse(await fs.readFile(path.join(task.directory, 'baseline.json'), 'utf8'));
  const current = await listFiles(task.workspace);
  const paths = [...new Set([...Object.keys(baseline), ...current])].sort();
  const changes: Change[] = [];
  for (const relative of paths) {
    const target = await safePath(task.workspace, relative, true);
    const after = await exists(target) ? await readText(task.workspace, relative) : null;
    const before = baseline[relative]?.content ?? null;
    if (before !== after) changes.push({ path: relative, before, after });
  }
  return changes;
}
export function formatDiff(changes: Change[]): string {
  return changes.map(change => createTwoFilesPatch(change.before === null ? '/dev/null' : `a/${change.path}`, change.after === null ? '/dev/null' : `b/${change.path}`, change.before ?? '', change.after ?? '', '', '', { context: 3 })).join('\n');
}
export async function acceptTask(task: Task): Promise<number> {
  if (!['review_ready', 'failed', 'cancelled', 'budget_exhausted'].includes(task.status)) throw new AgentError('TASK_STATE', '此任务当前不能接受。');
  const source = await fs.realpath(task.source);
  if (source !== task.source) throw new AgentError('SOURCE_CHANGED', '源项目真实路径已变化。');
  const changes = await taskChanges(task);
  // Check every file before touching any original file.
  for (const change of changes) {
    const target = await safePath(source, change.path, true);
    const current = await exists(target) ? await readText(source, change.path) : null;
    if (current !== change.before) throw new AgentError('SOURCE_CONFLICT', `源文件已被修改：${change.path}。请手工合并，本次未覆盖任何文件。`);
  }
  const applied: Change[] = [];
  try {
    for (const change of changes) {
      // Recheck immediately before writing to narrow the concurrent-edit window.
      const target = await safePath(source, change.path, true);
      const current = await exists(target) ? await readText(source, change.path) : null;
      if (current !== change.before) throw new AgentError('SOURCE_CONFLICT', `源文件发生并发修改：${change.path}`);
      if (change.after === null) await fs.unlink(target);
      else await writeText(source, change.path, change.after, change.before === null ? null : hash(change.before));
      applied.push(change);
    }
  } catch (error) {
    for (const change of applied.reverse()) {
      const target = await safePath(source, change.path, true);
      const current = await exists(target) ? await readText(source, change.path) : null;
      if (current !== change.after) continue; // Preserve a user's newer edit.
      if (change.before === null) await fs.unlink(target);
      else await writeText(source, change.path, change.before, change.after === null ? null : hash(change.after));
    }
    throw error;
  }
  task.status = 'accepted';
  await saveTask(task);
  await event(task, 'task.accepted', { files: changes.map(change => change.path) });
  return changes.length;
}
export async function discardTask(task: Task): Promise<void> {
  if (task.status === 'running' || task.status === 'accepted') throw new AgentError('TASK_STATE', '运行中或已接受的任务不能丢弃。');
  task.status = 'discarded';
  await saveTask(task);
  await event(task, 'task.discarded', {});
  // Keep the task copy and evidence for audit; no recursive deletion.
}
