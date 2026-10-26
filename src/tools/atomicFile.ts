import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
export async function readOptional(file: string): Promise<Buffer | null> {
  try { const stat=await fs.stat(file);if(!stat.isFile()||stat.size>5*1024*1024)throw new Error('FILE_TOO_LARGE_OR_NOT_REGULAR');return await fs.readFile(file); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e;
  }
}
export async function assertNoLinks(file: string): Promise<void> {
  let current = path.resolve(file);
  for (;;) {
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('PATH_LINK_DENIED'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
export async function atomicFile(file: string, bytes: Buffer, before: Buffer | null): Promise<void> {
  await assertNoLinks(file);
  const temp = path.join(path.dirname(file), '.bridge-write-' + randomUUID() + '.tmp');
  const mode = before === null ? 0o600 : (await fs.stat(file)).mode;
  const handle = await fs.open(temp, 'wx', mode);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try {
    await assertNoLinks(file);
    const actual = await readOptional(file);
    if ((actual === null) !== (before === null) ||
      (actual && before && !actual.equals(before))) throw new Error('STALE_HASH');
    if (before === null) { await fs.link(temp, file); await fs.unlink(temp); }
    else await fs.rename(temp, file);
  } catch (e) { await fs.unlink(temp).catch(() => undefined); throw e; }
}

