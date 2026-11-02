import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDemoProject } from '../src/demo.js';
import { createTask, taskChanges, acceptTask } from '../src/workspace.js';
import { readText, writeText, hash, within } from '../src/files.js';
import { Tools } from '../src/tools.js';
import { applyEdits } from '../src/toolkit/patches.js';
import { listCalls, readCall } from '../src/toolkit/audit.js';
import { runAgent } from '../src/agent.js';
import { ToolDemoProvider } from '../src/toolkit/demo.js';

async function setup(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'little-tools-test-'));
  t.after(async () => {
    const real = await fs.realpath(root);
    assert.ok(within(await fs.realpath(os.tmpdir()), real) && path.basename(real).startsWith('little-tools-test-'));
    await fs.rm(real, { recursive: true, force: true });
  });
  const source = path.join(root, '中文 source');
  await createDemoProject(source);
  const task = await createTask({ source, dataDir: path.join(root, 'data'), goal: 'tool test', provider: 'test', model: 'test', execution: 'trusted' });
  const controller = new AbortController();
  return { root, source, task, controller, tools: new Tools(task, controller.signal) };
}
test('工具演示真实调用全部工具，原目录未提前写入', async t => {
  const { source, task } = await setup(t);
  await runAgent(task, new ToolDemoProvider());
  assert.equal(task.status, 'review_ready', task.error);
  assert.equal(task.verification, 'passed');
  const calls = await listCalls(task);
  assert.equal(new Set(calls.map(call => call.name)).size, 10);
  assert.equal(calls.length, 11);
  assert.ok(calls.every(call => call.status === 'succeeded' && call.duration_ms! >= 0));
  assert.ok(calls.every(call => call.source === 'model' && call.provider_call_id));
  assert.equal((await taskChanges(task)).length, 1);
  assert.doesNotMatch(await fs.readFile(path.join(source, 'cart.mjs'), 'utf8'), /price, 0/);
  assert.equal(await acceptTask(task), 1);
  assert.match(await fs.readFile(path.join(source, 'cart.mjs'), 'utf8'), /price, 0/);
});
test('多文件补丁先校验全批次，任一版本冲突时不写入任何文件', async t => {
  const { task, tools } = await setup(t);
  const before = await readText(task.workspace, 'cart.mjs');
  const result = await tools.execute('apply_patch', { changes: [
    { path: 'a-new.ts', expected_sha256: null, content: 'new' },
    { path: 'cart.mjs', expected_sha256: '0'.repeat(64), content: 'wrong' }
  ] });
  assert.equal(result.error?.code, 'STALE_CONTENT');
  assert.equal(result.error?.retryable, true);
  assert.equal(await readText(task.workspace, 'cart.mjs'), before);
  await assert.rejects(fs.stat(path.join(task.workspace, 'a-new.ts')), { code: 'ENOENT' });
  assert.equal(task.revision, 0);
});
test('批次支持更新、创建和删除，恢复后与基线一致', async t => {
  const { task, tools } = await setup(t);
  const cart = await readText(task.workspace, 'cart.mjs');
  const testFile = await readText(task.workspace, 'cart.test.mjs');
  const edited = await tools.execute('apply_patch', { changes: [
    { path: 'cart.mjs', expected_sha256: hash(cart), content: 'updated\n' },
    { path: 'cart.test.mjs', expected_sha256: hash(testFile), content: null },
    { path: 'new.ts', expected_sha256: null, content: 'created' }
  ] });
  assert.equal(edited.ok, true);
  assert.equal((await taskChanges(task)).length, 3);
  assert.equal(task.revision, 1);
  const restore = await tools.execute('restore_files', { files: [
    { path: 'cart.mjs', expected_sha256: hash('updated\n') },
    { path: 'cart.test.mjs', expected_sha256: null },
    { path: 'new.ts', expected_sha256: hash('created') }
  ] });
  assert.equal(restore.ok, true);
  assert.deepEqual(await taskChanges(task), []);
  assert.equal(task.revision, 2);
});
test('中途写入失败会恢复已经写入的文件', async t => {
  const { task, controller } = await setup(t);
  const original = await readText(task.workspace, 'cart.mjs');
  let writes = 0;
  await assert.rejects(applyEdits(task, [
    { path: 'cart.mjs', expected_sha256: hash(original), content: 'intermediate' },
    { path: 'new.ts', expected_sha256: null, content: 'not written' }
  ], controller.signal, async (root, file, content) => {
    if (++writes === 2) throw new Error('simulated disk failure');
    await writeText(root, file, content);
  }), /simulated disk failure/);
  assert.equal(await readText(task.workspace, 'cart.mjs'), original);
  assert.deepEqual(await taskChanges(task), []);
});
test('取消批次会恢复先前写入', async t => {
  const { task, controller } = await setup(t);
  const original = await readText(task.workspace, 'cart.mjs');
  await assert.rejects(applyEdits(task, [
    { path: 'cart.mjs', expected_sha256: hash(original), content: 'temporary' },
    { path: 'new.ts', expected_sha256: null, content: 'not written' }
  ], controller.signal, async (root, file, content) => { await writeText(root, file, content); controller.abort(); }));
  assert.equal(await readText(task.workspace, 'cart.mjs'), original);
  assert.deepEqual(await taskChanges(task), []);
});
test('回滚不覆盖并发编辑，并明确报告不完整恢复', async t => {
  const { task, controller } = await setup(t);
  const original = await readText(task.workspace, 'cart.mjs');
  let count = 0;
  await assert.rejects(applyEdits(task, [
    { path: 'cart.mjs', expected_sha256: hash(original), content: 'agent change' },
    { path: 'new.ts', expected_sha256: null, content: 'will fail' }
  ], controller.signal, async (root, file, content) => {
    if (++count === 2) { await writeText(root, 'cart.mjs', 'newer user change'); throw new Error('fail'); }
    await writeText(root, file, content);
  }), /部分文件存在并发变更/);
  assert.equal(await readText(task.workspace, 'cart.mjs'), 'newer user change');
  assert.equal(task.verification, 'unverified');
  assert.equal(task.revision, 1);
});
test('只读权限过滤模型声明，并拒绝伪造的写入与检查调用', async t => {
  const { task, tools } = await setup(t);
  task.tool_policy = 'read_only';
  assert.equal(tools.definitions.some(tool => tool.name === 'run_check' || tool.name === 'apply_patch'), false);
  for (const [name, args] of [['create_file', { path: 'no.ts', content: 'no' }], ['run_check', { name: 'test' }]] as const) assert.equal((await tools.execute(name, args)).error?.code, 'PERMISSION_DENIED');
  assert.equal((await tools.execute('read_file', { path: 'cart.mjs', start_line: 1, end_line: 10 })).ok, true);
  assert.deepEqual(await taskChanges(task), []);
  task.tool_policy = 'unexpected' as any;
  assert.equal(tools.definitions.length, 0);
  assert.equal((await tools.execute('create_file', { path: 'never.ts', content: 'denied' })).error?.code, 'PERMISSION_DENIED');
});
test('只读项目配置会进入任务权限，模型不能通过参数切换工作区', async t => {
  const { root, source, tools } = await setup(t);
  await fs.writeFile(path.join(source, '.coding-agent.json'), JSON.stringify({ tool_policy: 'read_only' }));
  const task = await createTask({ source, dataDir: path.join(root, 'read-data'), goal: 'read', provider: 'test', model: 'test', execution: 'disabled' });
  assert.equal(task.tool_policy, 'read_only');
  assert.equal((await tools.execute('read_file', { path: 'cart.mjs', start_line: 1, end_line: 10, workspace: source })).error?.code, 'INVALID_ARGUMENTS');
});
test('相同调用ID跨执行器实例也不能重复产生副作用', async t => {
  const { task, tools } = await setup(t);
  assert.equal((await tools.execute('create_file', { path: 'first.ts', content: 'one' }, { providerCallId: 'same-call' })).ok, true);
  const next = new Tools(task, new AbortController().signal);
  const result = await next.execute('create_file', { path: 'second.ts', content: 'two' }, { providerCallId: 'same-call' });
  assert.equal(result.error?.code, 'DUPLICATE_CALL');
  await assert.rejects(fs.stat(path.join(task.workspace, 'second.ts')), { code: 'ENOENT' });
  assert.equal((await listCalls(task)).length, 2);
});
test('同一任务并发修改串行执行，第二次过期修改被拒绝', async t => {
  const { task, tools } = await setup(t);
  const before = await readText(task.workspace, 'cart.mjs');
  const input = { path: 'cart.mjs', expected_sha256: hash(before), old_text: 'sum + price)', new_text: 'sum + price, 0)' };
  const results = await Promise.all([tools.execute('replace_text', input), tools.execute('replace_text', input)]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.find(result => !result.ok)?.error?.code, 'STALE_CONTENT');
  assert.equal(task.revision, 1);
});
test('超长结果有可补读的完整记录，不能跨任务读取', async t => {
  const { task, tools, root, source } = await setup(t);
  await fs.writeFile(path.join(task.workspace, 'long.txt'), 'x'.repeat(24000));
  const output = await tools.execute('read_file', { path: 'long.txt', start_line: 1, end_line: 1 });
  assert.equal(output.truncated, true);
  assert.ok(JSON.stringify(output).length < 16000);
  const full = await readCall(task, output.meta!.call_id);
  assert.equal((full.result!.data as any).content.length, 24003);
  let cursor: number | null = 0, text = '';
  while (cursor !== null) {
    const page = await tools.execute('read_tool_output', { call_id: output.meta!.call_id, offset: cursor, limit: 6000 });
    assert.equal(page.truncated, false);
    text += (page.data as any).text;
    cursor = (page.data as any).next_offset;
  }
  assert.equal(JSON.parse(text).sha256, hash('x'.repeat(24000)));
  const otherTask = await createTask({ source, dataDir: path.join(root, 'other-data'), goal: 'other', provider: 'test', model: 'test', execution: 'disabled' });
  const other = new Tools(otherTask, new AbortController().signal);
  assert.equal((await other.execute('read_tool_output', { call_id: output.meta!.call_id, offset: 0, limit: 100 })).error?.code, 'ARTIFACT_NOT_FOUND');
});
test('失败、无效JSON与敏感参数同样留有脱敏记录', async t => {
  const { task, tools } = await setup(t);
  const secret = 'synthetic-password-value';
  const denied = await tools.executeJson('create_file', JSON.stringify({ path: '../bad.ts', content: 'bad', password: secret }));
  assert.equal(denied.ok, false);
  const badJson = await tools.executeJson('create_file', '{"password":"synthetic-password-value"');
  assert.equal(badJson.error?.code, 'INVALID_JSON');
  const text = JSON.stringify(await listCalls(task));
  assert.doesNotMatch(text, new RegExp(secret));
  assert.match(text, /REDACTED/);
  assert.equal((await listCalls(task)).every(call => call.status === 'failed'), true);
});
test('检查日志和返回值会脱敏，仍保留真实退出码', async t => {
  const { task, tools } = await setup(t);
  task.config.checks = { test: { command: 'node', args: ['-e', "console.log('API_KEY=synthetic-sensitive-value');process.exit(3)"], timeout_ms: 3000 } };
  const result = await tools.execute('run_check', { name: 'test' });
  assert.equal((result.data as any).status, 'failed');
  assert.equal((result.data as any).exit_code, 3);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-sensitive-value/);
  assert.match(await fs.readFile(path.join(task.directory, (result.data as any).log_file), 'utf8'), /REDACTED/);
});
test('补丁拒绝重复路径、越界、敏感文件和过量字节', async t => {
  const { tools } = await setup(t);
  assert.equal((await tools.execute('apply_patch', { changes: [{ path: 'a.ts', expected_sha256: null, content: 'x' }, { path: 'a.ts', expected_sha256: null, content: 'y' }] })).error?.code, 'PATCH_CONFLICT');
  for (const file of ['../bad.ts', '.env', '.git/config']) assert.equal((await tools.execute('apply_patch', { changes: [{ path: file, expected_sha256: null, content: 'x' }] })).error?.code, 'PATH_DENIED');
  assert.equal((await tools.execute('apply_patch', { changes: [{ path: 'large.txt', expected_sha256: null, content: '汉'.repeat(90000) }] })).error?.code, 'FILE_TOO_LARGE');
});
