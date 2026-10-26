import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { redactSensitiveData, resolveAndValidatePath } from "../security/index.js";
import { requestLocalPowerShellApproval } from "./powerShell.js";
import { hasOwnerAccess } from '../security/ownerAccess.js';

const execFilePromise = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_OUTPUT_LINES = 2_000;
const BRIDGE_PROJECT_ROOT = process.cwd();

export const SAFE_POWERSHELL_OPERATIONS = [
  "session_info",
  "process_details",
  "list_tcp_listeners",
  "scheduled_task_status",
  "service_status",
  "stop_process_guarded",
  "install_bridge_autostart",
  "start_bridge_bootstrap",
  "restart_bridge_runtime_guarded",
] as const;

export type SafePowerShellOperation = typeof SAFE_POWERSHELL_OPERATIONS[number];

export interface SafePowerShellInput {
  workspacePath: string;
  operation: SafePowerShellOperation;
  pid?: number;
  taskName?: string;
  serviceName?: string;
  expectedCommandLineContains?: string;
  timeoutMs?: number;
  confirmExecution: true;
}

export interface SafePowerShellResult {
  success: boolean;
  operation: SafePowerShellOperation;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  workingDirectory: string;
  error?: string;
}

function createMinimalEnvironment(): NodeJS.ProcessEnv {
  const allowedNames = [
    "SystemRoot", "WINDIR", "ComSpec", "PATH", "PATHEXT", "TEMP", "TMP",
    "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA",
    "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "OS", "LANG"
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const name of allowedNames) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  env.POWERSHELL_TELEMETRY_OPTOUT = "1";
  return env;
}

