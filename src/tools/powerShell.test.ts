import assert from 'node:assert';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  assertSecureRuntimeConfiguration,
  isAuthorizedRequest
} from '../security/httpAuth.js';
import { executePowerShell, validatePowerShellCommand } from './powerShell.js';
import { buildSafePowerShellCommand } from './safePowerShell.js';

const workspace = path.resolve('C:\\Users\\ExampleUser\\Documents\\mcp-antigravity-bridge');
const originalEnabled = process.env.MCP_POWERSHELL_ENABLED;
const originalToken = process.env.MCP_BRIDGE_BEARER_TOKEN;

async function run(): Promise<void> {
  try {
    delete process.env.MCP_POWERSHELL_ENABLED;
    delete process.env.MCP_BRIDGE_BEARER_TOKEN;

    const disabled = await executePowerShell({
      workspacePath: workspace,
      command: "Write-Output 'should-not-run'",
      confirmExecution: true
    });
    assert.strictEqual(disabled.success, false);
    assert.match(disabled.error || '', /disabled/);

    process.env.MCP_POWERSHELL_ENABLED = '1';
    process.env.MCP_BRIDGE_REQUIRE_BEARER = '1';
    assert.throws(() => assertSecureRuntimeConfiguration(), /requires MCP_BRIDGE_BEARER_TOKEN/);

    process.env.MCP_BRIDGE_BEARER_TOKEN = 'short';
    assert.throws(() => assertSecureRuntimeConfiguration(), /at least 32/);

    const token = 'unit-test-bearer-token-0123456789abcdef';
    process.env.MCP_BRIDGE_BEARER_TOKEN = token;
    assert.doesNotThrow(() => assertSecureRuntimeConfiguration());
    assert.strictEqual(isAuthorizedRequest(undefined), false);
    assert.strictEqual(isAuthorizedRequest('Bearer wrong-token'), false);
    assert.strictEqual(isAuthorizedRequest(`Bearer ${token}`), true);
    process.env.MCP_BRIDGE_REQUIRE_BEARER = '0';
    assert.strictEqual(isAuthorizedRequest(undefined), true);

    assert.throws(() => validatePowerShellCommand('iex $payload'), /dynamic expression/);
    assert.doesNotThrow(() => validatePowerShellCommand('Remove-Item -Recurse -Force .venv'));
    assert.doesNotThrow(() => validatePowerShellCommand("Remove-Item -Recurse -Force '.venv'"));
    assert.doesNotThrow(() => validatePowerShellCommand("Remove-Item -Recurse -Force .venv; Write-Output 'deleted'"));
    assert.throws(() => validatePowerShellCommand('Remove-Item .venv -Recurse -Force'), /deletion/);
    assert.throws(() => validatePowerShellCommand('Remove-Item -Recurse -Force ..\\other-project'), /deletion/);
    assert.throws(() => validatePowerShellCommand('Remove-Item -Recurse -Force .venv\\*'), /deletion/);
    assert.throws(() => validatePowerShellCommand('rm -r -fo .'), /deletion aliases/);
    assert.throws(() => validatePowerShellCommand('rmdir -Recurse -Force other-directory'), /deletion aliases/);
    assert.throws(() => validatePowerShellCommand("Write-Output 'before'\nRemove-Item -Recurse -Force .venv"), /deletion/);
    assert.throws(() => validatePowerShellCommand('Start-Process powershell -Verb RunAs'), /elevation/);
    assert.throws(() => validatePowerShellCommand('Invoke-RestMethod https://example.com'), /network/);
    assert.throws(() => validatePowerShellCommand('cmd.exe /c whoami'), /nested shells/);
    assert.throws(() => validatePowerShellCommand("python -c \"print('bypass')\""), /inline interpreter/);
    assert.throws(() => validatePowerShellCommand('Get-Content .env'), /secret-like files/);

    const unattendedBootstrap = buildSafePowerShellCommand({
      workspacePath: workspace,
      operation: 'start_bridge_bootstrap',
      confirmExecution: true
    }, workspace);
    assert.strictEqual(unattendedBootstrap.mutating, true);
    assert.strictEqual(unattendedBootstrap.localApprovalRequired, false);

    const unattendedRestart = buildSafePowerShellCommand({
      workspacePath: workspace,
      operation: 'restart_bridge_runtime_guarded',
      confirmExecution: true
    }, workspace);
    assert.strictEqual(unattendedRestart.mutating, true);
    assert.strictEqual(unattendedRestart.localApprovalRequired, false);
    assert.match(unattendedRestart.command, /request-runtime-restart\.ps1/i);

    const guardedStop = buildSafePowerShellCommand({
      workspacePath: workspace,
      operation: 'stop_process_guarded',
      pid: 123,
      expectedCommandLineContains: 'dist/server.js',
      confirmExecution: true
    }, workspace);
    assert.strictEqual(guardedStop.localApprovalRequired, undefined);

    assert.throws(() => buildSafePowerShellCommand({
      workspacePath: 'C:\\\\Users\\\\ExampleUser\\\\Documents\\\\other\\\\mcp-antigravity-bridge',
      operation: 'start_bridge_bootstrap',
      confirmExecution: true
    }, 'C:\\\\Users\\\\ExampleUser\\\\Documents\\\\other\\\\mcp-antigravity-bridge'), /restricted to/i);

    const unconfirmed = await executePowerShell({
      workspacePath: workspace,
      command: "Write-Output 'should-not-run'",
      confirmExecution: false
    });
    assert.strictEqual(unconfirmed.success, false);
    assert.match(unconfirmed.error || '', /confirmExecution=true/);

    const outside = await executePowerShell({
      workspacePath: 'C:\\Windows',
      command: "Write-Output 'should-not-run'",
      confirmExecution: true
    });
    assert.strictEqual(outside.success, false);
    assert.match(outside.error || '', /outside configured workspace roots/);

    const executed = await executePowerShell({
      workspacePath: workspace,
      command: "Write-Output 'powershell-mcp-ok'",
      confirmExecution: true,
      timeoutMs: 10_000
    }, async () => true);
    assert.strictEqual(executed.success, true, executed.error || executed.stderr);
    assert.match(executed.stdout, /powershell-mcp-ok/);
    assert.strictEqual(executed.exitCode, 0);

    const venvDeleteWorkspace = path.join(workspace, `.tmp-venv-delete-${process.pid}`);
    const venvPath = path.join(venvDeleteWorkspace, '.venv');
    await mkdir(venvPath, { recursive: true });
    await writeFile(path.join(venvPath, 'sentinel.txt'), 'safe-delete-test');
    const deletedVenv = await executePowerShell({
      workspacePath: venvDeleteWorkspace,
      command: "Remove-Item -Recurse -Force .venv; Write-Output 'venv-delete-ok'",
      confirmExecution: true
    }, async () => true);
    assert.strictEqual(deletedVenv.success, true, deletedVenv.error || deletedVenv.stderr);
    assert.match(deletedVenv.stdout, /venv-delete-ok/);
    await rm(venvDeleteWorkspace, { recursive: true, force: true });

    const secretOutput = await executePowerShell({
      workspacePath: workspace,
      command: "Write-Output 'token=super-secret-output-value'",
      confirmExecution: true
    }, async () => true);

    const denied = await executePowerShell({
      workspacePath: workspace,
      command: "Write-Output 'must-not-run'",
      confirmExecution: true
    }, async () => false);
    assert.strictEqual(denied.success, false);
    assert.match(denied.error || '', /denied by the local Windows user/);
    assert.strictEqual(secretOutput.success, true);
    assert.ok(!secretOutput.stdout.includes('super-secret-output-value'));
    assert.match(secretOutput.stdout, /\[REDACTED\]/);

    console.log('PowerShell MCP security and execution tests passed.');
  } finally {
    if (originalEnabled === undefined) delete process.env.MCP_POWERSHELL_ENABLED;
    else process.env.MCP_POWERSHELL_ENABLED = originalEnabled;
    if (originalToken === undefined) delete process.env.MCP_BRIDGE_BEARER_TOKEN;
    else process.env.MCP_BRIDGE_BEARER_TOKEN = originalToken;
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
