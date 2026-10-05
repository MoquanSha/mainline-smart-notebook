import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const allowed = /^notebook\.json(?:\.(?:bak|backup|broken|tmp)(?:-[a-zA-Z0-9_-]+)?)?$/;
const failure = (status, message) => Object.assign(new Error(message), { status, code: 'RECOVERY_FILE_ERROR' });
const signature = stat => `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

export async function recoveryFiles(directory) {
  let rows;
  try { rows = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const results = [];
  for (const entry of rows) {
    if (!entry.isFile() || !allowed.test(entry.name)) continue;
    try {
      const stat = await lstat(join(directory, entry.name));
      if (!stat.isFile()) continue;
      results.push({ name: entry.name, bytes: stat.size, modifiedAt: stat.mtime.toISOString(), current: entry.name === 'notebook.json' });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return results.sort((a, b) => Number(b.current) - Number(a.current) || b.modifiedAt.localeCompare(a.modifiedAt));
}

export async function recoveryFile(directory, name) {
  if (typeof name !== 'string' || !allowed.test(name)) throw failure(400, '只能导出当前数据目录中的笔记文件。');
  const path = join(directory, name);
  let handle;
  try {
    const before = await lstat(path, { bigint: true });
    if (!before.isFile()) throw failure(400, '不能导出目录或链接。');
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    if (signature(before) !== signature(await handle.stat({ bigint: true }))) throw failure(409, '文件正在变化，请稍后重新导出。');
    const bytes = await handle.readFile();
    const [after, current] = await Promise.all([handle.stat({ bigint: true }), lstat(path, { bigint: true })]);
    if (!current.isFile() || signature(before) !== signature(after) || signature(before) !== signature(current)) {
      throw failure(409, '文件正在变化，请稍后重新导出。');
    }
    return { name, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch (error) {
    if (error.code === 'ENOENT') throw failure(404, '这个文件已不存在，请刷新文件列表。');
    throw error;
  } finally { await handle?.close(); }
}
