import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { AnalysisStore, RulesRequirementProvider, OpenAIRequirementProvider, requirementSchema, executionBrief, analysisInputSchema, DEMO_REQUEST } from '../src/analysis.js';
import { within } from '../src/files.js';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'little-analysis-test-'));
  t.after(async () => {
    const real = await fs.realpath(root);
    assert.ok(within(await fs.realpath(os.tmpdir()), real) && path.basename(real).startsWith('little-analysis-test-'));
    await fs.rm(real, { recursive: true, force: true });
  });
  return { root, store: new AnalysisStore(root), signal: new AbortController().signal };
}

test('明确需求可得到结构化目标、约束、验收，且不读取或修改项目', async t => {
  const { root, store, signal } = await fixture(t);
  const request = '修复购物车为空时的总价报错，总价应返回 0，保留已有测试';
  const record = await store.create(analysisInputSchema.parse({ request, mode: 'rules', project: path.join(root, 'does-not-exist') }), signal);
  assert.equal(record.status, 'ready');
  assert.equal(record.source, 'rules');
  assert.equal(record.result.intent, 'bug_fix');
  assert.ok(record.result.constraints.includes('保留已有测试'));
  assert.ok(record.result.acceptance_criteria.includes('总价应返回 0'));
  assert.equal(record.original_request, request);
  assert.equal(record.usage.input_tokens, 0);
  await assert.rejects(fs.stat(path.join(root, 'tasks')), { code: 'ENOENT' });
  assert.equal((await store.get(record.id)).revision, 1);
});

test('规则解析区分解释报错、审查与实际修复，不因错误关键词放宽权限', async t => {
  const { store, signal } = await fixture(t);
  for (const [request, intent] of [
    ['解释项目中的计价函数为什么在空购物车时报错，不要修改代码。', 'explain'],
    ['审查计价模块是否存在异常，不要修复代码。', 'review'],
    ['Explain this bug, do not fix the code.', 'explain'],
    ['解释原因并修复空购物车计价报错。', 'bug_fix'],
    ['新增测试覆盖空购物车报错场景。', 'tests']
  ] as const) {
    const record = await store.create(analysisInputSchema.parse({ request, mode: 'rules' }), signal);
    assert.equal(record.result.intent, intent, request);
    const readOnly = intent === 'explain' || intent === 'review';
    assert.equal(record.execution_plan!.recommended_policy, readOnly ? 'read_only' : 'workspace');
    assert.equal(record.execution_plan!.available_tools.includes('replace_text'), !readOnly);
  }
});

test('模糊问题不能执行，补充回答后更新并保留原始需求', async t => {
  const { store, signal } = await fixture(t);
  const record = await store.create(analysisInputSchema.parse({ request: '帮我优化一下', mode: 'rules' }), signal);
  assert.equal(record.status, 'needs_clarification');
  let executed = false;
  await assert.rejects(store.handoff(record.id, 1, async () => { executed = true; throw new Error(); }), /先补充关键问题/);
  assert.equal(executed, false);
  const answers = Object.fromEntries(record.result.questions.map(question => [question.id, question.question.includes('模块') ? '只处理购物车总价计算函数' : '空购物车返回 0，现有测试继续通过']));
  const clarified = await store.refine(record.id, { revision: 1, answers }, signal);
  assert.equal(clarified.status, 'ready');
  assert.equal(clarified.revision, 2);
  assert.equal(clarified.answers.length, 2);
  assert.equal(clarified.original_request, '帮我优化一下');
  assert.match(executionBrief(clarified), /空购物车返回 0/);
  assert.match(executionBrief(clarified), /帮我优化一下/);
  assert.match(executionBrief(clarified), /验收标准/);
});

test('旧版本、伪造问题和空回答不会污染已保存记录', async t => {
  const { store, signal } = await fixture(t);
  const record = await store.create(analysisInputSchema.parse({ request: '优化一下', mode: 'rules' }), signal);
  await assert.rejects(store.refine(record.id, { revision: 9, answers: { q1_0: 'test answer' } }, signal), /解析已更新/);
  await assert.rejects(store.refine(record.id, { revision: 1, answers: { q1_9: 'test answer' } }, signal), /不对应/);
  await assert.rejects(store.refine(record.id, { revision: 1, answers: { q1_0: '' } }, signal));
  const saved = await store.get(record.id);
  assert.equal(saved.revision, 1); assert.deepEqual(saved.answers, []);
});

