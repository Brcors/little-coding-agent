import * as fs from 'node:fs/promises';
import path from 'node:path';
import { AgentError, type Task, type SnapshotFile } from '../types.js';
import { assertText, exists, hash, listFiles, MAX_FILES, MAX_TOTAL_BYTES, MAX_FILE_BYTES, normalizeRelative, readText, safePath, writeText } from '../files.js';

export interface FileEdit { path: string; expected_sha256: string | null; content: string | null }
export async function applyEdits(task: Task, edits: FileEdit[], signal: AbortSignal, write = writeText) {
  const seen = new Set<string>();
  const prepared: { path: string; before: string | null; after: string | null }[] = [];
  for (const edit of edits) {
    signal.throwIfAborted();
    const relative = normalizeRelative(edit.path);
    const key = process.platform === 'win32' ? relative.toLowerCase() : relative;
    if (seen.has(key)) throw new AgentError('PATCH_CONFLICT', '同一批次不能重复修改同一路径。');
    seen.add(key);
    const target = await safePath(task.workspace, relative, true);
    const before = await exists(target) ? await readText(task.workspace, relative) : null;
    if ((before === null ? null : hash(before)) !== edit.expected_sha256) throw new AgentError('STALE_CONTENT', `文件版本已变化：${relative}，请重新读取。`);
    if (edit.content === null && before === null) throw new AgentError('PATCH_CONFLICT', '不能删除不存在的文件。');
    if (edit.content !== null) {
      assertText(edit.content);
      if (Buffer.byteLength(edit.content) > MAX_FILE_BYTES) throw new AgentError('FILE_TOO_LARGE', '补丁文件超过 256 KiB。');
    }
    if (before !== edit.content) prepared.push({ path: relative, before, after: edit.content });
  }
  // Reject batches that would make the workspace unreadable to the other tools.
  const files = await listFiles(task.workspace);
  let total = 0;
  for (const file of files) total += Buffer.byteLength(await readText(task.workspace, file));
  let count = files.length;
  for (const change of prepared) {
    if (change.before === null) count++;
    if (change.after === null) count--;
    total += Buffer.byteLength(change.after ?? '') - Buffer.byteLength(change.before ?? '');
  }
  if (count > MAX_FILES || total > MAX_TOTAL_BYTES) throw new AgentError('PROJECT_TOO_LARGE', '补丁将超过工作区文件数量或总大小限制。');
  const applied: typeof prepared = [];
  try {
    for (const change of prepared) {
      signal.throwIfAborted();
      const target = await safePath(task.workspace, change.path, true);
      const current = await exists(target) ? await readText(task.workspace, change.path) : null;
      if (current !== change.before) throw new AgentError('STALE_CONTENT', `应用前文件发生变化：${change.path}`);
      if (change.after === null) await fs.unlink(target);
      else await write(task.workspace, change.path, change.after, change.before === null ? null : hash(change.before));
      applied.push(change);
    }
    signal.throwIfAborted();
  } catch (error) {
    const conflicts: string[] = [];
    for (const change of [...applied].reverse()) {
      try {
        const target = await safePath(task.workspace, change.path, true);
        const current = await exists(target) ? await readText(task.workspace, change.path) : null;
        if (current !== change.after) { conflicts.push(change.path); continue; }
        if (change.before === null) await fs.unlink(target);
        else await writeText(task.workspace, change.path, change.before, change.after === null ? null : hash(change.after));
      } catch { conflicts.push(change.path); }
    }
    if (conflicts.length) { task.revision++; task.verification = 'unverified'; throw new AgentError('ROLLBACK_CONFLICT', `批次中断，部分文件存在并发变更或恢复失败，请检查：${conflicts.join(', ')}`); }
    throw error;
  }
  if (prepared.length) { task.revision++; task.verification = 'unverified'; }
  return { files: prepared.map(change => ({ path: change.path, sha256: change.after === null ? null : hash(change.after) })), revision: task.revision };
}
export async function restoreFiles(task: Task, files: { path: string; expected_sha256: string | null }[], signal: AbortSignal) {
  const baseline: Record<string, SnapshotFile> = JSON.parse(await fs.readFile(path.join(task.directory, 'baseline.json'), 'utf8'));
  return applyEdits(task, files.map(file => ({ ...file, content: baseline[normalizeRelative(file.path)]?.content ?? null })), signal);
}
