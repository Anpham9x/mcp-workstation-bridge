import { execFile, spawn } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { isPowerShellEnabled } from '../security/httpAuth.js';
import { hasOwnerAccess } from '../security/ownerAccess.js';
import { redactSensitiveData, resolveAndValidatePath } from '../security/index.js';

const execFilePromise = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_COMMAND_LENGTH = 8_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_OUTPUT_LINES = 2_000;
const LOCAL_APPROVAL_TIMEOUT_MS = 20_000;
let approvalPromptActive = false;

const SAFE_VENV_DELETE_PREFIX = /^\s*Remove-Item\s+-Recurse\s+-Force\s+(?:\.venv|'\.venv'|"\.venv")\s*(?=;|\r?\n|$)/i;

const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /-(?:encodedcommand|enc)\b/i, reason: 'encoded PowerShell commands are forbidden' },
  { pattern: /\b(?:invoke-expression|iex)\b/i, reason: 'dynamic expression execution is forbidden' },
  { pattern: /(?:^|[;|\r\n])\s*[.&]\s+/i, reason: 'dynamic call and dot-sourcing operators are forbidden' },
  { pattern: /\b(?:invoke-command|enter-pssession|new-pssession)\b/i, reason: 'PowerShell remoting is forbidden' },
  { pattern: /\bstart-process\b[\s\S]*-verb\s+runas\b/i, reason: 'administrator elevation is forbidden' },
  { pattern: /\bstart-process\b/i, reason: 'detached child processes are forbidden' },
  { pattern: /\b(?:start-job|start-threadjob|register-objectevent|register-scheduledjob)\b/i, reason: 'background jobs are forbidden' },
  { pattern: /\b(?:runas|psexec)(?:\.exe)?\b/i, reason: 'privilege escalation tools are forbidden' },
  { pattern: /\b(?:cmd|powershell|pwsh|wscript|cscript|mshta|rundll32|regsvr32)(?:\.exe)?\b[\s\S]*(?:\/c|-command|-[ec]\b)/i, reason: 'nested shells and script hosts are forbidden' },
  { pattern: /\b(?:python|python3|py|node|ruby|perl)(?:\.exe)?\b[\s\S]*\s-(?:c|e)\s/i, reason: 'inline interpreter code is forbidden' },
  { pattern: /\bset-executionpolicy\b/i, reason: 'changing execution policy is forbidden' },
  { pattern: /\b(?:add|set|remove)-mppreference\b/i, reason: 'changing Defender policy is forbidden' },
  { pattern: /\b(?:format-volume|clear-disk|initialize-disk|remove-partition)\b/i, reason: 'disk-destructive commands are forbidden' },
  { pattern: /\b(?:stop-computer|restart-computer|shutdown)(?:\.exe)?\b/i, reason: 'shutdown and restart commands are forbidden' },
  { pattern: /\bremove-item\b[\s\S]*(?:-recurse|-force)/i, reason: 'recursive or forced deletion is forbidden' },
  { pattern: /\b(?:rm|ri|del|erase|rd|rmdir)\b[\s\S]*(?:-(?:r|recurse|fo|force)\b)/i, reason: 'recursive or forced deletion aliases are forbidden' },
  { pattern: /\b(?:del|erase|rd|rmdir)\b[\s\S]*\/(?:s|q)\b/i, reason: 'recursive or forced deletion is forbidden' },
  { pattern: /\b(?:new-service|set-service|remove-service|sc\.exe|schtasks(?:\.exe)?)\b/i, reason: 'service and scheduled-task changes are forbidden' },
  { pattern: /\b(?:net|net1)(?:\.exe)?\s+(?:user|localgroup)\b/i, reason: 'account and group changes are forbidden' },
  { pattern: /\b(?:reg(?:\.exe)?\s+(?:add|delete)|bcdedit|takeown|icacls)\b/i, reason: 'registry, boot, or ownership changes are forbidden' },
  { pattern: /\b(?:downloadstring|frombase64string|add-type|dllimport|start-bitstransfer|bitsadmin|certutil)\b/i, reason: 'download, decoding, or native-code loading is forbidden' },
  { pattern: /\b(?:invoke-webrequest|invoke-restmethod|iwr|irm|curl|wget|ftp|ssh|scp|sftp)(?:\.exe)?\b/i, reason: 'direct network commands are forbidden' },
  { pattern: /\b(?:system\.net|webclient|httpclient)\b/i, reason: 'direct network APIs are forbidden' },
  { pattern: /\[environment\]::getenvironmentvariable\b/i, reason: 'reading persistent environment secrets is forbidden' },
  { pattern: /\b(?:HKLM|HKCU|Registry)::?\\/i, reason: 'direct registry access is forbidden' },
  { pattern: /(?:^|[\s'"\\/])(?:\.env(?:\.[^\s'\"]*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_rsa|credentials|secrets)(?:$|[\s'\"])/i, reason: 'access to secret-like files is forbidden' },
  { pattern: /\b(?:get-credential|export-clixml)\b/i, reason: 'credential collection or export is forbidden' },
  { pattern: /\bconvertto-securestring\b[\s\S]*\b-asplaintext\b/i, reason: 'plaintext credential conversion is forbidden' },
];

export interface PowerShellResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  workingDirectory: string;
  error?: string;
}

export type PowerShellApprovalProvider = (command: string, workingDirectory: string) => Promise<boolean>;

function createMinimalEnvironment(): NodeJS.ProcessEnv {
  const allowedNames = [
    'SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP',
    'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'APPDATA',
    'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'OS', 'LANG'
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const name of allowedNames) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  env.POWERSHELL_TELEMETRY_OPTOUT = '1';
  return env;
}

function truncateOutput(value: string): { text: string; truncated: boolean } {
  const lines = value.split(/\r?\n/);
  const truncated = lines.length > MAX_OUTPUT_LINES;
  const selected = truncated ? lines.slice(0, MAX_OUTPUT_LINES) : lines;
  return {
    text: redactSensitiveData(selected.join('\n')),
    truncated
  };
}

export function validatePowerShellCommand(command: string): void {
  if (!command?.trim()) {
    throw new Error('PowerShell command must not be empty.');
  }
  if (command.length > MAX_COMMAND_LENGTH) {
    throw new Error(`PowerShell command exceeds the ${MAX_COMMAND_LENGTH}-character limit.`);
  }
  if (command.includes('\0')) {
    throw new Error('PowerShell command contains a null byte.');
  }
  const commandForPolicyScan = command.replace(SAFE_VENV_DELETE_PREFIX, '');

  for (const blocked of BLOCKED_PATTERNS) {
    if (blocked.pattern.test(commandForPolicyScan)) {
      throw new Error(`PowerShell command blocked: ${blocked.reason}.`);
    }
  }
}

function validateSafeVenvDeletionTarget(command: string, workingDirectory: string): void {
  if (!SAFE_VENV_DELETE_PREFIX.test(command)) return;

  const target = path.resolve(workingDirectory, '.venv');
  resolveAndValidatePath(target);
  if (!existsSync(target)) return;

  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) {
    throw new Error('PowerShell command blocked: .venv must not be a symbolic link or junction.');
  }
  if (!stat.isDirectory()) {
    throw new Error('PowerShell command blocked: .venv exists but is not a directory.');
  }
}

