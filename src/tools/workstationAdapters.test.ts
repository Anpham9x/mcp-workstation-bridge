import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { inspectProcessIdentity, inspectScheduledTasks, projectInvocation } from './workstationInspection.js';
import { exportGitCheckpoint } from './gitCheckpoint.js';
import { registerProcessInspectionTools } from './processInspection.js';
import { registerGitFileDiffTool } from './gitFileDiff.js';
import { installCodingBoundary } from '../reliability/boundary.js';
import { setToolContext } from '../reliability/policy.js';
import { sha256 } from './atomicFile.js';

await fs.mkdir('scratch', { recursive: true });
const root = await fs.mkdtemp(path.resolve('scratch/workstation-adapters-'));
const script = path.join(root, 'worker.py');
const projected = projectInvocation(`python.exe "${script}" --token SUPER_SECRET --print "private prompt" --url https://user:password@example.invalid`, root);
assert.deepEqual(projected.scriptPaths, [script]);
assert.equal(projected.workspaceMatch, true);
assert.ok(!JSON.stringify(projected).includes('SUPER_SECRET'));
assert.ok(!JSON.stringify(projected).includes('private prompt'));
assert.equal(projectInvocation(`python.exe "${root}-other/worker.py"`, root).workspaceMatch, false);
assert.equal(projectInvocation(null, root).available, false);
assert.deepEqual(projectInvocation('node.exe dist/server.js --token SUPER_SECRET', root).relativeScriptCandidates, ['dist/server.js']);
assert.equal(projectInvocation('node.exe dist/server.js', root).workspaceMatch, false);
assert.equal(projectInvocation(`python.exe --token "${script}"`, root).scriptPaths.length, 0);
assert.equal(projectInvocation(`pwsh.exe -Command "${script}"`, root).scriptPaths.length, 0);
const identity = await inspectProcessIdentity(root, [123, 456], async command => {
  assert.ok(command.includes("'ProcessId=123 OR ProcessId=456'"));
  return JSON.stringify({ ProcessId: 123, ParentProcessId: 12, Name: 'python.exe', CommandLine: `python.exe "${script}" --password SUPER_SECRET` });
});
assert.equal(identity.success, true); assert.deepEqual(identity.missingPids, [456]);
assert.ok(!JSON.stringify(identity).includes('SUPER_SECRET'));
const denied = await inspectProcessIdentity(root, [123], async () => { throw new Error('Access denied'); });
assert.equal(denied.success, false); assert.equal(denied.error, 'PROCESS_IDENTITY_UNAVAILABLE');
await assert.rejects(() => inspectProcessIdentity(root, [1.2]));
await assert.rejects(() => inspectProcessIdentity('C:/Windows', [123]));
const tasks = await inspectScheduledTasks(root, 'Fixture', async command => {
  assert.ok(command.includes("$_.State -eq 'Running'"));
  return JSON.stringify([{ Name: 'Fixture', Path: '\\', State: 'Running', Actions: [{ Execute: 'python.exe', Arguments: `"${script}" --token SUPER_SECRET` }] }, { Name: 'Other', Actions: [] }]);
});
assert.equal(tasks.success, true); assert.equal(tasks.tasks?.length, 1);
assert.ok(!JSON.stringify(tasks).includes('SUPER_SECRET'));
assert.equal((await inspectScheduledTasks(root, undefined, async () => { throw new Error('Access denied'); })).success, false);

const git = (args: string[]) => execFileSync('git', ['-c', `safe.directory=${root}`, ...args], { cwd: root, encoding: 'utf8' }).trim();
git(['init', '--quiet']); git(['config', 'core.autocrlf', 'false']);
const before = Buffer.from('\uFEFFbase\r\nline two\r\n', 'utf8');
await fs.writeFile(path.join(root, 'a.txt'), before);
await fs.writeFile(path.join(root, 'binary.txt'), Buffer.from([1, 0, 2]));
await fs.writeFile(path.join(root, 'sensitive.txt'), 'token=secret-token-12345678');
git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'base']);
const base = git(['rev-parse', 'HEAD']);
const after = Buffer.from('wip\n'); await fs.writeFile(path.join(root, 'a.txt'), after);
git(['add', 'a.txt']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'wip']);
const checkpoint = git(['rev-parse', 'HEAD']);
await fs.writeFile(path.join(root, 'a.txt'), 'dirty working tree');
const statusBefore = git(['status', '--porcelain']);
const output = await exportGitCheckpoint(root, [{ commit: base, filePath: 'a.txt' }, { commit: checkpoint, filePath: 'a.txt' }, { commit: base, filePath: 'absent.txt' }]);
assert.ok((await fs.readFile(output.files[0].artifactPath!)).equals(before));
assert.ok((await fs.readFile(output.files[1].artifactPath!)).equals(after));
assert.equal(output.files[0].sha256, sha256(before)); assert.equal(output.files[2].present, false);
assert.equal(git(['status', '--porcelain']), statusBefore); assert.equal(git(['rev-parse', 'HEAD']), checkpoint);
for (const filePath of ['../a.txt', '.git/config', '.env', 'credentials/a.txt', 'binary.txt', 'sensitive.txt', 'a.txt:evil', 'node_modules/a.txt']) {
  await assert.rejects(() => exportGitCheckpoint(root, [{ commit: base, filePath }]));
}
await assert.rejects(() => exportGitCheckpoint(root, [{ commit: 'HEAD', filePath: 'a.txt' }]));
await assert.rejects(() => exportGitCheckpoint(root, [{ commit: '0'.repeat(40), filePath: 'a.txt' }]));
// Blob SHA không được giả làm commit; symlink tree entry bị từ chối.
const blob = git(['rev-parse', `${base}:a.txt`]);
await assert.rejects(() => exportGitCheckpoint(root, [{ commit: blob, filePath: 'a.txt' }]));
git(['update-index', '--add', '--cacheinfo', `120000,${blob},link.txt`]);
git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'link']);
await assert.rejects(() => exportGitCheckpoint(root, [{ commit: git(['rev-parse', 'HEAD']), filePath: 'link.txt' }]));

const server = new McpServer({ name: 'scoped-adapter-test', version: '1' });
setToolContext(server, { principal: 'fixture', requireScopes: true }); installCodingBoundary(server);
registerProcessInspectionTools(server); registerGitFileDiffTool(server);
const tools = (server as any)._registeredTools;
const call = (name: string, args: any) => tools[name].handler(args);
const exported = await call('git_file_diff', { action: 'export_checkpoint', repoPath: root, entries: [{ commit: base, filePath: 'a.txt' }] });
assert.ok(!exported.isError); assert.equal(JSON.parse(exported.content[0].text).success, true);
assert.equal((await call('list_workspace_processes', { action: 'identity', pids: [123] })).isError, true);
const diff = await call('git_file_diff', { repoPath: root, filePath: 'a.txt' }); assert.ok(!diff.isError);
if (process.argv.includes('--live')) {
  const live = await inspectProcessIdentity(path.resolve('.'), [process.pid]);
  console.log(JSON.stringify({ liveIdentitySuccess: live.success, error: live.error ?? null }));
  const scheduled = await inspectScheduledTasks(path.resolve('.'));
  console.log(JSON.stringify({ liveScheduledSuccess: scheduled.success, error: scheduled.error ?? null }));
}
console.log('workstation adapters: projected identity/tasks, fail-closed access, byte/hash export, unsafe paths/blobs, source invariance, scoped handlers and legacy diff PASS');
