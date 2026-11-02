import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createTask, acceptTask, discardTask, taskChanges, formatDiff } from '../src/workspace.js';
import { createDemoProject, DemoProvider } from '../src/demo.js';
import { readText, writeText, hash, within } from '../src/files.js';
import { Tools } from '../src/tools.js';
import { runProcess } from '../src/executor.js';
import { runAgent } from '../src/agent.js';
import { OpenAIProvider } from '../src/provider.js';
import { type ModelProvider, type ModelReply } from '../src/types.js';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'little-agent-test-'));
  const source = path.join(root, '中文 空格项目');
  const dataDir = path.join(root, 'data');
  await createDemoProject(source);
  t.after(async () => {
    const real = await fs.realpath(root);
    assert.ok(within(await fs.realpath(os.tmpdir()), real));
    assert.ok(path.basename(real).startsWith('little-agent-test-'));
    await fs.rm(real, { recursive: true, force: true });
  });
  const task = await createTask({ source, dataDir, goal: '修复空购物车', provider: 'test', model: 'test', execution: 'trusted' });
  return { root, source, dataDir, task, tools: new Tools(task, new AbortController().signal) };
}
function textReply(text = '完成。'): ModelReply {
  return { replay: [{ role: 'assistant', content: text }], calls: [], text, usage: { input_tokens: 0, output_tokens: 0 } };
}
function provider(respond: ModelProvider['respond']): ModelProvider { return { name: 'test', model: 'test', respond }; }

