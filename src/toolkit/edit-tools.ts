import { z } from 'zod';
import { AgentError } from '../types.js';
import { exists, hash, readText, safePath } from '../files.js';
import { applyEdits, restoreFiles } from './patches.js';
import { relativePath, sha256 } from './file-tools.js';
import type { ToolSpec } from './contracts.js';
export const editTools: ToolSpec[] = [
  { name: 'replace_text', title: '局部替换', category: 'edits', access: 'write',
    description: '校验最新 sha256 后，替换唯一匹配的 old_text，仅影响任务副本。重复匹配或过期版本将拒绝。',
    schema: z.object({ path: relativePath, expected_sha256: sha256, old_text: z.string().min(1).max(100000), new_text: z.string().max(100000) }).strict(),
    async run(input, { task, signal }) {
      const content = await readText(task.workspace, input.path);
      if (hash(content) !== input.expected_sha256) throw new AgentError('STALE_CONTENT', '文件版本已变化，请重新读取后修改。');
      const first = content.indexOf(input.old_text);
      if (first < 0 || content.indexOf(input.old_text, first + 1) >= 0) throw new AgentError('AMBIGUOUS_EDIT', 'old_text 必须精确匹配且只出现一次。');
      const updated = content.slice(0, first) + input.new_text + content.slice(first + input.old_text.length);
      await applyEdits(task, [{ path: input.path, expected_sha256: input.expected_sha256, content: updated }], signal);
      return { path: input.path, sha256: hash(updated), revision: task.revision };
    }
  },
  { name: 'create_file', title: '新建文件', category: 'edits', access: 'write',
    description: '在任务副本中新建文本文件，不覆盖已有文件；与多文件补丁共用边界和大小校验。',
    schema: z.object({ path: relativePath, content: z.string().max(100000) }).strict(),
    async run(input, { task, signal }) {
      if (await exists(await safePath(task.workspace, input.path, true))) throw new AgentError('FILE_EXISTS', '文件已存在，请使用 replace_text。');
      await applyEdits(task, [{ path: input.path, expected_sha256: null, content: input.content }], signal);
      return { path: input.path, sha256: hash(input.content), revision: task.revision };
    }
  },
  { name: 'apply_patch', title: '多文件补丁', category: 'edits', access: 'write',
    description: '结构化批次修改（非 unified diff）：content 是完整新内容，null 表示删除；expected_sha256=null 仅用于新建。先校验全部前置条件，失败时尝试恢复本批次，保留并发编辑。',
    schema: z.object({ changes: z.array(z.object({ path: relativePath, expected_sha256: sha256.nullable(), content: z.string().max(260000).nullable() }).strict()).min(1).max(20) }).strict(),
    async run({ changes }, { task, signal }) { return applyEdits(task, changes, signal); }
  },
  { name: 'restore_files', title: '恢复文件', category: 'edits', access: 'write',
    description: '在任务副本中将指定文件恢复为任务创建时的基线；新建文件会被移除。必须提供当前 hash（当前不存在时为 null），不会操作原项目。',
    schema: z.object({ files: z.array(z.object({ path: relativePath, expected_sha256: sha256.nullable() }).strict()).min(1).max(20) }).strict(),
    async run({ files }, { task, signal }) { return restoreFiles(task, files, signal); }
  }
];
