import type { SemanticExecution } from './semantic.js';
export type ExecutionMode = 'docker' | 'disabled' | 'trusted';
export type ToolPolicy = 'read_only' | 'workspace';
export type TaskStatus = 'running' | 'review_ready' | 'failed' | 'cancelled' | 'budget_exhausted' | 'accepted' | 'discarded';
export interface Check { command: string; args: string[]; timeout_ms: number }
export interface ProjectConfig { checks: Record<string, Check>; docker_image: string; tool_policy?: ToolPolicy }
export interface SnapshotFile { hash: string; content: string }
export interface Change { path: string; before: string | null; after: string | null }
export interface Task {
  id: string;
  source: string;
  directory: string;
  workspace: string;
  goal: string;
  provider: 'openai' | 'demo' | 'test';
  model: string;
  execution: ExecutionMode;
  config: ProjectConfig;
  status: TaskStatus;
  created_at: string;
  turns: number;
  usage: { input_tokens: number; output_tokens: number };
  revision: number;
  verification: 'passed' | 'failed' | 'unverified';
  checks: Record<string, CheckResult & { revision: number }>;
  summary: string;
  analysis_id?: string;
  original_goal?: string;
  tool_policy?: ToolPolicy;
  semantic?: SemanticExecution;
  error?: string;
}
export interface CheckResult {
  status: 'passed' | 'failed' | 'timeout' | 'cancelled' | 'unavailable';
  exit_code: number | null;
  output: string;
  truncated: boolean;
  duration_ms: number;
  log_file?: string;
}
export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; retryable?: boolean };
  truncated?: boolean;
  artifact_ref?: string;
  meta?: { call_id: string; tool: string; duration_ms: number; revision: number; provider_call_id?: string };
}
export interface ToolCall { name: string; arguments: string; call_id: string }
export interface ModelReply {
  replay: unknown[];
  calls: ToolCall[];
  text: string;
  usage: { input_tokens: number; output_tokens: number };
}
export interface ModelProvider {
  name: Task['provider'];
  model: string;
  respond(input: unknown[], instructions: string, tools: unknown[], signal: AbortSignal, maxOutputTokens: number, options?: { toolChoice?: 'auto' | 'required' }): Promise<ModelReply>;
}
export class AgentError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'AgentError'; }
}
export function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
