import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { runAgent } from './agent.js';
import { OpenAIProvider } from './provider.js';
import { createDemoProject, DemoProvider } from './demo.js';
import { createTask, loadTask, dataDirectory, taskChanges, formatDiff, acceptTask, discardTask, saveTask } from './workspace.js';
import { AgentError, message, type ModelProvider, type Task } from './types.js';
import { AnalysisStore, analysisInputSchema, refinementSchema, executionBrief } from './analysis.js';
import type { AnalysisRecord, RequirementProvider } from './analysis-types.js';
import { toolCatalogue } from './toolkit/registry.js';
import { listCalls, readCall } from './toolkit/audit.js';
import { ToolDemoProvider } from './toolkit/demo.js';
import { attachSemantic } from './semantic.js';

const createSchema = z.object({
  mode: z.enum(['demo', 'openai', 'tools_demo']),
  project: z.string().max(2000).default(''),
  goal: z.string().max(8000).default(''),
  model: z.string().max(200).default(''),
  execution: z.enum(['docker', 'disabled']).default('docker'),
  analysis_id: z.string().uuid().optional(),
  analysis_revision: z.number().int().positive().optional()
}).strict();
const scrub = (text: string) => text.replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[REDACTED]');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

export interface WorkbenchOptions {
  dataDir?: string;
  webDir?: string;
  providerFactory?: (model: string) => ModelProvider;
  analysisProviderFactory?: (model: string) => RequirementProvider;
}