test('演示完成真实失败→修改→通过，原项目不变，接受后才写回', async t => {
  const { source, task } = await fixture(t);
  const before = await fs.readFile(path.join(source, 'cart.mjs'), 'utf8');
  task.provider = 'demo';
  const result = await runAgent(task, new DemoProvider());
  assert.equal(result.status, 'review_ready');
  assert.equal(result.verification, 'passed');
  assert.equal(result.turns, 7);
  assert.equal(await fs.readFile(path.join(source, 'cart.mjs'), 'utf8'), before);
  assert.equal((await taskChanges(task)).length, 1);
  const events = (await fs.readFile(path.join(task.directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const checks = events.filter(event => event.type === 'check.completed');
  assert.deepEqual(checks.map(event => event.data.status), ['failed', 'passed']);
  assert.notEqual(checks[0].data.log_file, checks[1].data.log_file);
  assert.match(await fs.readFile(path.join(task.directory, checks[0].data.log_file), 'utf8'), /Reduce of empty array/);
  assert.equal(await acceptTask(task), 1);
  assert.match(await fs.readFile(path.join(source, 'cart.mjs'), 'utf8'), /price, 0/);
  assert.equal(task.status, 'accepted');
  await assert.rejects(acceptTask(task), /当前不能接受/);
});

test('只读边界拒绝上级、绝对路径、ADS、Git和秘密文件', async t => {
  const { task, tools } = await fixture(t);
  for (const relative of ['../outside.ts', 'C:\\outside.ts', '/etc/passwd', '\\\\server\\share\\a.ts', 'cart.mjs:stream', '.git/config', '.hidden/new.ts', '.env', 'secret.json', 'src/../cart.mjs', 'CON.ts']) {
    const result = await tools.execute('read_file', { path: relative, start_line: 1, end_line: 10 });
    assert.equal(result.ok, false, relative);
    assert.equal(result.error?.code, 'PATH_DENIED', relative);
  }
  assert.match(await readText(task.workspace, 'cart.mjs'), /export function/);
});

test('创建任务时排除 .env、依赖与配置文件，保留普通源码', async t => {
  const { source, dataDir } = await fixture(t);
  await fs.writeFile(path.join(source, '.env'), 'DO_NOT_COPY=private');
  await fs.mkdir(path.join(source, 'node_modules'));
  await fs.writeFile(path.join(source, 'node_modules', 'a.js'), 'private dependency');
  const task = await createTask({ source, dataDir, goal: 'read', provider: 'test', model: 'test', execution: 'disabled' });
  assert.deepEqual((await fs.readdir(task.workspace)).sort(), ['cart.mjs', 'cart.test.mjs']);
});

test('源码疑似包含真实密钥时拒绝复制', async t => {
  const { source, dataDir } = await fixture(t);
  await fs.writeFile(path.join(source, 'config.js'), `const key = "sk-${'a'.repeat(30)}";`);
  await assert.rejects(createTask({ source, dataDir, goal: 'read', provider: 'test', model: 'test', execution: 'disabled' }), /疑似密钥/);
});

test('任务数据不能放在源项目内部', async t => {
  const { source } = await fixture(t);
  await assert.rejects(createTask({ source, dataDir: path.join(source, 'tasks'), goal: 'x', provider: 'test', model: 'test', execution: 'disabled' }), /源项目之外/);
});

test('符号链接/junction不能逃逸文件范围', async t => {
  const { root, task, tools } = await fixture(t);
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'outside.ts'), 'do not read');
  await fs.symlink(outside, path.join(task.workspace, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await tools.execute('read_file', { path: 'link/outside.ts', start_line: 1, end_line: 10 });
  assert.equal(result.error?.code, 'PATH_DENIED');
  await assert.rejects(writeText(task.workspace, 'link/new.ts', 'no'), /符号链接/);
});

test('旧版本修改和不唯一替换均拒绝，不影响文件内容', async t => {
  const { task, tools } = await fixture(t);
  const content = await readText(task.workspace, 'cart.mjs');
  let result = await tools.execute('replace_text', { path: 'cart.mjs', expected_sha256: '0'.repeat(64), old_text: 'items', new_text: 'wrong' });
  assert.equal(result.error?.code, 'STALE_CONTENT');
  result = await tools.execute('replace_text', { path: 'cart.mjs', expected_sha256: hash(content), old_text: 'items', new_text: 'wrong' });
  assert.equal(result.error?.code, 'AMBIGUOUS_EDIT');
  assert.equal(await readText(task.workspace, 'cart.mjs'), content);
});

test('工具参数严格校验，未知工具与任意检查名被拒绝', async t => {
  const { tools } = await fixture(t);
  assert.equal((await tools.execute('list_files', { directory: '', extra: 1 })).error?.code, 'INVALID_ARGUMENTS');
  assert.equal((await tools.execute('shell', { command: 'anything' })).error?.code, 'UNKNOWN_TOOL');
  assert.equal((await tools.execute('run_check', { name: 'constructor' })).error?.code, 'CHECK_NOT_CONFIGURED');
});

test('新增文件包含在差异中，不能通过 create_file 覆盖', async t => {
  const { task, tools } = await fixture(t);
  assert.equal((await tools.execute('create_file', { path: 'src/new.ts', content: 'export const value = 1;\n' })).ok, true);
  const changes = await taskChanges(task);
  assert.equal(changes[0]?.path, 'src/new.ts');
  assert.match(formatDiff(changes), /\/dev\/null/);
  assert.equal((await tools.execute('create_file', { path: 'src/new.ts', content: 'overwrite' })).error?.code, 'FILE_EXISTS');
});

test('源文件并发改动导致接受失败，所有待写文件均保持原样', async t => {
  const { source, task, tools } = await fixture(t);
  await tools.execute('create_file', { path: 'a-new.ts', content: 'new file' });
  const content = await readText(task.workspace, 'cart.mjs');
  await tools.execute('replace_text', { path: 'cart.mjs', expected_sha256: hash(content), old_text: 'sum + price)', new_text: 'sum + price, 0)' });
  task.status = 'review_ready';
  await fs.writeFile(path.join(source, 'cart.mjs'), 'user new edit');
  await assert.rejects(acceptTask(task), /源文件已被修改/);
  assert.equal(await fs.readFile(path.join(source, 'cart.mjs'), 'utf8'), 'user new edit');
  await assert.rejects(fs.stat(path.join(source, 'a-new.ts')), { code: 'ENOENT' });
});

test('丢弃不会改原项目，且无法再接受', async t => {
  const { task, source, tools } = await fixture(t);
  await tools.execute('create_file', { path: 'new.ts', content: 'test' });
  task.status = 'review_ready';
  await discardTask(task);
  await assert.rejects(acceptTask(task), /当前不能接受/);
  await assert.rejects(fs.stat(path.join(source, 'new.ts')), { code: 'ENOENT' });
});

test('检查进程能识别失败、超时与取消', async t => {
  const { root } = await fixture(t);
  const signal = new AbortController().signal;
  assert.equal((await runProcess(process.execPath, ['-e', 'process.exit(2)'], root, 3000, signal)).status, 'failed');
  assert.equal((await runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], root, 100, signal)).status, 'timeout');
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  assert.equal((await runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], root, 3000, controller.signal)).status, 'cancelled');
});

