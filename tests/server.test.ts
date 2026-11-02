import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createWorkbench } from '../src/server.js';
import { createDemoProject } from '../src/demo.js';
import { loadTask } from '../src/workspace.js';
import { within } from '../src/files.js';
import type { ModelProvider } from '../src/types.js';
import { DEMO_REQUEST } from '../src/analysis.js';

async function setup(t: TestContext, factory?: (model: string) => ModelProvider) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'little-workbench-test-'));
  const dataDir = path.join(root, 'data');
  const webDir = path.join(root, 'web');
  await fs.mkdir(webDir);
  await fs.writeFile(path.join(webDir, 'index.html'), '<h1>Workbench</h1>');
  const app = createWorkbench({ dataDir, webDir, providerFactory: factory });
  const origin = await app.listen(0);
  t.after(async () => {
    await app.close();
    const real = await fs.realpath(root);
    assert.ok(within(await fs.realpath(os.tmpdir()), real) && path.basename(real).startsWith('little-workbench-test-'));
    await fs.rm(real, { recursive: true, force: true });
  });
  const bootstrap = await fetch(`${origin}/api/session`);
  const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!;
  const session = await bootstrap.json() as { csrf: string };
  const headers = { Cookie: cookie, Origin: origin, 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json' };
  const get = (route: string) => fetch(origin + route, { headers: { Cookie: cookie } });
  const post = (route: string, data: unknown = {}) => fetch(origin + route, { method: 'POST', headers, body: JSON.stringify(data) });
  return { root, dataDir, origin, headers, cookie, get, post };
}
async function finished(get: (route: string) => Promise<Response>, id: string) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const value = await (await get(`/api/tasks/${id}`)).json() as any;
    if (value.task && !value.task.active) return value;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('任务未在预期时间完成');
}

test('工作台静态页面与会话可用，未授权请求不能读取本机任务', async t => {
  const { origin, get } = await setup(t);
  const html = await fetch(origin);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /Workbench/);
  assert.match(html.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  assert.equal((await fetch(origin + '/api/tasks')).status, 401);
  assert.equal((await get('/api/tasks')).status, 200);
  assert.equal((await get('/api/tasks/00000000-0000-0000-0000-000000000000')).status, 404);
});

test('跨站请求、错误授权及任意宿主执行模式均被拒绝', async t => {
  const { origin, headers, post } = await setup(t);
  const body = JSON.stringify({ mode: 'demo' });
  assert.equal((await fetch(origin + '/api/tasks', { method: 'POST', headers: { ...headers, Origin: 'https://other.example' }, body })).status, 403);
  assert.equal((await fetch(origin + '/api/tasks', { method: 'POST', headers: { ...headers, 'X-CSRF-Token': 'wrong' }, body })).status, 403);
  assert.equal((await fetch(origin + '/api/tasks', { method: 'POST', headers: { ...headers, 'X-CSRF-Token': 'é'.repeat(64) }, body })).status, 403);
  assert.equal((await fetch(origin + '/api/session', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await post('/api/tasks', { mode: 'openai', execution: 'trusted' })).status, 400);
});

test('网页API可完成演示、查看两次检查日志、下载报告并接受修改', async t => {
  const { dataDir, get, post } = await setup(t);
  const response = await post('/api/tasks', { mode: 'demo' });
  assert.equal(response.status, 201);
  const { task } = await response.json() as any;
  const detail = await finished(get, task.id);
  assert.equal(detail.task.verification, 'passed');
  assert.equal(detail.changes.length, 1);
  const checks = detail.events.filter((event: any) => event.type === 'check.completed');
  assert.deepEqual(checks.map((event: any) => event.data.status), ['failed', 'passed']);
  const log = await get(`/api/tasks/${task.id}/logs/${checks[0].data.log_file}`);
  assert.match((await log.json() as any).text, /Reduce of empty array/);
  assert.equal((await get(`/api/tasks/${task.id}/logs/..%2Ftask.json`)).status, 403);
  const report = await get(`/api/tasks/${task.id}/report`);
  assert.match(report.headers.get('content-disposition')!, /attachment/);
  assert.match(await report.text(), /任务报告/);
  const stored = await loadTask(task.id, dataDir);
  assert.doesNotMatch(await fs.readFile(path.join(stored.source, 'cart.mjs'), 'utf8'), /price, 0/);
  const accepted = await post(`/api/tasks/${task.id}/accept`);
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json() as any).task.status, 'accepted');
  assert.match(await fs.readFile(path.join(stored.source, 'cart.mjs'), 'utf8'), /price, 0/);
  assert.equal((await post(`/api/tasks/${task.id}/accept`)).status, 409);
  assert.equal((await post(`/api/tasks/${task.id}/discard`)).status, 409);
});