export async function requestLocalPowerShellApproval(command: string, workingDirectory: string, purpose: 'PowerShell'|'project bootstrap' = 'PowerShell'): Promise<boolean> {
  if (process.platform !== 'win32') {
    throw new Error('Local PowerShell approval is supported only on Windows.');
  }
  if (approvalPromptActive) {
    throw new Error('Another PowerShell approval prompt is already active.');
  }

  approvalPromptActive = true;
  try {
    const promptPayload = JSON.stringify({
      purpose,
      command: command.length > 3000 ? `${command.slice(0, 3000)}\n...[truncated]` : command,
      workingDirectory
    });
    const approvalScript = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json',
      '$message = "ChatGPT requests permission for " + $payload.purpose + ".\n\nWorking directory:\n" + $payload.workingDirectory + "\n\nAction:\n" + $payload.command',
      '$owner = New-Object System.Windows.Forms.Form',
      '$owner.TopMost = $true',
      '$owner.ShowInTaskbar = $false',
      '$owner.WindowState = [System.Windows.Forms.FormWindowState]::Minimized',
      '$owner.Show()',
      '$result = [System.Windows.Forms.MessageBox]::Show($owner, $message, "MCP Bridge approval", [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Warning)',
      '$owner.Close()',
      'if ($result -eq [System.Windows.Forms.DialogResult]::Yes) { [Console]::Out.Write("APPROVED") } else { [Console]::Out.Write("DENIED") }'
    ].join('; ');

    return await new Promise<boolean>((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', approvalScript], {
        windowsHide: false,
        shell: false,
        env: createMinimalEnvironment(),
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (error?: Error, approved = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(approved);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(new Error(`Local approval timed out after ${LOCAL_APPROVAL_TIMEOUT_MS} ms.`));
      }, LOCAL_APPROVAL_TIMEOUT_MS);
      child.stdout.on('data', chunk => { stdout += chunk.toString(); });
      child.stderr.on('data', chunk => { stderr += chunk.toString(); });
      child.on('error', error => finish(error));
      child.on('close', code => {
        if (code !== 0) {
          finish(new Error(redactSensitiveData(stderr || `Approval prompt exited with code ${code}.`)));
          return;
        }
        finish(undefined, stdout.trim() === 'APPROVED');
      });
      child.stdin.end(promptPayload);
    });
  } finally {
    approvalPromptActive = false;
  }
}

