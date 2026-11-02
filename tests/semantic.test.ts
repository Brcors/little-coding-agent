import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWorkbench } from '../src/server.js';
import { OpenAIRequirementProvider } from '../src/analysis.js';
import { OpenAIProvider } from '../src/provider.js';
import { attachSemantic } from '../src/semantic.js';
import { createTask, loadTask, taskChanges } from '../src/workspace.js';
import { within } from '../src/files.js';
import { runAgent } from '../src/agent.js';
import { listCalls } from '../src/toolkit/audit.js';
import type { AnalysisRecord, RequirementIntent, RequirementSpec } from '../src/analysis-types.js';
import type { ModelProvider, ModelReply } from '../src/types.js';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'little-semantic-test-'));
  const source = path.join(root, '中文 项目');
  const dataDir = path.join(root, 'data');
  const webDir = path.join(root, 'web');
  await fs.mkdir(source);
  await fs.mkdir(webDir);
  await fs.writeFile(path.join(webDir, 'index.html'), '<h1>Workbench</h1>');
  await fs.writeFile(path.join(source, 'prices.mjs'), 'export const total = prices => prices.reduce((sum, price) => sum + price);\n');
  t.after(async () => {
    const real = await fs.realpath(root);
    assert.ok(within(await fs.realpath(os.tmpdir()), real) && path.basename(real).startsWith('little-semantic-test-'));
    await fs.rm(real, { recursive: true, force: true });
  });
  return { source, dataDir, webDir };
}
function spec(intent: RequirementIntent): RequirementSpec {
  return { title: '总价边界', intent, goal: intent === 'explain' ? '说明空列表计价的现有行为和原因' : '让空列表计价返回零', scope: ['计价边界行为'], out_of_scope: ['界面及支付功能'], constraints: ['保留现有业务接口'], acceptance_criteria: ['明确空列表的行为'], assumptions: ['代码位置需要在项目中确认'], questions: [] };
}
function analysis(intent: RequirementIntent): AnalysisRecord {
  return { id: randomUUID(), revision: 1, original_request: '没有买任何东西的时候也需要一个合理的金额。', project: '', mode: 'openai', execution: 'disabled', source: 'llm', model: 'semantic-parser', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), status: 'ready', result: spec(intent), answers: [], refinement_rounds: 0, usage: { input_tokens: 40, output_tokens: 20 } };
}
function textReply(text = '依据实际代码完成分析。'): ModelReply {
  return { replay: [{ role: 'assistant', content: text }], calls: [], text, usage: { input_tokens: 0, output_tokens: 0 } };
}
function callsReply(turn: number, calls: { name: string; args: unknown }[]): ModelReply {
  return { replay: [], calls: calls.map((call, index) => ({ name: call.name, arguments: JSON.stringify(call.args), call_id: `call_${turn}_${index}` })), text: '', usage: { input_tokens: 0, output_tokens: 0 } };
}
async function modelServer(t: TestContext, handler: (body: any, index: number) => unknown[]) {
  let count = 0;
  const failures: unknown[] = [];
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      assert.equal(request.url, '/v1/responses');
      const output = handler(JSON.parse(Buffer.concat(chunks).toString()), ++count);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: `resp_${count}`, object: 'response', created_at: 1, status: 'completed', model: 'protocol-test', output, usage: { input_tokens: 40, output_tokens: 20 } }));
    } catch (error) {
      failures.push(error);
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: String(error) } }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    assert.deepEqual(failures, [], '本地模型协议服务内的断言必须全部通过');
  });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { baseURL: `http://127.0.0.1:${address.port}/v1`, count: () => count };
}
const messageOutput = (text: string) => ({ type: 'message', id: randomUUID(), role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
const callOutput = (id: string, name: string, args: unknown) => ({ type: 'function_call', id: `fc_${id}`, call_id: id, name, arguments: JSON.stringify(args), status: 'completed' });
function toolResult(body: any, callId: string) {
  const item = body.input.find((item: any) => item.type === 'function_call_output' && item.call_id === callId);
  assert.ok(item, `缺失 function_call_output: ${callId}`);
  return JSON.parse(item.output);
}

for (const intent of ['bug_fix', 'explain'] as const) {
  test(`完整工作台协议：Structured Outputs → ${intent} 语义交接 → Function Calling → 证据与差异`, async t => {
    const { source, dataDir, webDir } = await fixture(t);
    const request = intent === 'explain' ? '什么都没买时为什么金额那里报错？先帮我讲清楚。' : '什么都没买时不该报错，金额应该是零。';
    let executionTurn = 0;
    const mock = await modelServer(t, (body, index) => {
      assert.equal(body.store, false);
      assert.ok(!body.instructions.includes(request), '用户文本不能插入系统指令');
      if (index === 1) {
        assert.equal(body.text.format.type, 'json_schema');
        assert.equal(body.text.format.strict, true);
        assert.equal(JSON.parse(body.input[0].content).original_request, request);
        return [messageOutput(JSON.stringify(spec(intent)))];
      }
      executionTurn++;
      const context = JSON.parse(body.input[0].content);
      assert.equal(context.original_request, request);
      assert.equal(context.intent, intent);
      assert.deepEqual(context.out_of_scope, ['界面及支付功能']);
      assert.deepEqual(context.acceptance_criteria, ['明确空列表的行为']);
      assert.equal(body.parallel_tool_calls, false);
      assert.ok(body.tools.every((tool: any) => tool.strict));
      const canWrite = body.tools.some((tool: any) => tool.name === 'replace_text');
      assert.equal(canWrite, intent === 'bug_fix' && executionTurn > 1);
      if (executionTurn === 1) {
        assert.equal(body.tool_choice, 'required');
        assert.ok(!body.tools.some((tool: any) => tool.name === 'run_check'));
        // Deliberately use a different retrieval path in each scenario.
        return [callOutput('read', intent === 'bug_fix' ? 'read_file' : 'search_text', intent === 'bug_fix' ? { path: 'prices.mjs', start_line: 1, end_line: 50 } : { query: 'reduce', directory: '' })];
      }
      assert.equal(body.tool_choice, 'auto');
      assert.equal(toolResult(body, 'read').ok, true);
      if (executionTurn === 2) {
        if (intent === 'explain') return [callOutput('forged', 'create_file', { path: 'unexpected.txt', content: 'not allowed' })];
        const read = toolResult(body, 'read');
        return [messageOutput('已读取计价实现，接下来给空列表提供初始值。'), callOutput('edit', 'replace_text', { path: 'prices.mjs', expected_sha256: read.data.sha256, old_text: 'sum + price)', new_text: 'sum + price, 0)' })];
      }
      if (executionTurn === 3) {
        const result = toolResult(body, intent === 'explain' ? 'forged' : 'edit');
        assert.equal(intent === 'explain' ? result.error.code : result.ok, intent === 'explain' ? 'PERMISSION_DENIED' : true);
        return [callOutput('diff', 'inspect_diff', {})];
      }
      assert.equal(toolResult(body, 'diff').ok, true);
      return [messageOutput(intent === 'explain' ? 'prices.mjs 的 reduce 缺少初始值，空列表会抛错；没有修改代码。' : '已加入初始值零；执行已禁用，尚未运行测试，请审阅差异。')];
    });
    const app = createWorkbench({ dataDir, webDir, providerFactory: model => new OpenAIProvider(model, { apiKey: 'local-only', baseURL: mock.baseURL, maxRetries: 0 }), analysisProviderFactory: model => new OpenAIRequirementProvider(model, { apiKey: 'local-only', baseURL: mock.baseURL }) });
    const origin = await app.listen(0);
    t.after(() => app.close());
    const sessionResponse = await fetch(`${origin}/api/session`);
    const cookie = sessionResponse.headers.get('set-cookie')!.split(';')[0]!;
    const { csrf } = await sessionResponse.json() as { csrf: string };
    const post = (route: string, data: unknown) => fetch(origin + route, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const parsed = await post('/api/analyses', { request, project: source, mode: 'openai', model: 'semantic-parser', execution: 'disabled' });
    assert.equal(parsed.status, 201);
    const { analysis: record } = await parsed.json() as { analysis: AnalysisRecord };
    assert.equal(record.source, 'llm');
    assert.equal(record.execution_plan!.recommended_policy, intent === 'explain' ? 'read_only' : 'workspace');
    const start = await post('/api/tasks', { mode: 'openai', analysis_id: record.id, analysis_revision: record.revision });
    assert.equal(start.status, 201);
    const { task: created } = await start.json() as any;
    let detail: any;
    const deadline = Date.now() + 10000;
    do {
      detail = await (await fetch(`${origin}/api/tasks/${created.id}`, { headers: { Cookie: cookie } })).json();
      if (!detail.task.active) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    } while (Date.now() < deadline);
    assert.equal(detail.task.active, false);
    assert.equal(detail.task.status, 'review_ready', detail.task.error);
    assert.equal(detail.task.semantic.original_request, request);
    assert.equal(detail.task.semantic.parser_model, 'semantic-parser');
    assert.deepEqual(detail.task.semantic.analysis_usage, { input_tokens: 40, output_tokens: 20 });
    assert.equal(detail.task.semantic.grounded, true);
    assert.equal(detail.task.semantic.evidence_call_ids.length, 1);
    assert.equal(detail.changes.length, intent === 'explain' ? 0 : 1);
    assert.equal(detail.task.verification, 'unverified');
    assert.ok(detail.events.some((event: any) => event.type === 'model.tool_selection' && event.data.phase === 'context'));
    if (intent === 'bug_fix') assert.ok(detail.events.some((event: any) => event.type === 'assistant.message'));
    const persisted = await loadTask(created.id, dataDir);
    assert.deepEqual(persisted.semantic, detail.task.semantic);
    assert.ok((await fs.readFile(path.join(source, 'prices.mjs'), 'utf8')).endsWith('sum + price);\n'), '原项目在接受前保持不变');
    assert.equal(mock.count(), 5);
  });
}

test('无代码证据时保留只读工具；单纯列文件、空搜索和文字完成不能绕过', async t => {
  const { source, dataDir } = await fixture(t);
  const task = await createTask({ source, dataDir, goal: '解释', provider: 'test', model: 'test', execution: 'disabled' });
  attachSemantic(task, analysis('explain'));
  let turn = 0;
  const provider: ModelProvider = { name: 'test', model: 'test', async respond(_input, _instructions, tools, _signal, _max, options) {
    assert.equal(options?.toolChoice, 'required');
    assert.ok(!(tools as any[]).some(tool => tool.name === 'create_file'));
    turn++;
    if (turn === 1) return callsReply(turn, [{ name: 'list_files', args: { directory: '' } }]);
    if (turn === 2) return callsReply(turn, [{ name: 'search_text', args: { query: 'no such text', directory: '' } }]);
    return textReply('已完成。');
  } };
  await runAgent(task, provider);
  assert.equal(task.status, 'failed');
  assert.match(task.error!, /尚未取得项目内容证据/);
  assert.equal(task.semantic!.grounded, false);
  assert.equal(turn, 4);
  assert.deepEqual(await taskChanges(task), []);
});

test('同轮读取与伪造写入不能提前解锁；收到读取结果后的下一轮才能修改', async t => {
  const { source, dataDir } = await fixture(t);
  const task = await createTask({ source, dataDir, goal: '新增说明', provider: 'test', model: 'test', execution: 'disabled' });
  attachSemantic(task, analysis('feature'));
  let turn = 0;
  const provider: ModelProvider = { name: 'test', model: 'test', async respond(input, _instructions, tools, _signal, _max, options) {
    turn++;
    if (turn === 1) {
      assert.equal(options?.toolChoice, 'required');
      return callsReply(turn, [{ name: 'read_file', args: { path: 'prices.mjs', start_line: 1, end_line: 30 } }, { name: 'create_file', args: { path: 'early.md', content: 'must not write' } }]);
    }
    assert.equal(options?.toolChoice, 'auto');
    assert.ok((tools as any[]).some(tool => tool.name === 'create_file'));
    if (turn === 2) {
      const failed = (input as any[]).find(item => item.call_id === 'call_1_1');
      assert.equal(JSON.parse(failed.output).error.code, 'TOOL_NOT_AVAILABLE');
      return callsReply(turn, [{ name: 'create_file', args: { path: 'later.md', content: 'allowed after context' } }]);
    }
    return textReply();
  } };
  await runAgent(task, provider);
  assert.equal(task.status, 'review_ready', task.error);
  assert.deepEqual((await taskChanges(task)).map(change => change.path), ['later.md']);
  assert.equal((await listCalls(task)).filter(call => call.status === 'failed').length, 1);
});

test('空工作区可通过根目录证据开始新增功能', async t => {
  const { source, dataDir } = await fixture(t);
  await fs.unlink(path.join(source, 'prices.mjs'));
  const task = await createTask({ source, dataDir, goal: '创建说明', provider: 'test', model: 'test', execution: 'disabled' });
  attachSemantic(task, analysis('feature'));
  let turn = 0;
  await runAgent(task, { name: 'test', model: 'test', async respond() {
    turn++;
    if (turn === 1) return callsReply(turn, [{ name: 'list_files', args: { directory: '' } }]);
    if (turn === 2) return callsReply(turn, [{ name: 'create_file', args: { path: 'README.md', content: 'new project' } }]);
    return textReply();
  } });
  assert.equal(task.status, 'review_ready', task.error);
  assert.equal(task.semantic!.grounded, true);
  assert.equal((await taskChanges(task)).length, 1);
});

test('任务选项和语义解析都不能放宽项目只读配置；关键澄清未完成禁止交接', async t => {
  const { source, dataDir } = await fixture(t);
  await fs.writeFile(path.join(source, '.coding-agent.json'), JSON.stringify({ tool_policy: 'read_only' }));
  const task = await createTask({ source, dataDir, goal: '修改', provider: 'test', model: 'test', execution: 'disabled', toolPolicy: 'workspace' });
  assert.equal(task.tool_policy, 'read_only');
  const context = attachSemantic(task, analysis('bug_fix'));
  assert.equal(context.policy, 'read_only');
  assert.ok(!context.available_tools.includes('replace_text'));
  const unresolved = analysis('feature');
  unresolved.status = 'needs_clarification';
  unresolved.result.questions.push({ id: 'q1_0', question: '什么结果？', required: true, reason: '未明确', options: [] });
  assert.throws(() => attachSemantic(task, unresolved), /关键需求尚未明确/);
});

test('模型拒绝和工具调用同时出现时，不执行该轮任何操作', async t => {
  const { source, dataDir } = await fixture(t);
  const task = await createTask({ source, dataDir, goal: '拒绝响应', provider: 'openai', model: 'protocol-test', execution: 'disabled' });
  const mock = await modelServer(t, () => [{ type: 'message', id: 'refused', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'cannot comply' }] }, callOutput('forged', 'create_file', { path: 'unexpected.txt', content: 'not allowed' })]);
  await runAgent(task, new OpenAIProvider('protocol-test', { apiKey: 'local-only', baseURL: mock.baseURL, maxRetries: 0 }));
  assert.equal(task.status, 'failed');
  assert.match(task.error!, /模型拒绝/);
  assert.deepEqual(await taskChanges(task), []);
  assert.deepEqual(await listCalls(task), []);
});
