import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { cleanupSessionTemp, prepareSessionTemp } from './bridgeTemp.js';

async function run(): Promise<void> {
  const workspace = path.resolve('C:\\Users\\ExampleUser\\Documents\\mcp-antigravity-bridge');
  const sessionId = 'test-session-016';
  const tempPath = await prepareSessionTemp(workspace, sessionId);
  assert.strictEqual(await fs.stat(tempPath).then(stat => stat.isDirectory()), true);
  const audit = await fs.readFile(path.join(workspace, '.bridge_tmp', 'audit.jsonl'), 'utf8');
  assert.ok(audit.includes('temp_session_create'));
  await cleanupSessionTemp(workspace, sessionId);
  await assert.rejects(fs.stat(tempPath));
  await assert.rejects(prepareSessionTemp(workspace, '../escape'), /sessionId/);
  await fs.rm(path.join(workspace, '.bridge_tmp'), { recursive: true, force: true });
  console.log('Bridge temp workspace and audit tests passed.');
}

run().catch(error => { console.error(error); process.exit(1); });
