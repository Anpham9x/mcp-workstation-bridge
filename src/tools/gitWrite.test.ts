import assert from 'node:assert';
import path from 'node:path';
import { executeGitWrite } from './gitWrite.js';

const repoPath = path.resolve('C:\\Users\\ExampleUser\\Documents\\mcp-antigravity-bridge');

async function run(): Promise<void> {
  console.log('Starting guarded Git write tests...');
  const preview = await executeGitWrite({ repoPath, operation: 'commit', message: 'test preview' });
  assert.strictEqual(preview.success, true);
  assert.strictEqual(preview.executed, false);
  assert.strictEqual(preview.confirmationRequired, true);
  assert.deepStrictEqual(preview.preview.args.slice(0, 2), ['git', 'commit']);

  const dryRun = await executeGitWrite({ repoPath, operation: 'push', branch: 'main', dryRun: true, confirm: true });
  assert.strictEqual(dryRun.executed, false);
  assert.strictEqual(dryRun.preview.args.join(' '), 'git push origin main');

  await assert.rejects(
    executeGitWrite({ repoPath, operation: 'merge', sourceBranch: 'main; git reset --hard' , confirm: true }),
    /valid branch name/
  );
  await assert.rejects(
    executeGitWrite({ repoPath, operation: 'stage', files: ['..\\outside.txt'], confirm: true }),
    /Invalid repository-relative file path/
  );
  await assert.rejects(
    executeGitWrite({ repoPath, operation: 'commit', message: 'x'.repeat(501), confirm: true }),
    /Commit message must be 1-500/
  );
  console.log('Guarded Git write tests passed.');
}

run().catch(error => { console.error(error); process.exit(1); });
