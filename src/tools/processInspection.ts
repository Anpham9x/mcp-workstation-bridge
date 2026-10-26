import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { inspectProcessIdentity, inspectScheduledTasks } from './workstationInspection.js';
import { redactSensitiveData, resolveAndValidatePath } from '../security/index.js';

const execFileAsync = promisify(execFile);
const LIMIT = 2 * 1024 * 1024;

async function powershell(command: string): Promise<string> {
  const result = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { shell: false, timeout: 15_000, maxBuffer: LIMIT });
  return result.stdout;
}

function normalizeRows(value: unknown): any[] {
  if (value === null || value === undefined || value === '') return [];
  return Array.isArray(value) ? value : [value];
}

function sanitizeProcessRows(rows: any[], workspacePath?: string): unknown[] {
  const needle = workspacePath?.replace(/[\\/]+$/, '').toLowerCase();
  return rows
    .filter((row) => {
      if (!needle) return true;
      const executablePath = String(row.ExecutablePath || '').toLowerCase();
      const commandLine = String(row.CommandLine || '').toLowerCase();
      return executablePath.startsWith(needle) || commandLine.includes(needle);
    })
    .map((row) => ({
      ProcessId: row.ProcessId,
      ParentProcessId: row.ParentProcessId ?? null,
      Name: row.Name,
      ExecutablePath: row.ExecutablePath ?? null,
      WorkingSetSize: row.WorkingSetSize ?? null,
      CreationDate: row.CreationDate ?? null,
      InspectionSource: row.InspectionSource ?? 'cim',
    }));
}

export async function listWorkspaceProcesses(workspacePath?: string): Promise<unknown[]> {
  if (workspacePath) workspacePath = resolveAndValidatePath(workspacePath);
  try {
    const raw = await powershell("Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,WorkingSetSize,CreationDate,CommandLine,@{N='InspectionSource';E={'cim'}} | ConvertTo-Json -Compress");
    return sanitizeProcessRows(normalizeRows(JSON.parse(raw || '[]')), workspacePath);
  } catch {
    // Hardened Windows sessions can deny Win32_Process CIM entirely.
    // Fall back to Get-Process so read-only inspection remains available.
    const raw = await powershell("$rows = Get-Process | ForEach-Object { $path = $null; $started = $null; try { $path = $_.Path } catch {}; try { $started = $_.StartTime.ToString('o') } catch {}; [pscustomobject]@{ ProcessId=$_.Id; ParentProcessId=$null; Name=$_.ProcessName; ExecutablePath=$path; WorkingSetSize=$_.WorkingSet64; CreationDate=$started; CommandLine=$null; InspectionSource='get-process-fallback' } }; $rows | ConvertTo-Json -Compress");
    // Get-Process cannot expose command lines without elevated/WMI access.
    // Workspace filtering stays conservative: only executables physically under the workspace match.
    return sanitizeProcessRows(normalizeRows(JSON.parse(raw || '[]')), workspacePath);
  }
}

export async function listLocalPorts(): Promise<unknown[]> {
  // Get-NetTCPConnection can require privileges in hardened Windows sessions.
  // netstat -ano is read-only and works for standard interactive users.
  const { stdout } = await execFileAsync('netstat.exe', ['-ano', '-p', 'tcp'], {
    shell: false,
    timeout: 15_000,
    maxBuffer: LIMIT,
  });
  const rows: Array<Record<string, unknown>> = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!/^TCP\s+/i.test(line)) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 5 || parts[3].toUpperCase() !== 'LISTENING') continue;
    const local = parts[1];
    const lastColon = local.lastIndexOf(':');
    if (lastColon <= 0) continue;
    let address = local.slice(0, lastColon);
    const port = Number.parseInt(local.slice(lastColon + 1), 10);
    if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
    if (!['127.0.0.1', '0.0.0.0', '::1', '::'].includes(address)) continue;
    if (!Number.isInteger(port)) continue;
    rows.push({
      LocalAddress: address,
      LocalPort: port,
      OwningProcess: Number.parseInt(parts[4], 10),
      State: 'Listen',
      InspectionSource: 'netstat',
    });
  }
  return rows;
}

export function registerProcessInspectionTools(server: McpServer, options: { includeCheckProcessHealth?: boolean } = {}): void {
  server.registerTool('list_workspace_processes', {
    description: 'Inspect processes without manual PowerShell. action=metadata (default); action=identity requires workspacePath and pids, returns parent/start time and workspace script paths with all other arguments omitted; action=scheduled_tasks requires workspacePath, returns running task actions with projected arguments. Never kills processes or changes tasks. Missing evidence is reported explicitly.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: z.object({ action: z.enum(['metadata', 'identity', 'scheduled_tasks']).optional(), workspacePath: z.string().optional(),
      pids: z.array(z.number().int().positive().max(2147483647)).min(1).max(32).optional(), taskName: z.string().max(128).optional() }).strict()
  }, async ({ action, workspacePath, pids, taskName }) => {
    try {
      if (action && action !== 'metadata' && !workspacePath) throw new Error('WORKSPACE_REQUIRED');
      const result = action === 'identity' ? await inspectProcessIdentity(workspacePath!, pids ?? [])
        : action === 'scheduled_tasks' ? await inspectScheduledTasks(workspacePath!, taskName)
        : { success: true, processes: await listWorkspaceProcesses(workspacePath) };
      return { isError: !result.success, content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) { return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: redactSensitiveData((error as Error).message) }) }] }; }
  });
  server.registerTool('list_local_ports', { description: 'Read-only listening TCP ports and owning PIDs', inputSchema: z.object({}) }, async () => ({ content: [{ type: 'text', text: JSON.stringify({ success: true, ports: await listLocalPorts() }, null, 2) }] }));
  if (options.includeCheckProcessHealth !== false) {
    server.registerTool('check_process_health', { description: 'Read-only process existence check by PID', inputSchema: z.object({ pid: z.number().int().positive() }) }, async ({ pid }) => {
      const processes = await listWorkspaceProcesses();
      const process = processes.find((item: any) => Number(item.ProcessId) === pid);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, pid, running: Boolean(process), process: process || null }, null, 2) }] };
    });
  }
}
