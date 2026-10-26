import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveAndValidatePath, validatePathForRead, checkForbiddenFile, isBinaryBuffer, redactSensitiveData } from '../security/index.js';
import { assertNoLinks, sha256 } from './atomicFile.js';

const exec = promisify(execFile);
const artifactRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.mcp-artifacts/checkpoints');
export interface CheckpointEntry { commit: string; filePath: string }
export async function exportGitCheckpoint(repoPath: string, entries: CheckpointEntry[]) {
  const repo = resolveAndValidatePath(repoPath); await assertNoLinks(repo);
  if (!entries.length || entries.length > 40) throw new Error('CHECKPOINT_ENTRY_LIMIT');
  // Không thừa kế GIT_DIR/GIT_WORK_TREE/GIT_CONFIG_* từ môi trường runtime.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  env.GIT_OPTIONAL_LOCKS = '0'; env.GIT_NO_REPLACE_OBJECTS = '1'; env.GIT_CONFIG_NOSYSTEM = '1'; env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const git = async (args: string[]) => (await exec('git', ['-c', `safe.directory=${repo}`, '-c', 'core.fsmonitor=false', ...args],
    { cwd: repo, shell: false, windowsHide: true, timeout: 10000, maxBuffer: 6 * 1024 * 1024, encoding: 'buffer', env })).stdout;
  const realRepo = await fs.realpath(repo);
  if (path.resolve((await git(['rev-parse', '--show-toplevel'])).toString().trim()).toLowerCase() !== realRepo.toLowerCase()) throw new Error('EXACT_REPO_ROOT_REQUIRED');
  const prepared: Array<{ commit: string; filePath: string; bytes: Buffer | null; blob: string | null }> = [];
  let total = 0;
  for (const entry of entries) {
    if (!/^[a-f0-9]{40}$/i.test(entry.commit)) throw new Error('EXACT_COMMIT_SHA_REQUIRED');
    const relative = entry.filePath.replace(/\\/g, '/');
    if (!relative || relative.length > 240 || /^[\/]/.test(relative) || /[:\x00-\x1f*?]/.test(relative) || relative.split('/').some(s => !s || s === '.' || s === '..' || checkForbiddenFile(s))) throw new Error('INVALID_CHECKPOINT_PATH');
    validatePathForRead(path.join(repo, relative));
    if ((await git(['cat-file', '-t', entry.commit])).toString().trim() !== 'commit') throw new Error('COMMIT_REQUIRED');
    const listing = (await git(['ls-tree', '-z', entry.commit, '--', `:(literal)${relative}`])).toString();
    if (!listing) { prepared.push({ commit: entry.commit, filePath: relative, bytes: null, blob: null }); continue; }
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(listing);
    if (!match || match[3] !== relative) throw new Error('REGULAR_BLOB_REQUIRED');
    const size = Number((await git(['cat-file', '-s', match[2]])).toString().trim());
    if (!Number.isSafeInteger(size) || size < 0 || size > 5 * 1024 * 1024 || total + size > 20 * 1024 * 1024) throw new Error('CHECKPOINT_BYTE_LIMIT');
    const bytes = await git(['cat-file', 'blob', match[2]]);
    if (bytes.length !== size || isBinaryBuffer(bytes)) throw new Error('TEXT_BLOB_REQUIRED');
    if (redactSensitiveData(bytes.toString('utf8')) !== bytes.toString('utf8')) throw new Error('SENSITIVE_BLOB_DENIED');
    total += size; prepared.push({ commit: entry.commit, filePath: relative, bytes, blob: match[2] });
  }
  // Chỉ tạo artifact riêng của bridge, không nhận outputPath và không ghi repo nguồn.
  resolveAndValidatePath(artifactRoot); await assertNoLinks(artifactRoot);
  await fs.mkdir(artifactRoot, { recursive: true });
  const exportPath = path.join(artifactRoot, randomUUID()); await fs.mkdir(exportPath);
  const files = [];
  for (const [index, item] of prepared.entries()) {
    const artifact = item.bytes === null ? null : path.join(exportPath, `${index.toString().padStart(2, '0')}.blob`);
    if (artifact && item.bytes) { await fs.writeFile(artifact, item.bytes, { flag: 'wx', mode: 0o600 });
      if (sha256(await fs.readFile(artifact)) !== sha256(item.bytes)) throw new Error('ARTIFACT_HASH_MISMATCH'); }
    files.push({ commit: item.commit, filePath: item.filePath, blob: item.blob, present: item.bytes !== null,
      artifactPath: artifact, bytes: item.bytes?.length ?? 0, sha256: item.bytes === null ? null : sha256(item.bytes) });
  }
  const manifestPath = path.join(exportPath, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, repoPath: realRepo, files }, null, 2), { flag: 'wx', mode: 0o600 });
  return { success: true, exportPath, manifestPath, files, totalBytes: total, sourceGitStateModified: false, artifactOnly: true };
}
