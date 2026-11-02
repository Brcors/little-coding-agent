import * as fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AgentError } from '../types.js';
import { formatDiff, taskChanges } from '../workspace.js';
import { readCall } from './audit.js';
import type { ToolSpec } from './contracts.js';
export const evidenceTools: ToolSpec[] = [
  { name: 'inspect_diff', title: '查看代码差异', category: 'evidence', access: 'read',
    description: '查看任务基线到当前的完整差异，包含新增、删除文件；长结果通过 read_tool_output 分段读取。',
    schema: z.object({}).strict(),
    async run(_input, { task }) {
      const changes = await taskChanges(task);
      const diff = formatDiff(changes);
      await fs.writeFile(path.join(task.directory, 'diff.patch'), diff);
      return { files: changes.map(change => change.path), diff, truncated: false };
    }
  },
  { name: 'read_tool_output', title: '分段读取结果', category: 'evidence', access: 'read',
    description: '按本任务工具结果的 call_id 分段读取已脱敏的完整 JSON。offset 为从 0 开始的字符位置，limit 最大 6000；不能读取其他任务。',
    schema: z.object({ call_id: z.string().uuid(), offset: z.number().int().min(0), limit: z.number().int().min(1).max(6000) }).strict(),
    async run({ call_id, offset, limit }, { task }) {
      const record = await readCall(task, call_id);
      if (!record.result) throw new AgentError('OUTPUT_NOT_READY', '此工具调用尚未完成。');
      const text = JSON.stringify(record.result.data ?? record.result.error);
      if (offset > text.length) throw new AgentError('CURSOR_RANGE', '结果读取位置超过长度。');
      const end = Math.min(offset + limit, text.length);
      return { call_id, text: text.slice(offset, end), total_characters: text.length, next_offset: end < text.length ? end : null };
    }
  }
];
