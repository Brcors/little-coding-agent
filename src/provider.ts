import OpenAI from 'openai';
import { toResponseInputItems } from 'openai/lib/responses/ResponseInputItems';
import type { ResponseInput, Tool } from 'openai/resources/responses/responses';
import { AgentError, type ModelProvider, type ModelReply } from './types.js';

export class OpenAIProvider implements ModelProvider {
  name = 'openai' as const;
  private client: OpenAI;
  constructor(public model: string, options: { apiKey?: string; baseURL?: string; maxRetries?: number } = {}) {
    const key = options.apiKey || process.env.OPENAI_API_KEY;
    if (!key) throw new AgentError('MISSING_KEY', '请在项目本地 .env 中配置 OPENAI_API_KEY；无需在聊天中提供密钥。');
    if (!model) throw new AgentError('MISSING_MODEL', '请设置 OPENAI_MODEL，或使用 --model 指定账户可用的模型 ID。');
    this.client = new OpenAI({ apiKey: key, baseURL: options.baseURL, maxRetries: options.maxRetries ?? 1, timeout: 60000 });
  }
  async respond(input: unknown[], instructions: string, tools: unknown[], signal: AbortSignal, maxOutputTokens: number, options?: { toolChoice?: 'auto' | 'required' }): Promise<ModelReply> {
    const response = await this.client.responses.create({
      model: this.model, instructions, input: input as ResponseInput, tools: tools as Tool[],
      store: false, include: ['reasoning.encrypted_content'], parallel_tool_calls: false, max_output_tokens: maxOutputTokens,
      tool_choice: options?.toolChoice ?? 'auto'
    }, { signal });
    if (response.status !== 'completed') throw new AgentError('MODEL_INCOMPLETE', `模型响应未完成（${response.status}），未执行该响应中的工具。请调整输出预算或重试。`);
    if (response.output.some(item => item.type === 'message' && item.content.some(part => part.type === 'refusal'))) throw new AgentError('MODEL_REFUSED', '模型拒绝了此任务，没有执行该响应中的工具。');
    return {
      replay: toResponseInputItems(response.output),
      calls: response.output.filter(item => item.type === 'function_call').map(item => ({ name: item.name, arguments: item.arguments, call_id: item.call_id })),
      text: response.output_text,
      usage: { input_tokens: response.usage?.input_tokens ?? 0, output_tokens: response.usage?.output_tokens ?? 0 }
    };
  }
}
