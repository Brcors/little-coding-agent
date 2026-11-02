import * as fs from 'node:fs/promises';
import path from 'node:path';
import { AgentError, type Task } from '../types.js';
import { within, writeJson } from '../files.js';
import type { ToolCallRecord } from './contracts.js';

export function redact(text: string): string {
  return text.replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]')
    .replace(/((?:OPENAI_API_KEY|ACCESS_TOKEN|API_KEY|PASSWORD)\s*[=:]\s*["']?)[^\s"'`,;]+/gi, '$1[REDACTED]');
}
export function safeValue(value: unknown, preview = false, depth = 0): unknown {
  if (depth > 12) return '[nested content omitted]';
  if (typeof value === 'string') { const text = redact(value); return preview && text.length > 2000 ? `${text.slice(0, 2000)}… [${text.length} characters]` : text; }
  if (Array.isArray(value)) return (preview ? value.slice(0, 20) : value).map(item => safeValue(item, preview, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, preview ? 40 : 10000).map(([key, item]) => [key, /^(api_key|password|secret|access_token|authorization)$/i.test(key) ? '[REDACTED]' : safeValue(item, preview, depth + 1)]));
  return value;
}
export async function callsDirectory(task: Task) {
  const directory = path.join(task.directory, 'tool-calls');
  await fs.mkdir(directory, { recursive: true });
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !within(await fs.realpath(task.directory), await fs.realpath(directory))) throw new AgentError('PATH_DENIED', '工具记录目录无效。');
  return directory;
}
export const saveCall = async (task: Task, record: ToolCallRecord) => writeJson(path.join(await callsDirectory(task), `${record.id}.json`), record);
export async function readCall(task: Task, id: string): Promise<ToolCallRecord> {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new AgentError('ARTIFACT_NOT_FOUND', '工具记录 ID 无效。');
  try {
    const filename = path.join(await callsDirectory(task), `${id}.json`);
    if ((await fs.lstat(filename)).isSymbolicLink()) throw new AgentError('PATH_DENIED', '不读取链接记录。');
    return JSON.parse(await fs.readFile(filename, 'utf8'));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AgentError('ARTIFACT_NOT_FOUND', '当前任务中找不到这条工具记录。'); throw error; }
}
export async function listCalls(task: Task): Promise<ToolCallRecord[]> {
  let names: string[];
  try { names = await fs.readdir(path.join(task.directory, 'tool-calls')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const records = await Promise.all(names.filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(name => readCall(task, name.slice(0, -5))));
  return records.sort((a, b) => a.started_at.localeCompare(b.started_at));
}
