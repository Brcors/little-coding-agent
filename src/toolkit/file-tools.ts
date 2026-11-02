import { z } from 'zod';
import { AgentError } from '../types.js';
import { hash, listFiles, normalizeRelative, readText } from '../files.js';
import type { ToolSpec } from './contracts.js';
export const relativePath = z.string().min(1).max(300);
export const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
function inDirectory(files: string[], directory: string) {
  const normalized = normalizeRelative(directory, true);
  return normalized ? files.filter(file => file.startsWith(`${normalized}/`)) : files;
}
export const fileTools: ToolSpec[] = [
  { name: 'list_files', title: '列出文件', category: 'files', access: 'read',
    description: '列出允许访问的任务文件；directory 为空字符串表示根目录。输出过长时按返回的 call_id 分段读取。',
    schema: z.object({ directory: z.string().max(300) }).strict(),
    async run({ directory }, { task }) { return { files: inDirectory(await listFiles(task.workspace), directory) }; }
  },
  { name: 'read_file', title: '按行读取', category: 'files', access: 'read',
    description: '按行读取 UTF-8 文件，一次最多 200 行；返回完整文件 sha256，修改必须使用这个版本。',
    schema: z.object({ path: relativePath, start_line: z.number().int().min(1), end_line: z.number().int().min(1) }).strict(),
    async run(input, { task }) {
      if (input.end_line < input.start_line || input.end_line - input.start_line >= 200) throw new AgentError('LINE_RANGE', '一次读取 1–200 行。');
      const content = await readText(task.workspace, input.path);
      const lines = content.split('\n');
      const end = Math.min(input.end_line, lines.length);
      return { path: input.path, sha256: hash(content), total_lines: lines.length,
        content: lines.slice(input.start_line - 1, input.end_line).map((line, index) => `${index + input.start_line}: ${line}`).join('\n'),
        next_line: end < lines.length ? end + 1 : null, truncated: false };
    }
  },
  { name: 'search_text', title: '搜索文本', category: 'files', access: 'read',
    description: '字面关键词搜索（不是正则）；最多返回 40 条带行号匹配。结果截断时缩小目录或关键词。',
    schema: z.object({ query: z.string().min(1).max(200), directory: z.string().max(300) }).strict(),
    async run({ query, directory }, { task, signal }) {
      const matches: { path: string; line: number; text: string }[] = [];
      let truncated = false;
      outer: for (const file of inDirectory(await listFiles(task.workspace), directory)) {
        signal.throwIfAborted();
        for (const [index, line] of (await readText(task.workspace, file)).split('\n').entries()) {
          if (!line.includes(query)) continue;
          if (matches.length === 40) { truncated = true; break outer; }
          matches.push({ path: file, line: index + 1, text: line.slice(0, 300) });
        }
      }
      return { matches, truncated };
    }
  }
];