export async function executePowerShell(input: {
  workspacePath: string;
  command: string;
  timeoutMs?: number;
  confirmExecution: boolean;
}, requestApproval: PowerShellApprovalProvider = requestLocalPowerShellApproval): Promise<PowerShellResult> {
  const started = performance.now();
  let workingDirectory = '';

  try {
    if (!isPowerShellEnabled()) {
      throw new Error('PowerShell MCP execution is disabled. Set MCP_POWERSHELL_ENABLED=1.');
    }
    if (input.confirmExecution !== true) {
      throw new Error('PowerShell execution requires confirmExecution=true and per-action user approval.');
    }
    workingDirectory = resolveAndValidatePath(input.workspacePath);
    if(hasOwnerAccess()){
      if(!input.command?.trim()||input.command.length>MAX_COMMAND_LENGTH||input.command.includes('\0'))throw new Error('INVALID_POWERSHELL_COMMAND');
    }else{
      validatePowerShellCommand(input.command);
      validateSafeVenvDeletionTarget(input.command, workingDirectory);
    }
  } catch (error: any) {
    return {
      success: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      durationMs: performance.now() - started,
      timedOut: false,
      truncated: false,
      workingDirectory,
      error: error.message || 'PowerShell validation failed.'
    };
  }

  const timeoutMs = Math.min(Math.max(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000), MAX_TIMEOUT_MS);

  try {
    const approved = hasOwnerAccess() || await requestApproval(input.command, workingDirectory);
    if (!approved) {
      throw new Error('PowerShell command was denied by the local Windows user.');
    }
  } catch (error: any) {
    return {
      success: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      durationMs: performance.now() - started,
      timedOut: /timed out/i.test(error.message || ''),
      truncated: false,
      workingDirectory,
      error: error.message || 'Local PowerShell approval failed.'
    };
  }

  try {
    const { stdout, stderr } = await execFilePromise('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'RemoteSigned',
      '-Command', input.command
    ], {
      cwd: workingDirectory,
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      shell: false,
      env: createMinimalEnvironment()
    });
    const safeStdout = truncateOutput(stdout);
    const safeStderr = truncateOutput(stderr);
    return {
      success: true,
      exitCode: 0,
      stdout: safeStdout.text,
      stderr: safeStderr.text,
      durationMs: performance.now() - started,
      timedOut: false,
      truncated: safeStdout.truncated || safeStderr.truncated,
      workingDirectory
    };
  } catch (error: any) {
    const safeStdout = truncateOutput(String(error.stdout || ''));
    const safeStderr = truncateOutput(String(error.stderr || error.message || ''));
    const timedOut = error.killed === true || error.code === 'ETIMEDOUT';
    return {
      success: false,
      exitCode: typeof error.code === 'number' ? error.code : null,
      stdout: safeStdout.text,
      stderr: safeStderr.text,
      durationMs: performance.now() - started,
      timedOut,
      truncated: safeStdout.truncated || safeStderr.truncated,
      workingDirectory,
      error: timedOut ? `PowerShell command timed out after ${timeoutMs} ms.` : redactSensitiveData(error.message || 'PowerShell execution failed.')
    };
  }
}

export function registerPowerShellTool(server: McpServer, options: { trustOAuthGate?: boolean } = {}): void {
  if (!isPowerShellEnabled()) return;

  server.registerTool('run_powershell', {
    title: 'Run authenticated PowerShell',
    description: 'Run PowerShell on this Windows machine. Standing authenticated owner access allows project/file/Git/package commands across all paths available to the Windows account without per-project grants or local approval dialogs; confirmExecution=true records intent. Other callers retain scoped restrictions. No automatic Administrator elevation. Output and time are bounded.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true
    },
    securitySchemes: [{ type: 'oauth2', scopes: ['mcp:access', 'powershell:execute'] }],
    _meta: {
      securitySchemes: [{ type: 'oauth2', scopes: ['mcp:access', 'powershell:execute'] }]
    },
    inputSchema: z.object({
      workspacePath: z.string().describe('Absolute working directory; standing owner access permits all accessible directories'),
      command: z.string().min(1).max(MAX_COMMAND_LENGTH).describe('PowerShell command approved by the user for this call'),
      timeoutMs: z.number().int().min(1_000).max(MAX_TIMEOUT_MS).optional().describe('Execution timeout; default 30000 ms, maximum 120000 ms'),
      confirmExecution: z.literal(true).describe('Must be true after the user approves this specific command')
    })
  } as any, async (input: any) => ({
    content: [{
      type: 'text',
      text: JSON.stringify(await executePowerShell(
        input,
        options.trustOAuthGate ? async () => true : requestLocalPowerShellApproval
      ), null, 2)
    }]
  }));
}
