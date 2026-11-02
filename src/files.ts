import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { AgentError } from './types.js';

const ignoredDirectories = new Set(['.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'coverage', '.next', '.venv', '__pycache__', '.agent-data', '.ssh', '.aws', '.azure', '.config']);
const textExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.txt', '.html', '.css', '.scss', '.py', '.yaml', '.yml', '.toml', '.sql', '.xml', '.svg', '.sh', '.ps1', '.go', '.rs', '.java', '.c', '.h', '.cpp']);
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_FILES = 500;
export const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
export const hash = (text: string) => createHash('sha256').update(text).digest('hex');

export function normalizeRelative(value: string, allowRoot = false): string {
  if (typeof value !== 'string' || value.includes('\0') || path.win32.isAbsolute(value) || path.posix.isAbsolute(value)) throw new AgentError('PATH_DENIED', '只允许工作区内的相对路径。');
  const normalized = value.replaceAll('\\', '/');
  if (allowRoot && (normalized === '' || normalized === '.')) return '';
  const parts = normalized.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[:*?"<>|]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) throw new AgentError('PATH_DENIED', '路径包含不允许的部分。');
  return parts.join('/');
}
export function allowedFile(relative: string): boolean {
  const parts = relative.split('/');
  if (parts.some(part => ignoredDirectories.has(part.toLowerCase()))) return false;
  if (parts.slice(0, -1).some(part => part.startsWith('.'))) return false;
  const name = parts.at(-1)!.toLowerCase();
  if (name === '.coding-agent.json' || name.startsWith('.env') || /(?:secret|credential|id_rsa|id_ed25519)/i.test(name) || ['.npmrc', '.pypirc', '.netrc'].includes(name)) return false;
  if (name.startsWith('.') && name !== '.gitignore') return false;
  return name === '.gitignore' || textExtensions.has(path.extname(name));
}
export function assertText(text: string): void {
  if (text.includes('\0') || text.includes('\uFFFD')) throw new AgentError('UNSUPPORTED_FILE', '仅支持有效的 UTF-8 文本。');
  if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{24,}\b/.test(text)) throw new AgentError('SENSITIVE_CONTENT', '检测到疑似密钥，拒绝将其放入任务或模型上下文。');
}
export function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export async function safePath(root: string, relative: string, allowMissing = false): Promise<string> {
  const normalized = normalizeRelative(relative);
  if (!allowedFile(normalized)) throw new AgentError('PATH_DENIED', '该文件类型或敏感路径不在允许范围内。');
  const realRoot = await fs.realpath(root);
  let current = realRoot;
  for (const [index, part] of normalized.split('/').entries()) {
    current = path.join(current, part);
    if (!within(realRoot, current)) throw new AgentError('PATH_DENIED', '路径越出工作区。');
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new AgentError('PATH_DENIED', '不读取或写入符号链接 / junction。');
      if (index < normalized.split('/').length - 1 && !stat.isDirectory()) throw new AgentError('PATH_DENIED', '父路径不是目录。');
      if (!within(realRoot, await fs.realpath(current))) throw new AgentError('PATH_DENIED', '真实路径越出工作区。');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !allowMissing) throw error;
    }
  }
  return current;
}
export async function readText(root: string, relative: string): Promise<string> {
  const filename = await safePath(root, relative);
  const stat = await fs.stat(filename);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new AgentError('FILE_TOO_LARGE', '只读取不超过 256 KiB 的文本文件。');
  const content = await fs.readFile(filename, 'utf8');
  assertText(content);
  return content;
}
export async function listFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  let totalBytes = 0;
  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name.toLowerCase()) && !entry.name.startsWith('.')) await visit(path.join(directory, entry.name), relative);
      } else if (entry.isFile() && allowedFile(relative)) {
        normalizeRelative(relative);
        const stat = await fs.stat(path.join(directory, entry.name));
        if (stat.size > MAX_FILE_BYTES) continue;
        totalBytes += stat.size;
        output.push(relative);
        if (output.length > MAX_FILES || totalBytes > MAX_TOTAL_BYTES) throw new AgentError('PROJECT_TOO_LARGE', '首版支持至多 500 个文本文件、合计 10 MiB，请选择较小的子项目。');
      }
    }
  }
  await visit(await fs.realpath(root), '');
  return output;
}
async function atomicRename(from: string, to: string, beforeAttempt?: () => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await beforeAttempt?.(); await fs.rename(from, to); return; }
    catch (error) {
      if (attempt >= 6 || !['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await new Promise(resolve => setTimeout(resolve, 10 * 2 ** attempt));
    }
  }
}
export async function writeText(root: string, relative: string, content: string, expectedHash?: string | null): Promise<void> {
  assertText(content);
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new AgentError('FILE_TOO_LARGE', '写入超过文件大小限制。');
  const target = await safePath(root, relative, true);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await safePath(root, relative, true);
  const currentContent = async () => { try { return await fs.readFile(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } };
  const before = await currentContent();
  if (expectedHash !== undefined && (before === null ? null : hash(before.toString('utf8'))) !== expectedHash) throw new AgentError('STALE_CONTENT', '写入前文件版本已变化。');
  const temporary = `${target}.agent-${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    await atomicRename(temporary, target, async () => {
      await safePath(root, relative, true);
      const current = await currentContent();
      if (before === null ? current !== null : current === null || !before.equals(current)) throw new AgentError('STALE_CONTENT', '等待写入时文件已变化，请重新读取。');
    });
  } finally {
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
export async function exists(filename: string): Promise<boolean> {
  try { await fs.lstat(filename); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export async function writeJson(filename: string, value: unknown): Promise<void> {
  const temp = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    await atomicRename(temp, filename);
  } finally { await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