test('网页丢弃和源文件冲突都不覆盖原项目', async t => {
  const { dataDir, get, post } = await setup(t);
  const first = await (await post('/api/tasks', { mode: 'demo' })).json() as any;
  const result = await finished(get, first.task.id);
  assert.equal(result.task.status, 'review_ready', result.task.error);
  const stored = await loadTask(first.task.id, dataDir);
  await fs.writeFile(path.join(stored.source, 'cart.mjs'), 'user changed this');
  assert.equal((await post(`/api/tasks/${stored.id}/accept`)).status, 409);
  assert.equal(await fs.readFile(path.join(stored.source, 'cart.mjs'), 'utf8'), 'user changed this');
  const discard = await post(`/api/tasks/${stored.id}/discard`);
  assert.equal((await discard.json() as any).task.status, 'discarded');
  assert.equal(await fs.readFile(path.join(stored.source, 'cart.mjs'), 'utf8'), 'user changed this');
});

test('实时事件流、同时创建保护和取消实际生效', async t => {
  const waiting: ModelProvider = { name: 'test', model: 'waiting-test', async respond(_input, _instructions, _tools, signal) {
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    throw new Error('unreachable');
  } };
  const { root, origin, cookie, get, post } = await setup(t, () => waiting);
  const project = path.join(root, '练习项目');
  await createDemoProject(project);
  const created = await post('/api/tasks', { mode: 'openai', project, goal: 'wait', execution: 'disabled' });
  assert.equal(created.status, 201);
  const { task } = await created.json() as any;
  assert.equal((await post('/api/tasks', { mode: 'demo' })).status, 409);
  const controller = new AbortController();
  const stream = await fetch(`${origin}/api/tasks/${task.id}/stream`, { headers: { Cookie: cookie }, signal: controller.signal });
  assert.match(stream.headers.get('content-type')!, /text\/event-stream/);
  const reader = stream.body!.getReader();
  const chunk = await reader.read();
  assert.match(new TextDecoder().decode(chunk.value), /event: snapshot/);
  controller.abort();
  await reader.cancel().catch(() => {});
  assert.equal((await post(`/api/tasks/${task.id}/cancel`)).status, 202);
  const end = await finished(get, task.id);
  assert.equal(end.task.status, 'cancelled');
  assert.equal((await post(`/api/tasks/${task.id}/cancel`)).status, 409);
});

test('文件夹选择支持中文路径且不返回文件内容', async t => {
  const { root, get } = await setup(t);
  const sub = path.join(root, '中文目录');
  await fs.mkdir(sub);
  await fs.writeFile(path.join(root, 'private.txt'), 'do not return this content');
  const response = await get(`/api/folders?path=${encodeURIComponent(root)}`);
  const result = await response.json() as any;
  assert.equal(result.path, root);
  assert.ok(result.folders.some((item: any) => item.name === '中文目录'));
  assert.doesNotMatch(JSON.stringify(result), /do not return this content|private.txt/);
});

