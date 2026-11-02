import { AgentError, type ModelProvider, type ModelReply } from '../types.js';

export class ToolDemoProvider implements ModelProvider {
  name = 'demo' as const;
  model = 'scripted-tool-demo';
  private step = 0;
  private original = '';
  private cartHash = '';
  private noteHash = '';
  private diffCall = '';
  async respond(input: unknown[], _instructions: string, _tools: unknown[], signal: AbortSignal): Promise<ModelReply> {
    signal.throwIfAborted();
    const last = input.at(-1) as { type?: string; output?: string };
    const previous = last?.type === 'function_call_output' ? JSON.parse(last.output!) : undefined;
    if (previous && !previous.ok) throw new AgentError('DEMO_FAILED', `工具演示失败：${previous.error?.code}`);
    if (this.step === 3) {
      this.original = previous.data.content.split('\n').map((line: string) => line.replace(/^\d+: /, '')).join('\n');
      this.cartHash = previous.data.sha256;
    }
    if (this.step === 4) this.noteHash = previous.data.sha256;
    if (this.step === 5) this.noteHash = previous.data.files.find((file: { path: string }) => file.path === 'tool-notes.md').sha256;
    if (this.step === 7) this.cartHash = previous.data.sha256;
    if (this.step === 10) this.diffCall = previous.meta.call_id;
    const planned = [
      { name: 'list_files', args: { directory: '' } },
      { name: 'search_text', args: { query: 'reduce', directory: '' } },
      { name: 'read_file', args: { path: 'cart.mjs', start_line: 1, end_line: 100 } },
      { name: 'create_file', args: { path: 'tool-notes.md', content: 'Temporary tool demonstration.\n' } },
      { name: 'apply_patch', args: { changes: [
        { path: 'cart.mjs', expected_sha256: this.cartHash, content: this.original.replace('sum + price)', 'sum + price, 0)') },
        { path: 'tool-notes.md', expected_sha256: this.noteHash, content: 'Batch update succeeded.\n' }
      ] } },
      { name: 'restore_files', args: { files: [{ path: 'tool-notes.md', expected_sha256: this.noteHash }] } },
      { name: 'read_file', args: { path: 'cart.mjs', start_line: 1, end_line: 100 } },
      { name: 'replace_text', args: { path: 'cart.mjs', expected_sha256: this.cartHash, old_text: 'export function total(items) {', new_text: '// Verified through the tool layer.\nexport function total(items) {' } },
      { name: 'run_check', args: { name: 'test' } },
      { name: 'inspect_diff', args: {} },
      { name: 'read_tool_output', args: { call_id: this.diffCall, offset: 0, limit: 100 } }
    ][this.step++];
    if (!planned) {
      const text = '工具演示完成：实际调用了全部 10 个工具，完成多文件修改、恢复临时文件、修复购物车并通过检查。修改仍保存在副本中，等待审阅。本次使用固定演示驱动，未调用真实 LLM。';
      return { replay: [{ role: 'assistant', content: text }], calls: [], text, usage: { input_tokens: 0, output_tokens: 0 } };
    }
    const call = { name: planned.name, arguments: JSON.stringify(planned.args), call_id: `tool-demo-${this.step}` };
    return { replay: [{ type: 'function_call', ...call }], calls: [call], text: '', usage: { input_tokens: 0, output_tokens: 0 } };
  }
}