test('检查输出有大小上限', async t => {
  const { root } = await fixture(t);
  const result = await runProcess(process.execPath, ['-e', "console.log('x'.repeat(100000))"], root, 3000, new AbortController().signal);
  assert.equal(result.status, 'passed');
  assert.equal(result.truncated, true);
  assert.ok(result.output.length <= 24000);
});

test('宿主检查不会继承模型 API Key 等私密环境变量', async t => {
  const { root } = await fixture(t);
  // This checks presence only; no secret value is printed.
  const result = await runProcess(process.execPath, ['-e', "console.log(Boolean(process.env.OPENAI_API_KEY),Boolean(process.env.CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY))"], root, 3000, new AbortController().signal);
  assert.equal(result.output.trim(), 'false false');
});

test('执行禁用时保留差异但不能宣称检查通过', async t => {
  const { task } = await fixture(t);
  task.execution = 'disabled';
  const result = await runAgent(task, new DemoProvider());
  assert.equal(result.status, 'review_ready');
  assert.equal(result.verification, 'unverified');
  assert.equal(result.checks.test?.status, 'unavailable');
});

test('轮数预算耗尽仍保存报告与差异', async t => {
  const { task } = await fixture(t);
  await runAgent(task, new DemoProvider(), { maxTurns: 4 });
  assert.equal(task.status, 'budget_exhausted');
  assert.equal((await taskChanges(task)).length, 1);
  assert.match(await fs.readFile(path.join(task.directory, 'report.md'), 'utf8'), /budget_exhausted/);
});

test('token预算不足时不调用模型', async t => {
  const { task } = await fixture(t);
  let called = false;
  await runAgent(task, provider(async () => { called = true; return textReply(); }), { maxTokens: 1 });
  assert.equal(called, false);
  assert.equal(task.status, 'budget_exhausted');
});

test('重复工具调用ID导致停止，不重放副作用', async t => {
  const { task } = await fixture(t);
  await runAgent(task, provider(async () => ({ replay: [], calls: [{ name: 'create_file', arguments: JSON.stringify({ path: 'one.ts', content: 'one' }), call_id: 'same-id' }], text: '', usage: { input_tokens: 0, output_tokens: 0 } })));
  assert.equal(task.status, 'failed');
  assert.match(task.error!, /重复工具调用/);
  assert.equal((await taskChanges(task)).length, 1);
});

test('用户取消与总时限会停止模型等待', async t => {
  for (const cancel of [true, false]) {
    const { task } = await fixture(t);
    const controller = new AbortController();
    const waiting = provider(async (_input, _instructions, _tools, signal) => {
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      return textReply();
    });
    const timer = cancel ? setTimeout(() => controller.abort(), 100) : undefined;
    await runAgent(task, waiting, { signal: controller.signal, maxDurationMs: cancel ? 3000 : 100 });
    if (timer) clearTimeout(timer);
    assert.equal(task.status, cancel ? 'cancelled' : 'budget_exhausted');
  }
});

test('模型过早结束时运行程序自动检查，失败后要求继续修复', async t => {
  const { task, tools } = await fixture(t);
  await tools.execute('create_file', { path: 'note.md', content: 'changed' });
  let turns = 0;
  await runAgent(task, provider(async input => {
    turns++;
    if (turns > 1) assert.match(JSON.stringify(input.at(-1)), /检查未通过/);
    return textReply('我完成了');
  }), { maxTurns: 2 });
  assert.equal(turns, 2);
  assert.equal(task.verification, 'failed');
  assert.equal(task.status, 'budget_exhausted');
});

