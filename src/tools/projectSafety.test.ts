import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { assertSafePackageSpec, evaluateWorkspacePolicy } from '../security/index.js';
import {
  createProjectTaskReport,
  gitSafeCommitSummary,
  installPackageSafe,
  registerProjectSafetyTools
} from './projectSafety.js';

const execFilePromise = promisify(execFile);
const fixtureRoot = path.resolve('tmp-project-safety-test');

console.log('Starting Project Safety Tools Unit Tests...');

async function resetFixture(): Promise<void> {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(fixtureRoot, '.ai'), { recursive: true });
  await fs.writeFile(
    path.join(fixtureRoot, 'package.json'),
    JSON.stringify({ name: 'project-safety-fixture', version: '1.0.0' }, null, 2),
    'utf8'
  );
  await fs.writeFile(path.join(fixtureRoot, 'package-lock.json'), '{}\n', 'utf8');
  await fs.writeFile(
    path.join(fixtureRoot, '.ai', 'mcp-bridge.project.json'),
    JSON.stringify({
      writeScope: ['src/**', 'ai_docs/**'],
      protectedFiles: ['.env'],
      install: {
        requireConfirmation: true,
        defaultDryRun: true,
        blockPackages: ['danger-package'],
        allowVersionSpecs: true
      }
    }, null, 2),
    'utf8'
  );
  await execFilePromise('git', ['init'], { cwd: fixtureRoot });
  await execFilePromise('git', ['config', 'user.name', 'Codex Lien'], { cwd: fixtureRoot });
  await execFilePromise('git', ['config', 'user.email', 'codex-lien@example.local'], { cwd: fixtureRoot });
  await execFilePromise('git', ['add', '.'], { cwd: fixtureRoot });
  await execFilePromise('git', ['commit', '-m', 'fixture baseline'], { cwd: fixtureRoot });
}

function assertRejectsMessage(fn: () => Promise<unknown> | unknown, expected: string): Promise<void> | void {
  try {
    const result = fn();
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      return (result as Promise<unknown>).then(
        () => assert.fail(`Expected rejection containing ${expected}`),
        (error) => assert.ok(String(error.message || error).includes(expected), `Expected "${error.message}" to include "${expected}"`)
      );
    }
    assert.fail(`Expected throw containing ${expected}`);
  } catch (error: any) {
    assert.ok(String(error.message || error).includes(expected), `Expected "${error.message}" to include "${expected}"`);
  }
}

function getTool(server: McpServer, name: string) {
  const registeredTools = (server as any)._registeredTools;
  const tool = registeredTools?.[name];
  if (!tool) {
    throw new Error(`Tool '${name}' was not registered.`);
  }
  return {
    execute: async (args: any) => tool.handler(args)
  };
}

async function runTests(): Promise<void> {
  await resetFixture();
  try {
    console.log('- Testing package spec validation...');
    assert.doesNotThrow(() => assertSafePackageSpec('zod'));
    assert.doesNotThrow(() => assertSafePackageSpec('@types/node@latest'));
    assertRejectsMessage(() => assertSafePackageSpec('https://example.com/pkg.tgz'), 'not allowed');
    assertRejectsMessage(() => assertSafePackageSpec('git+https://example.com/repo.git'), 'not allowed');
    assertRejectsMessage(() => assertSafePackageSpec('../local-package'), 'not allowed');

    console.log('- Testing validate workspace policy install decisions...');
    const installDecision = evaluateWorkspacePolicy({
      workspacePath: fixtureRoot,
      action: 'install',
      command: 'zod'
    });
    assert.strictEqual(installDecision.allowed, true);
    assert.strictEqual(installDecision.matchedRule, 'SAFE_PACKAGE_INSTALL_SPEC');
    const unsafeDecision = evaluateWorkspacePolicy({
      workspacePath: fixtureRoot,
      action: 'install',
      command: 'https://example.com/pkg.tgz'
    });
    assert.strictEqual(unsafeDecision.allowed, false);

    console.log('- Testing install_package_safe guardrails before execution...');
    await assertRejectsMessage(
      () => installPackageSafe({ workspacePath: fixtureRoot, packageSpec: 'zod', dryRun: false }),
      'INSTALL_CONFIRMATION_REQUIRED'
    );
    await assertRejectsMessage(
      () => installPackageSafe({ workspacePath: fixtureRoot, packageSpec: 'danger-package', dryRun: true }),
      'blocked by project config'
    );
    await assertRejectsMessage(
      () => installPackageSafe({ workspacePath: fixtureRoot, packageSpec: 'file:../pkg', dryRun: true }),
      'not allowed'
    );

    console.log('- Testing create_project_task_report no-overwrite behavior...');
    const report = await createProjectTaskReport({
      workspacePath: fixtureRoot,
      reportName: 'MCP-M12 Smoke Report',
      title: 'MCP-M12 Smoke Report',
      content: 'Policy validation and report generation passed.'
    });
    assert.strictEqual(report.success, true);
    assert.ok(report.relativePath.startsWith('.ai/reports/'));
    assert.ok(await fs.stat(report.reportPath));
    await assertRejectsMessage(
      () => createProjectTaskReport({
        workspacePath: fixtureRoot,
        reportName: 'MCP-M12 Smoke Report',
        title: 'Duplicate',
        content: 'Should not overwrite.'
      }),
      'REPORT_EXISTS'
    );

    console.log('- Testing git_safe_commit_summary risk note validation...');
    const packagePath = path.join(fixtureRoot, 'package.json');
    const packageJson = JSON.parse(await fs.readFile(packagePath, 'utf8'));
    packageJson.dependencies = { zod: '^3.25.76' };
    await fs.writeFile(packagePath, JSON.stringify(packageJson, null, 2), 'utf8');
    await assertRejectsMessage(
      () => gitSafeCommitSummary({ repoPath: fixtureRoot }),
      'RISK_NOTES_REQUIRED'
    );
    const summary = await gitSafeCommitSummary({
      repoPath: fixtureRoot,
      riskNotes: 'Dependency metadata changed only in fixture.'
    });
    assert.strictEqual(summary.success, true);
    assert.strictEqual(summary.commitsCreated, 0);
    assert.ok(summary.riskFlags.some((flag: string) => flag.includes('dependency/config')));
    assert.ok(summary.suggestedCommit.title.includes('package.json'));

    console.log('- Testing MCP tool registration wrappers...');
    const mockServer = new McpServer({ name: 'test-server', version: '1.0.0' });
    registerProjectSafetyTools(mockServer);
    const validateTool = getTool(mockServer, 'validate_workspace_policy');
    const validateResult = await validateTool.execute({ workspacePath: fixtureRoot, action: 'read', targetPath: 'package.json' });
    assert.strictEqual(validateResult.isError, undefined);
    const validateData = JSON.parse(validateResult.content[0].text);
    assert.strictEqual(validateData.decision.allowed, true);

    const reportTool = getTool(mockServer, 'create_project_task_report');
    const reportToolResult = await reportTool.execute({
      workspacePath: fixtureRoot,
      reportName: 'tool-report',
      title: 'Tool Report',
      content: 'Created through registered tool.'
    });
    assert.strictEqual(reportToolResult.isError, undefined);

    const commitTool = getTool(mockServer, 'git_safe_commit_summary');
    const blockedSummary = await commitTool.execute({ repoPath: fixtureRoot });
    assert.strictEqual(blockedSummary.isError, true);

    console.log('All Project Safety Tools Unit Tests Passed successfully!');
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
}

runTests().catch((error) => {
  console.error('Project Safety Tools Unit Test failed:', error);
  process.exit(1);
});