test('解析API先澄清再执行，篡改版本和绕过关键问题均失败', async t => {
  const { dataDir, get, post } = await setup(t);
  const created = await post('/api/analyses', { request: '优化一下', mode: 'rules' });
  assert.equal(created.status, 201);
  const record = (await created.json() as any).analysis;
  assert.equal(record.status, 'needs_clarification');
  assert.equal((await post('/api/tasks', { mode: 'demo', analysis_id: record.id, analysis_revision: 1 })).status, 409);
  assert.equal((await (await get('/api/tasks')).json() as any).tasks.length, 0);
  const questions = record.result.questions;
  const updatedResponse = await post(`/api/analyses/${record.id}/refine`, { revision: 1, answers: Object.fromEntries(questions.map((question: any) => [question.id, question.question.includes('模块') ? '购物车总价计算函数' : '空数组返回 0，保留已有测试'])) });
  assert.equal(updatedResponse.status, 200);
  assert.equal((await updatedResponse.json() as any).analysis.status, 'ready');
  assert.equal((await post('/api/tasks', { mode: 'demo', analysis_id: record.id, analysis_revision: 1 })).status, 409);
  // Rules analysis cannot switch into the unrelated built-in execution demo.
  assert.equal((await post('/api/tasks', { mode: 'demo', analysis_id: record.id, analysis_revision: 2 })).status, 400);
  const history = (await (await get('/api/analyses')).json() as any).analyses;
  assert.equal(history.length, 1);
  assert.equal(history[0].id, record.id);
  await assert.rejects(fs.stat(path.join(dataDir, 'tasks')), { code: 'ENOENT' });
});

test('解析确认后的执行保留原始需求和结构化说明，不能重复创建', async t => {
  const { dataDir, get, post } = await setup(t);
  const parsed = await post('/api/analyses', { request: DEMO_REQUEST, mode: 'demo' });
  const record = (await parsed.json() as any).analysis;
  assert.equal(record.status, 'ready');
  const execute = await post('/api/tasks', { mode: 'demo', analysis_id: record.id, analysis_revision: record.revision });
  assert.equal(execute.status, 201);
  const task = (await execute.json() as any).task;
  assert.equal(task.original_goal, DEMO_REQUEST);
  assert.equal(task.analysis_id, record.id);
  assert.match(task.goal, /验收标准/);
  const end = await finished(get, task.id);
  assert.equal(end.task.verification, 'passed', end.task.error);
  const saved = await loadTask(task.id, dataDir);
  assert.equal(JSON.parse(await fs.readFile(path.join(saved.directory, 'analysis.json'), 'utf8')).original_request, DEMO_REQUEST);
  assert.equal((await post('/api/tasks', { mode: 'demo', analysis_id: record.id, analysis_revision: record.revision })).status, 409);
  const linked = (await (await get(`/api/analyses/${record.id}`)).json() as any).analysis;
  assert.equal(linked.task_id, task.id);
  assert.equal((await post(`/api/analyses/${record.id}/refine`, { revision: record.revision, answers: { q1_0: 'cannot change' } })).status, 409);
});

test('工作台提供真实工具目录和逐调用记录，工具演示完整结束', async t => {
  const { get, post } = await setup(t);
  const catalogue = await (await get('/api/tools')).json() as any;
  assert.equal(catalogue.tools.length, 10);
  assert.ok(catalogue.tools.some((tool: any) => tool.name === 'apply_patch' && tool.access === 'write'));
  assert.equal(catalogue.tools.some((tool: any) => 'run' in tool), false);
  const created = await (await post('/api/tasks', { mode: 'tools_demo' })).json() as any;
  const detail = await finished(get, created.task.id);
  assert.equal(detail.task.verification, 'passed', detail.task.error);
  assert.equal(detail.tool_calls.length, 11);
  assert.equal(detail.tool_calls.some((call: any) => call.name === 'restore_files'), true);
  const call = detail.tool_calls[0];
  assert.equal(call.result.data, undefined);
  const response = await get(`/api/tasks/${created.task.id}/tool-calls/${call.id}`);
  assert.equal(response.status, 200);
  const output = await response.json() as any;
  assert.match(output.output, /cart.mjs/);
  assert.equal(output.record.status, 'succeeded');
  assert.equal((await get(`/api/tasks/${created.task.id}/tool-calls/${call.id}?offset=-1`)).status, 400);
  assert.equal(detail.changes.length, 1);
});
