import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AgentError } from '../types.js';
import { hash } from '../files.js';
import { executeCheck } from '../executor.js';
import { event, taskChanges } from '../workspace.js';
import type { ToolSpec } from './contracts.js';
import { redact } from './audit.js';
export const checkTools: ToolSpec[] = [{
  name: 'run_check', title: '执行检查', category: 'checks', access: 'execute',
  description: '仅运行用户预配置的检查名称，不接受任意 shell。返回实际退出状态和日志，支持任务取消与超时；unavailable 不等于通过。',
  schema: z.object({ name: z.string().min(1).max(40) }).strict(),
  async run({ name }, { task, signal, notify }) {
    if (!Object.hasOwn(task.config.checks, name)) throw new AgentError('CHECK_NOT_CONFIGURED', '该检查未配置，不能执行任意命令。');
    const before = hash(JSON.stringify(await taskChanges(task)));
    const result = await executeCheck(task, task.config.checks[name]!, signal);
    result.output = redact(result.output);
    result.log_file = `check-${name}-${randomUUID()}.log`;
    const after = hash(JSON.stringify(await taskChanges(task)));
    if (before !== after) { task.revision++; task.verification = 'unverified'; }
    task.checks[name] = { ...result, revision: before === after ? task.revision : -1 };
    await fs.writeFile(path.join(task.directory, result.log_file), result.output);
    await event(task, 'check.completed', { name, status: result.status, exit_code: result.exit_code, revision: task.checks[name]!.revision, log_file: result.log_file });
    notify(`检查 ${name}：${result.status}`);
    return { name, ...result, revision: task.checks[name]!.revision };
  }
}];