function truncateOutput(value: string): { text: string; truncated: boolean } {
  const lines = value.split(/\r?\n/);
  const truncated = lines.length > MAX_OUTPUT_LINES;
  const selected = truncated ? lines.slice(0, MAX_OUTPUT_LINES) : lines;
  return { text: redactSensitiveData(selected.join("\n")), truncated };
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function requireSafeText(value: string | undefined, field: string, maxLength = 300): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${field} is required for this operation.`);
  if (normalized.length > maxLength) throw new Error(`${field} exceeds the ${maxLength}-character limit.`);
  if (/[\0\r\n]/.test(normalized)) throw new Error(`${field} contains forbidden control characters.`);
  return normalized;
}

function requirePid(pid: number | undefined): number {
  if (!Number.isInteger(pid) || (pid ?? 0) <= 0) throw new Error("pid must be a positive integer.");
  return pid as number;
}

function requireBridgeWorkspace(workingDirectory: string): string {
  const resolved = path.resolve(workingDirectory);
  if (resolved.toLowerCase() !== BRIDGE_PROJECT_ROOT.toLowerCase()) {
    throw new Error(`This bridge-maintenance operation is restricted to ${BRIDGE_PROJECT_ROOT}.`);
  }
  return resolved;
}

export interface SafePowerShellCommand {
  command: string;
  mutating: boolean;
  localApprovalRequired?: boolean;
}

export function buildSafePowerShellCommand(
  input: SafePowerShellInput,
  workingDirectory: string,
): SafePowerShellCommand {
  switch (input.operation) {
    case "session_info":
      return {
        mutating: false,
        command: [
          "$p = Get-Process -Id $PID",
          "$sessionName = try { (Get-Process -Id $PID).SessionId } catch { $null }",
          "[ordered]@{ User = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name; ProcessId = $PID; SessionId = $p.SessionId; UserInteractive = [Environment]::UserInteractive; MachineName = $env:COMPUTERNAME } | ConvertTo-Json -Compress",
        ].join("; "),
      };

    case "process_details": {
      const pid = requirePid(input.pid);
      return {
        mutating: false,
        command: [
          `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue`,
          `if (-not $p) { throw "Process ${pid} was not found." }`,
          `$gp = Get-Process -Id ${pid} -ErrorAction Stop`,
          "[ordered]@{ ProcessId = $p.ProcessId; ParentProcessId = $p.ParentProcessId; Name = $p.Name; ExecutablePath = $p.ExecutablePath; CommandLine = $p.CommandLine; SessionId = $gp.SessionId; StartTime = $gp.StartTime } | ConvertTo-Json -Compress",
        ].join("; "),
      };
    }

    case "list_tcp_listeners":
      return {
        mutating: false,
        command: "netstat -ano -p tcp | Select-String 'LISTENING' | ForEach-Object { $_.Line }",
      };

    case "scheduled_task_status": {
      const taskName = quotePowerShellLiteral(requireSafeText(input.taskName, "taskName", 200));
      return {
        mutating: false,
        command: [
          `$t = Get-ScheduledTask -TaskName ${taskName} -ErrorAction Stop`,
          `$i = Get-ScheduledTaskInfo -TaskName ${taskName} -ErrorAction Stop`,
          "[ordered]@{ TaskName = $t.TaskName; State = [string]$t.State; LastRunTime = $i.LastRunTime; LastTaskResult = $i.LastTaskResult; NextRunTime = $i.NextRunTime; Actions = @($t.Actions | ForEach-Object { [ordered]@{ Execute = $_.Execute; Arguments = $_.Arguments; WorkingDirectory = $_.WorkingDirectory } }); Triggers = @($t.Triggers | ForEach-Object { [ordered]@{ Enabled = $_.Enabled; StartBoundary = $_.StartBoundary; RepetitionInterval = $_.Repetition.Interval; RepetitionDuration = $_.Repetition.Duration } }) } | ConvertTo-Json -Depth 6 -Compress",
        ].join("; "),
      };
    }

    case "service_status": {
      const serviceName = quotePowerShellLiteral(requireSafeText(input.serviceName, "serviceName", 120));
      return {
        mutating: false,
        command: `Get-Service -Name ${serviceName} -ErrorAction Stop | Select-Object Name,DisplayName,Status,StartType | ConvertTo-Json -Compress`,
      };
    }

    case "stop_process_guarded": {
      const pid = requirePid(input.pid);
      const expected = quotePowerShellLiteral(requireSafeText(input.expectedCommandLineContains, "expectedCommandLineContains", 300));
      return {
        mutating: true,
        command: [
          `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue`,
          `if (-not $p) { throw "Process ${pid} was not found." }`,
          `$expected = ${expected}`,
          "if ([string]::IsNullOrWhiteSpace($p.CommandLine) -or $p.CommandLine.IndexOf($expected, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { throw 'Process command line did not match the required guard text.' }",
          `Stop-Process -Id ${pid} -Force -Confirm:$false -ErrorAction Stop`,
          `[ordered]@{ stopped = $true; ProcessId = ${pid}; Name = $p.Name } | ConvertTo-Json -Compress`,
        ].join("; "),
      };
    }

    case "install_bridge_autostart": {
      const bridgeRoot = requireBridgeWorkspace(workingDirectory);
      const scriptPath = path.join(bridgeRoot, "scripts", "install-autostart.ps1");
      if (!existsSync(scriptPath)) throw new Error(`Missing bridge autostart script: ${scriptPath}`);
      return {
        mutating: true,
        command: `& ${quotePowerShellLiteral(scriptPath)}`,
      };
    }

    case "start_bridge_bootstrap": {
      const bridgeRoot = requireBridgeWorkspace(workingDirectory);
      const scriptPath = path.join(bridgeRoot, "scripts", "start-local-only-tunnel.ps1");
      if (!existsSync(scriptPath)) throw new Error(`Missing bridge bootstrap script: ${scriptPath}`);
      return {
        mutating: true,
        localApprovalRequired: false,
        command: `& ${quotePowerShellLiteral(scriptPath)}`,
      };
    }

    case "restart_bridge_runtime_guarded": {
      const bridgeRoot = requireBridgeWorkspace(workingDirectory);
      const scriptPath = path.join(bridgeRoot, "scripts", "request-runtime-restart.ps1");
      if (!existsSync(scriptPath)) throw new Error(`Missing guarded bridge restart script: ${scriptPath}`);
      return {
        mutating: true,
        localApprovalRequired: false,
        command: `& ${quotePowerShellLiteral(scriptPath)}`,
      };
    }

    default:
      throw new Error("Unsupported safe PowerShell operation.");
  }
}

export async function executeSafePowerShell(input: SafePowerShellInput): Promise<SafePowerShellResult> {
  const started = performance.now();
  let workingDirectory = "";

  try {
    if (input.confirmExecution !== true) {
      throw new Error("Safe PowerShell execution requires confirmExecution=true.");
    }
    workingDirectory = resolveAndValidatePath(input.workspacePath);
    const built = buildSafePowerShellCommand(input, workingDirectory);

    if (built.mutating && built.localApprovalRequired !== false && !hasOwnerAccess()) {
      const approved = await requestLocalPowerShellApproval(built.command, workingDirectory);
      if (!approved) throw new Error("Safe PowerShell operation was denied by the local Windows user.");
    }

    const timeoutMs = Math.min(Math.max(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000), MAX_TIMEOUT_MS);
    const { stdout, stderr } = await execFilePromise("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "RemoteSigned",
      "-Command", built.command,
    ], {
      cwd: workingDirectory,
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      shell: false,
      env: createMinimalEnvironment(),
    });

    const safeStdout = truncateOutput(stdout);
    const safeStderr = truncateOutput(stderr);
    return {
      success: true,
      operation: input.operation,
      exitCode: 0,
      stdout: safeStdout.text,
      stderr: safeStderr.text,
      durationMs: performance.now() - started,
      timedOut: false,
      truncated: safeStdout.truncated || safeStderr.truncated,
      workingDirectory,
    };
  } catch (error: any) {
    const safeStdout = truncateOutput(String(error.stdout || ""));
    const safeStderr = truncateOutput(String(error.stderr || ""));
    const timedOut = error.killed === true || error.code === "ETIMEDOUT";
    return {
      success: false,
      operation: input.operation,
      exitCode: typeof error.code === "number" ? error.code : null,
      stdout: safeStdout.text,
      stderr: safeStderr.text,
      durationMs: performance.now() - started,
      timedOut,
      truncated: safeStdout.truncated || safeStderr.truncated,
      workingDirectory,
      error: timedOut
        ? "Safe PowerShell operation timed out."
        : redactSensitiveData(error.message || "Safe PowerShell operation failed."),
    };
  }
}

export function registerSafePowerShellTool(server: McpServer): void {
  server.registerTool("run_powershell_safe", {
    title: "Run guarded PowerShell operation",
    description: "Run one server-defined PowerShell operation on this Windows machine. Read-only inspection runs without a local approval dialog. The bridge-only bootstrap and guarded runtime restart also run unattended; all other mutating maintenance operations still require local Windows approval. Raw PowerShell strings are never accepted.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: z.object({
      workspacePath: z.string().describe("Absolute working directory inside an approved workspace root"),
      operation: z.enum(SAFE_POWERSHELL_OPERATIONS),
      pid: z.number().int().positive().optional(),
      taskName: z.string().min(1).max(200).optional(),
      serviceName: z.string().min(1).max(120).optional(),
      expectedCommandLineContains: z.string().min(1).max(300).optional(),
      timeoutMs: z.number().int().min(1_000).max(MAX_TIMEOUT_MS).optional(),
      confirmExecution: z.literal(true).describe("Must be true. Local Windows approval is required for guarded mutations except the bridge-only unattended bootstrap/restart operations."),
    }),
  } as any, async (input: any) => ({
    content: [{
      type: "text",
      text: JSON.stringify(await executeSafePowerShell(input), null, 2),
    }],
  }));
}
