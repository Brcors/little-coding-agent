import * as fs from 'node:fs/promises';
import path from 'node:path';
import { type ModelProvider, type ModelReply, AgentError } from './types.js';

export async function createDemoProject(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'cart.mjs'), 'export function total(items) {\n  return items.map(item => item.price * item.quantity).reduce((sum, price) => sum + price);\n}\n');
  await fs.writeFile(path.join(root, 'cart.test.mjs'), `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { total } from './cart.mjs';\ntest('empty cart returns zero', () => assert.equal(total([]), 0));\ntest('sums price times quantity', () => assert.equal(total([{price: 5, quantity: 2}, {price: 3, quantity: 1}]), 13));\n`);
  await fs.writeFile(path.join(root, '.coding-agent.json'), JSON.stringify({ checks: { test: { command: 'node', args: ['--test', 'cart.test.mjs'], timeout_ms: 10000 } } }, null, 2));
}
// A deterministic demonstration driver, not an LLM and not a substitute for one.
export class DemoProvider implements ModelProvider {
  name = 'demo' as const;
  model = 'scripted-cart-demo';
  private step = 0;
  private sha = '';
  async respond(input: unknown[], _instructions: string, _tools: unknown[], signal: AbortSignal): Promise<ModelReply> {
    signal.throwIfAborted();
    const last = input.at(-1) as { type?: string; output?: string };
    const previous = last?.type === 'function_call_output' ? JSON.parse(last.output!) : undefined;
    if (previous && !previous.ok) throw new AgentError('DEMO_FAILED', `演示工具失败：${previous.error?.code}`);
    if (this.step === 3) this.sha = previous.data.sha256;
    const calls = [
      { name: 'list_files', args: { directory: '' } },
      { name: 'run_check', args: { name: 'test' } },
      { name: 'read_file', args: { path: 'cart.mjs', start_line: 1, end_line: 100 } },
      { name: 'replace_text', args: { path: 'cart.mjs', expected_sha256: this.sha, old_text: '.reduce((sum, price) => sum + price)', new_text: '.reduce((sum, price) => sum + price, 0)' } },
      { name: 'run_check', args: { name: 'test' } },
      { name: 'inspect_diff', args: {} }
    ];
    const planned = calls[this.step++];
    if (!planned) {
      const text = '演示完成：为 reduce 增加初始值 0，使空购物车返回 0；固定测试已实际运行。此回复来自演示脚本，并非真实 LLM。';
      return { replay: [{ role: 'assistant', content: text }], calls: [], text, usage: { input_tokens: 0, output_tokens: 0 } };
    }
    const call = { name: planned.name, arguments: JSON.stringify(planned.args), call_id: `demo-${this.step}` };
    return { replay: [{ type: 'function_call', ...call }], calls: [call], text: '', usage: { input_tokens: 0, output_tokens: 0 } };
  }
}
