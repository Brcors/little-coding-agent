import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AgentError, message, type Task, type ToolResult } from './types.js';
import { hash } from './files.js';
import { event, saveTask } from './workspace.js';
import { allowedTool, definitionsFor, findTool } from './toolkit/registry.js';
import { callsDirectory, redact, safeValue, saveCall } from './toolkit/audit.js';
import type { ToolCallRecord } from './toolkit/contracts.js';
export const toolDefinitions = definitionsFor();
const queues = new Map<string, Promise<void>>();
async function serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  queues.set(key, pending);
  await previous;
  try { return await operation(); }
  finally { release(); if (queues.get(key) === pending) queues.delete(key); }
}
export interface CallOptions { providerCallId?: string; source?: ToolCallRecord['source']; allowedTools?: readonly string[] }
export class Tools {
  constructor(public task: Task, private signal: AbortSignal, private notify: (text: string) => void = () => {}) {}
  get definitions() { return definitionsFor(this.task); }
  execute(name: string, raw: unknown, options: CallOptions = {}) { return this.dispatch(name, raw, options); }
  executeJson(name: string, json: string, options: CallOptions = {}) { return this.dispatch(name, json, options, true); }
  private dispatch(name: string, raw: unknown, options: CallOptions, json = false): Promise<ToolResult> {
    return serial(this.task.directory, async () => {
      const started = Date.now();
      const id = randomUUID();
      const spec = findTool(name);
      let parsed = raw;
      let invalidJson = false;
      if (json) { try { parsed = JSON.parse(raw as string); } catch { parsed = { invalid_json: true }; invalidJson = true; } }
      const record: ToolCallRecord = { id, name, title: spec?.title ?? name, access: spec?.access ?? 'read', source: options.source ?? 'direct', provider_call_id: options.providerCallId ? redact(options.providerCallId) : undefined,
        started_at: new Date().toISOString(), status: 'running', arguments: safeValue(parsed, true) };
      await saveCall(this.task, record);
      await event(this.task, 'tool.started', { name, call_id: id, path: parsed && typeof parsed === 'object' && 'path' in parsed ? redact(String(parsed.path)) : undefined });
      let result: ToolResult;
      try {
        if (this.signal.aborted) throw new AgentError('CANCELLED', '任务已停止。');
        if (this.task.status !== 'running') throw new AgentError('TASK_STATE', '任务不在运行中。');
        if (!spec) throw new AgentError('UNKNOWN_TOOL', '工具未注册。');
        if (!allowedTool(spec, this.task)) throw new AgentError('PERMISSION_DENIED', '当前任务权限不允许调用此工具；只读任务不能修改或执行项目代码。');
        if (options.allowedTools && !options.allowedTools.includes(name)) throw new AgentError('TOOL_NOT_AVAILABLE', '此轮尚未提供该工具；请先读取或搜索项目内容，再决定操作。');
        if (invalidJson) throw new AgentError('INVALID_JSON', '工具参数不是有效 JSON。');
        const args = spec.schema.parse(parsed);
        record.arguments = safeValue(args, true);
        if (options.providerCallId) {
          const marker = path.join(await callsDirectory(this.task), `provider-${hash(options.providerCallId)}.lock`);
          try { const file = await fs.open(marker, 'wx'); await file.close(); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AgentError('DUPLICATE_CALL', '重复工具调用 ID，拒绝重新执行。'); throw error; }
        }
        this.notify(`工具：${name}`);
        const data = safeValue(await spec.run(args, { task: this.task, signal: this.signal, notify: this.notify }));
        result = { ok: true, data, truncated: !!(data && typeof data === 'object' && 'truncated' in data && data.truncated) };
      } catch (error) {
        const code = error instanceof AgentError ? error.code : error instanceof z.ZodError ? 'INVALID_ARGUMENTS' : this.signal.aborted ? 'CANCELLED' : (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'NOT_FOUND' : 'TOOL_ERROR';
        result = { ok: false, error: { code, message: error instanceof z.ZodError ? '工具参数不符合声明格式。' : redact(message(error)).slice(0, 500), retryable: ['STALE_CONTENT', 'OUTPUT_NOT_READY'].includes(code) } };
      }
      const serialized = JSON.stringify(result.data);
      if (serialized && serialized.length > 16000) result.truncated = true;
      result.meta = { call_id: id, tool: name, duration_ms: Date.now() - started, revision: this.task.revision, provider_call_id: record.provider_call_id };
      result.artifact_ref = `tool-calls/${id}.json`;
      record.status = result.ok ? 'succeeded' : 'failed'; record.completed_at = new Date().toISOString(); record.duration_ms = result.meta.duration_ms;
      record.result = result;
      await saveTask(this.task);
      await saveCall(this.task, record);
      await event(this.task, 'tool.finished', { name, call_id: id, ok: result.ok, code: result.error?.code, duration_ms: result.meta.duration_ms });
      if (serialized && serialized.length > 16000) return { ...result, truncated: true, data: { ...(result.data && typeof result.data === 'object' ? Object.fromEntries(Object.entries(result.data).filter(([key]) => ['path', 'sha256', 'total_lines', 'next_line'].includes(key))) : {}), truncated: true, preview: serialized.slice(0, 6000), total_characters: serialized.length, hint: '使用 read_tool_output，传入 meta.call_id、offset=0 和 limit=6000 分段读取完整 JSON。' } };
      return result;
    });
  }
}