export function createWorkbench(options: WorkbenchOptions = {}) {
  const dataDir = path.resolve(options.dataDir ?? dataDirectory());
  const webDir = path.resolve(options.webDir ?? fileURLToPath(new URL('../dist-web/', import.meta.url)));
  const session = randomBytes(32).toString('hex');
  const csrf = randomBytes(32).toString('hex');
  const active = new Map<string, { task: Task; controller: AbortController; done: Promise<void> }>();
  const streams = new Set<ServerResponse>();
  const analysisStore = new AnalysisStore(dataDir, options.analysisProviderFactory);
  const analysisControllers = new Set<AbortController>();
  let creating = false;
  let mutating = false;
  let closing = false;
  let origin = '';
  const validSecret = (value: string | undefined, expected: string) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && timingSafeEqual(Buffer.from(value), Buffer.from(expected));

  function json(response: ServerResponse, code: number, data: unknown) {
    response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(data));
  }
  async function body(request: IncomingMessage): Promise<unknown> {
    if (!request.headers['content-type']?.startsWith('application/json')) throw new AgentError('CONTENT_TYPE', '请求必须使用 JSON。');
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 32768) throw new AgentError('BODY_TOO_LARGE', '请求内容过长。');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new AgentError('INVALID_JSON', '请求内容不是有效 JSON。'); }
  }
  async function taskFor(id: string) { return active.get(id)?.task ?? loadTask(id, dataDir); }
  function publicTask(task: Task) {
    const { id, source, goal, original_goal, analysis_id, provider, model, execution, status, created_at, turns, usage, verification, summary, error, checks, tool_policy, semantic } = task;
    return { id, source, goal, original_goal, analysis_id, provider, model, execution, status, created_at, turns, usage, verification, summary, error, checks, tool_policy: tool_policy ?? 'workspace', semantic, active: active.has(id) };
  }
  async function readEvents(task: Task) {
    let text = '';
    try { text = await fs.readFile(path.join(task.directory, 'events.jsonl'), 'utf8'); } catch (error) { if (!missing(error)) throw error; }
    return text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).slice(-250);
  }
  async function detail(id: string) {
    const task = await taskFor(id);
    const changes = await taskChanges(task);
    return {
      task: publicTask(task), events: await readEvents(task),
      tool_calls: (await listCalls(task)).map(({ result, ...record }) => ({ ...record, result: result ? { ok: result.ok, error: result.error, meta: result.meta, truncated: result.truncated, artifact_ref: result.artifact_ref } : undefined })),
      changes: changes.map(change => {
        const diff = formatDiff([change]);
        const lines = diff.split('\n');
        return { path: change.path, kind: change.before === null ? 'added' : change.after === null ? 'deleted' : 'modified', diff,
          additions: lines.filter(line => line.startsWith('+') && !line.startsWith('+++')).length,
          deletions: lines.filter(line => line.startsWith('-') && !line.startsWith('---')).length };
      })
    };
  }
  async function listing() {
    let entries;
    try { entries = await fs.readdir(path.join(dataDir, 'tasks'), { withFileTypes: true }); }
    catch (error) { if (missing(error)) return []; throw error; }
    const tasks = await Promise.all(entries.filter(entry => entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name)).map(async entry => {
      try { return publicTask(await taskFor(entry.name)); } catch { return null; }
    }));
    return tasks.filter(task => task !== null).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  async function create(input: z.infer<typeof createSchema>) {
    if (closing || creating || active.size) throw new AgentError('BUSY', '已有任务在执行，完成或停止后再创建新任务。');
    creating = true;
    try {
      let provider: ModelProvider;
      const prepare = async (analysis?: AnalysisRecord) => {
      let source: string;
      let goal: string;
      const mode = analysis ? analysis.mode === 'demo' ? 'demo' : 'openai' : input.mode;
      const project = analysis?.project ?? input.project;
      const model = analysis?.mode === 'openai' ? analysis.model : input.model || process.env.OPENAI_MODEL || '';
      if (mode === 'demo' || mode === 'tools_demo') {
        source = path.join(dataDir, 'demos', randomUUID());
        await createDemoProject(source);
        provider = mode === 'tools_demo' ? new ToolDemoProvider() : new DemoProvider();
        goal = analysis ? executionBrief(analysis) : mode === 'tools_demo' ? '体验工具层：搜索、读取、多文件补丁、恢复、检查与调用记录。' : '修复空购物车总价计算错误，保留现有测试。';
      } else {
        if (!project.trim() || !analysis && !input.goal.trim()) throw new AgentError('MISSING_INPUT', '请选择项目并描述任务。');
        source = path.resolve(project);
        goal = analysis ? executionBrief(analysis) : input.goal.trim();
        provider = options.providerFactory?.(model) ?? new OpenAIProvider(model);
      }
      const task = await createTask({ source, dataDir, goal, provider: provider.name, model: provider.model, execution: mode === 'demo' || mode === 'tools_demo' ? 'trusted' : analysis?.execution ?? input.execution });
      if (analysis) {
        task.analysis_id = analysis.id; task.original_goal = analysis.original_request;
        attachSemantic(task, analysis);
        await fs.writeFile(path.join(task.directory, 'analysis.json'), JSON.stringify(analysis, null, 2));
        await saveTask(task);
      }
      return task;
      };
      const task = input.analysis_id ? await analysisStore.handoff(input.analysis_id, input.analysis_revision, prepare) : await prepare();
      const controller = new AbortController();
      const entry = { task, controller, done: Promise.resolve() };
      active.set(task.id, entry);
      entry.done = runAgent(task, provider!, { signal: controller.signal }).then(() => {}).catch(async error => {
        task.status = 'failed'; task.error = scrub(message(error)); await saveTask(task);
      }).finally(() => active.delete(task.id));
      return publicTask(task);
    } finally { creating = false; }
  }

  async function analyseResponse(response: ServerResponse, operation: (signal: AbortSignal) => Promise<AnalysisRecord>) {
    if (closing) throw new AgentError('BUSY', '工作台正在停止。');
    const controller = new AbortController();
    analysisControllers.add(controller);
    const disconnected = () => { if (!response.writableEnded) controller.abort(); };
    response.once('close', disconnected);
    try { return await operation(AbortSignal.any([controller.signal, AbortSignal.timeout(65000)])); }
    finally { response.off('close', disconnected); analysisControllers.delete(controller); }
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (request.headers.host !== new URL(origin).host) throw new AgentError('FORBIDDEN', '访问地址不匹配。');
      if (request.headers.origin && request.headers.origin !== origin || request.headers['sec-fetch-site'] === 'cross-site') throw new AgentError('FORBIDDEN', '只接受本地工作台的同源请求。');
      const url = new URL(request.url ?? '/', origin);
      const method = request.method ?? 'GET';
      if (url.pathname === '/api/session' && method === 'GET') {
        response.setHeader('Set-Cookie', `little_agent=${session}; HttpOnly; SameSite=Strict; Path=/`);
        json(response, 200, { csrf, configured: !!process.env.OPENAI_API_KEY && !!process.env.OPENAI_MODEL, keyConfigured: !!process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL || '', cwd: process.cwd() });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        response.setHeader('Cache-Control', 'no-store');
        const cookie = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('little_agent='))?.slice('little_agent='.length);
        if (!validSecret(cookie, session)) throw new AgentError('UNAUTHORIZED', '工作台会话已失效，请刷新页面。');
        if (method !== 'GET' && (request.headers.origin !== origin || !validSecret(request.headers['x-csrf-token'] as string | undefined, csrf))) throw new AgentError('FORBIDDEN', '请求缺少工作台授权。');
        if (url.pathname === '/api/tasks' && method === 'GET') { json(response, 200, { tasks: await listing() }); return; }
        if (url.pathname === '/api/tools' && method === 'GET') { json(response, 200, { tools: toolCatalogue() }); return; }
        const toolCallMatch = /^\/api\/tasks\/([a-f0-9-]{36})\/tool-calls\/([a-f0-9-]{36})$/.exec(url.pathname);
        if (toolCallMatch && method === 'GET') {
          const record = await readCall(await taskFor(toolCallMatch[1]!), toolCallMatch[2]!);
          const offset = Number(url.searchParams.get('offset') || '0');
          if (!Number.isSafeInteger(offset) || offset < 0) throw new AgentError('INVALID_INPUT', '结果读取位置无效。');
          const text = JSON.stringify(record.result?.data ?? record.result?.error ?? {}, null, 2);
          if (offset > text.length) throw new AgentError('INVALID_INPUT', '结果读取位置超出长度。');
          const { result, ...metadata } = record;
          const end = Math.min(offset + 12000, text.length);
          json(response, 200, { record: { ...metadata, result: result ? { ok: result.ok, error: result.error, meta: result.meta } : null }, output: text.slice(offset, end), next_offset: end < text.length ? end : null }); return;
        }
        if (url.pathname === '/api/tasks' && method === 'POST') { json(response, 201, { task: await create(createSchema.parse(await body(request))) }); return; }
        if (url.pathname === '/api/analyses' && method === 'GET') { json(response, 200, { analyses: await analysisStore.list() }); return; }
        if (url.pathname === '/api/analyses' && method === 'POST') {
          const input = analysisInputSchema.parse(await body(request));
          json(response, 201, { analysis: await analyseResponse(response, signal => analysisStore.create(input, signal)) }); return;
        }
        const analysisMatch = /^\/api\/analyses\/([a-f0-9-]{36})(?:\/(refine))?$/.exec(url.pathname);
        if (analysisMatch && method === 'GET' && !analysisMatch[2]) { json(response, 200, { analysis: await analysisStore.get(analysisMatch[1]!) }); return; }
        if (analysisMatch && method === 'POST' && analysisMatch[2] === 'refine') {
          const input = refinementSchema.parse(await body(request));
          json(response, 200, { analysis: await analyseResponse(response, signal => analysisStore.refine(analysisMatch[1]!, input, signal)) }); return;
        }
        if (url.pathname === '/api/folders' && method === 'GET') {
          const directory = await fs.realpath(url.searchParams.get('path') || process.cwd());
          const entries = await fs.readdir(directory, { withFileTypes: true });
          const folders = entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.') && entry.name !== 'node_modules').sort((a, b) => a.name.localeCompare(b.name));
          json(response, 200, { path: directory, parent: path.dirname(directory), folders: folders.slice(0, 200).map(entry => ({ name: entry.name, path: path.join(directory, entry.name) })), truncated: folders.length > 200 });
          return;
        }
        const match = /^\/api\/tasks\/([a-f0-9-]{36})(?:\/(stream|cancel|accept|discard|report|logs)(?:\/([^/]+))?)?$/.exec(url.pathname);
        if (!match) throw new AgentError('NOT_FOUND', '接口不存在。');
        const id = match[1]!;
        const action = match[2];
        if (!action && method === 'GET') { json(response, 200, await detail(id)); return; }
        if (action === 'stream' && method === 'GET') {
          await taskFor(id);
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
          streams.add(response);
          let polling = false;
          let last = '';
          const send = async () => {
            if (polling || response.destroyed) return;
            polling = true;
            try {
              const snapshot = JSON.stringify(await detail(id));
              if (snapshot !== last) { response.write(`event: snapshot\ndata: ${snapshot}\n\n`); last = snapshot; }
              else response.write(': heartbeat\n\n');
            } catch { response.write('event: unavailable\ndata: {}\n\n'); }
            finally { polling = false; }
          };
          const timer = setInterval(() => void send(), 650);
          response.on('close', () => { clearInterval(timer); streams.delete(response); });
          void send();
          return;
        }
        const task = await taskFor(id);
        if (action === 'report' && method === 'GET') {
          const report = await fs.readFile(path.join(task.directory, 'report.md'));
          response.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="agent-${id.slice(0, 8)}.md"` }); response.end(report); return;
        }
        if (action === 'logs' && method === 'GET') {
          const filename = match[3] ?? '';
          if (!/^check-[a-zA-Z0-9_-]+-[a-f0-9-]{36}\.log$/.test(filename)) throw new AgentError('FORBIDDEN', '日志名称无效。');
          const text = await fs.readFile(path.join(task.directory, filename), 'utf8');
          json(response, 200, { text: scrub(text) }); return;
        }
        if (action === 'cancel' && method === 'POST') {
          const entry = active.get(id);
          if (!entry) throw new AgentError('TASK_STATE', '此任务没有在当前工作台运行。');
          entry.controller.abort(); json(response, 202, { cancelling: true }); return;
        }
        if (['accept', 'discard'].includes(action ?? '') && method === 'POST') {
          if (active.has(id) || task.status === 'running') throw new AgentError('TASK_STATE', '请等待任务停止后再审阅。');
          if (mutating) throw new AgentError('BUSY', '正在保存另一项操作，请稍候。');
          mutating = true;
          try { if (action === 'accept') await acceptTask(task); else await discardTask(task); }
          finally { mutating = false; }
          json(response, 200, await detail(id)); return;
        }
        throw new AgentError('NOT_FOUND', '接口或请求方法不存在。');
      }
      if (method !== 'GET' && method !== 'HEAD') throw new AgentError('NOT_FOUND', '页面不存在。');
      const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      if (requested.includes('..') || requested.includes('\\') || requested.includes('\0')) throw new AgentError('FORBIDDEN', '文件路径无效。');
      const filename = path.resolve(webDir, requested);
      if (!filename.startsWith(webDir + path.sep)) throw new AgentError('FORBIDDEN', '文件路径无效。');
      const bytes = await fs.readFile(filename);
      const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
      response.writeHead(200, { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': requested === 'index.html' ? 'no-cache' : 'public, max-age=3600' });
      response.end(method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      const code = error instanceof AgentError ? error.code : error instanceof z.ZodError ? 'INVALID_INPUT' : missing(error) ? 'NOT_FOUND' : 'SERVER_ERROR';
      const status = code === 'UNAUTHORIZED' ? 401 : code === 'FORBIDDEN' ? 403 : code === 'NOT_FOUND' ? 404 : ['BUSY', 'SOURCE_CONFLICT', 'TASK_STATE', 'ANALYSIS_STALE', 'ANALYSIS_USED', 'NEEDS_CLARIFICATION'].includes(code) ? 409 : code === 'SERVER_ERROR' ? 500 : 400;
      json(response, status, { error: { code, message: error instanceof z.ZodError ? '提交内容不符合格式要求。' : scrub(message(error)).slice(0, 800) } });
    }
  });
  return {
    async listen(port = 4317) {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('无法获取监听地址。');
      origin = `http://127.0.0.1:${address.port}`;
      return origin;
    },
    async close() {
      closing = true;
      for (const controller of analysisControllers) controller.abort();
      for (const entry of active.values()) entry.controller.abort();
      await Promise.allSettled([...active.values()].map(entry => entry.done));
      for (const response of streams) response.end();
      await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); });
    }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.loadEnvFile(path.resolve('.env')); } catch (error) { if (!missing(error)) throw error; }
  const app = createWorkbench();
  const rawPort = process.env.CODING_AGENT_PORT || '4317';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('CODING_AGENT_PORT 必须在 1024–65535 之间。');
  app.listen(port).then(url => console.log(`\nLittle Agent 工作台已启动\n${url}\n\n按 Ctrl+C 停止服务。`)).catch(error => { console.error(`启动失败：${message(error)}`); process.exitCode = 1; });
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; void app.close().then(() => { process.exitCode = 0; }); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