test('含糊回答仍需补充，后来的明确回答可以解决歧义', async t => {
  const { store, signal } = await fixture(t);
  let record = await store.create(analysisInputSchema.parse({ request: '优化一下', mode: 'rules' }), signal);
  record = await store.refine(record.id, { revision: 1, answers: Object.fromEntries(record.result.questions.map(question => [question.id, question.question.includes('模块') ? '随便' : '空购物车返回 0，已有测试通过'])) }, signal);
  assert.equal(record.status, 'needs_clarification');
  record = await store.refine(record.id, { revision: 2, answers: Object.fromEntries(record.result.questions.map(question => [question.id, '购物车总价计算函数'])) }, signal);
  assert.equal(record.status, 'ready');
  assert.ok(record.answers.length >= 3);
});

test('规则解析不会假装支持任意演示任务，敏感内容被拒绝', async t => {
  const { store, signal } = await fixture(t);
  await assert.rejects(store.create(analysisInputSchema.parse({ request: '随意写个游戏', mode: 'demo' }), signal), /演示模式只处理/);
  await assert.rejects(store.create(analysisInputSchema.parse({ request: `use sk-${'z'.repeat(30)}`, mode: 'rules' }), signal), /疑似密钥/);
  const result = await store.create(analysisInputSchema.parse({ request: DEMO_REQUEST, mode: 'demo' }), signal);
  assert.equal(result.mode, 'demo'); assert.equal(result.source, 'rules');
});

test('schema 拒绝缺少验收条件和越权的额外字段', () => {
  assert.equal(requirementSchema.safeParse({ title: 'invented', ready_to_execute: true }).success, false);
});

test('保留测试不会误判为补测试任务，补充次数有上限', async t => {
  const { store, signal } = await fixture(t);
  const feature = await store.create(analysisInputSchema.parse({ request: '新增购物车折扣功能，保留已有测试', mode: 'rules' }), signal);
  assert.equal(feature.result.intent, 'feature');
  let record = await store.create(analysisInputSchema.parse({ request: '优化一下', mode: 'rules' }), signal);
  for (let i = 0; i < 3; i++) record = await store.refine(record.id, { revision: record.revision, answers: Object.fromEntries(record.result.questions.map(question => [question.id, '不清楚'])) }, signal);
  await assert.rejects(store.refine(record.id, { revision: record.revision, answers: { [record.result.questions[0]!.id]: '具体说明' } }, signal), /三轮补充/);
  assert.equal((await store.get(record.id)).refinement_rounds, 3);
});

test('官方 SDK 验证 Structured Outputs、澄清上下文及拒绝响应', async t => {
  const { signal } = await fixture(t);
  const sample = (await new RulesRequirementProvider().analyse(DEMO_REQUEST, [], signal)).result;
  let count = 0;
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    try {
      count++;
      assert.equal(body.store, false);
      assert.equal(body.tools, undefined);
      assert.equal(body.text.format.type, 'json_schema');
      assert.equal(body.text.format.strict, true);
      assert.equal(body.text.format.schema.additionalProperties, false);
      const input = JSON.parse(body.input[0].content);
      assert.equal(input.original_request, DEMO_REQUEST);
      if (count === 2) assert.equal(input.clarification_answers[0].answer, '空购物车必须返回零');
      const content = count === 3 ? [{ type: 'refusal', refusal: 'not parsed' }] : [{ type: 'output_text', text: JSON.stringify(sample), annotations: [] }];
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: `resp_${count}`, object: 'response', created_at: 1, status: 'completed', model: 'test-model', output: [{ type: 'message', id: `msg_${count}`, role: 'assistant', status: 'completed', content }], usage: { input_tokens: 40, output_tokens: 20 } }));
    } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: { message: String(error) } })); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const provider = new OpenAIRequirementProvider('test-model', { apiKey: 'local-only', baseURL: `http://127.0.0.1:${address.port}/v1` });
  assert.equal((await provider.analyse(DEMO_REQUEST, [], signal)).result.intent, 'bug_fix');
  const followup = await provider.analyse(DEMO_REQUEST, [{ question: '预期结果？', answer: '空购物车必须返回零', required: true }], signal);
  assert.equal(followup.usage.input_tokens, 40);
  await assert.rejects(provider.analyse(DEMO_REQUEST, [], signal), /模型未能解析/);
});