test('真实官方SDK通过本地HTTP协议验证工具调用、回传和自动检查', async t => {
  const { task } = await fixture(t);
  const requests: any[] = [];
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);
      assert.equal(request.url, '/v1/responses');
      assert.equal(body.store, false);
      assert.equal(body.parallel_tool_calls, false);
      assert.deepEqual(body.include, ['reasoning.encrypted_content']);
      assert.ok(body.tools.some((tool: any) => tool.name === 'replace_text' && tool.strict));
      let output;
      if (requests.length === 1) {
        output = [{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque-protocol-test' }, { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: JSON.stringify({ path: 'cart.mjs', start_line: 1, end_line: 100 }), status: 'completed' }];
      } else if (requests.length === 2) {
        const result = body.input.find((item: any) => item.type === 'function_call_output' && item.call_id === 'call_1');
        assert.ok(result, 'tool output must preserve call_id');
        assert.ok(body.input.some((item: any) => item.type === 'function_call' && item.call_id === 'call_1'));
        assert.ok(body.input.some((item: any) => item.type === 'reasoning' && item.encrypted_content === 'opaque-protocol-test'));
        output = [{ type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'replace_text', arguments: JSON.stringify({ path: 'cart.mjs', expected_sha256: JSON.parse(result.output).data.sha256, old_text: 'sum + price)', new_text: 'sum + price, 0)' }), status: 'completed' }];
      } else {
        assert.ok(body.input.some((item: any) => item.type === 'function_call_output' && item.call_id === 'call_2'));
        output = [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '已修改，等待审阅。', annotations: [] }] }];
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: `resp_${requests.length}`, object: 'response', created_at: 1, model: 'protocol-test', status: 'completed', output, usage: { input_tokens: 20, output_tokens: 10 } }));
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: String(error) } }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const model = new OpenAIProvider('protocol-test', { apiKey: 'local-placeholder', baseURL: `http://127.0.0.1:${address.port}/v1`, maxRetries: 0 });
  await runAgent(task, model);
  assert.equal(task.status, 'review_ready', task.error);
  assert.equal(task.verification, 'passed');
  assert.equal(requests.length, 3);
  assert.deepEqual(task.usage, { input_tokens: 60, output_tokens: 30 });
});

test('取消发生在模型返回时，也不能错误地标记为待审阅', async t => {
  const { task } = await fixture(t);
  const controller = new AbortController();
  await runAgent(task, provider(async () => { controller.abort(); return textReply(); }), { signal: controller.signal });
  assert.equal(task.status, 'cancelled');
});

test('检查命令修改了源码时，其通过结果不能当作当前版本证据', async t => {
  const { task, tools } = await fixture(t);
  task.config.checks = { mutate: { command: 'node', args: ['-e', "require('fs').appendFileSync('cart.mjs','// modified by check\\n')"], timeout_ms: 3000 } };
  const result = await tools.execute('run_check', { name: 'mutate' });
  assert.equal(result.ok, true);
  assert.equal(task.checks.mutate?.status, 'passed');
  assert.equal(task.checks.mutate?.revision, -1);
  await runAgent(task, provider(async () => textReply()));
  assert.equal(task.verification, 'unverified');
});

test('搜索按字面匹配，读取范围和截断标记可靠', async t => {
  const { tools } = await fixture(t);
  assert.equal((await tools.execute('create_file', { path: 'notes.txt', content: `only.literal\n${'x'.repeat(20000)}` })).ok, true);
  const search = await tools.execute('search_text', { query: 'only.literal', directory: '' });
  assert.equal((search.data as any).matches.length, 1);
  const read = await tools.execute('read_file', { path: 'notes.txt', start_line: 1, end_line: 2 });
  assert.equal((read.data as any).truncated, true);
  assert.equal((await tools.execute('read_file', { path: 'notes.txt', start_line: 1, end_line: 201 })).error?.code, 'LINE_RANGE');
});
