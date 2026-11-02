import type { z } from 'zod';
import type { Task, ToolResult } from '../types.js';

export type ToolAccess = 'read' | 'write' | 'execute';
export interface ToolContext { task: Task; signal: AbortSignal; notify: (text: string) => void }
export interface ToolSpec {
  name: string;
  title: string;
  category: 'files' | 'edits' | 'checks' | 'evidence';
  access: ToolAccess;
  description: string;
  schema: z.ZodType;
  run: (input: any, context: ToolContext) => Promise<unknown>;
}
export interface ToolCallRecord {
  id: string;
  name: string;
  title: string;
  access: ToolAccess;
  source: 'model' | 'runtime' | 'direct';
  provider_call_id?: string;
  started_at: string;
  completed_at?: string;
  duration_ms?: number;
  status: 'running' | 'succeeded' | 'failed';
  arguments: unknown;
  result?: ToolResult;
}
