import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { checkForbiddenFile, redactSensitiveData, resolveAndValidatePath } from '../security/index.js';
import { assertNoLinks } from './atomicFile.js';

const exec = promisify(execFile);
export type InspectionRunner = (command: string) => Promise<string>;
const run: InspectionRunner = async command => (await exec('powershell.exe',
  ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; ' + command],
  { shell: false, windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024 })).stdout;
const rows = (raw: string): any[] => { const value = JSON.parse(raw || '[]'); return value == null ? [] : Array.isArray(value) ? value : [value]; };

// Không trả command line thô: chỉ giữ script ở vị trí khởi chạy đã nhận diện.
// Script tương đối là candidate; không biết cwd thì không xác nhận workspace.
// Mọi giá trị tùy chọn, prompt, URL, inline code và tham số sau script đều bị bỏ.
export function projectInvocation(command: string | null, workspace: string) {
  if (!command) return { available: false, scriptPaths: [], relativeScriptCandidates: [], commandLine: null, workspaceMatch: false };
  const tokens = command.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
  const unquote = (token: string) => token.replace(/^["']|["']$/g, '');
  const executable = path.basename(unquote(tokens[0] ?? '')).toLowerCase();
  let candidate: string | undefined;
  if (/^(?:powershell|pwsh)(?:\.exe)?$/.test(executable)) {
    const fileIndex = tokens.findIndex(t => /^-file$/i.test(t));
    const codeIndex = tokens.findIndex(t => /^-(?:command|c|encodedcommand|enc)$/i.test(t));
    if (fileIndex > 0 && (codeIndex < 0 || fileIndex < codeIndex)) candidate = tokens[fileIndex + 1];
  } else if (/^(?:python(?:\d+(?:\.\d+)?)?|pythonw|py|node)(?:\.exe)?$/.test(executable)) {
    let index = 1;
    while (index < tokens.length && /^(?:-u|-B|-I|-E|-s|-S|--no-warnings|--inspect(?:-brk)?(?:=[^\s]+)?)$/.test(tokens[index])) index++;
    if (tokens[index] && !tokens[index].startsWith('-')) candidate = tokens[index];
  } else if (/\.(?:ps1|py|js|mjs|cjs|ts)$/i.test(executable)) candidate = tokens[0];
  const scriptPaths: string[] = [];
  const relativeScriptCandidates: string[] = [];
  for (const token of candidate ? [candidate] : []) {
    const value = unquote(token);
    if (!/\.(?:ps1|py|js|mjs|cjs|ts)$/i.test(value) || /[\x00-\x1f*?]/.test(value)) continue;
    if (value.split(/[\\/]/).some(s => checkForbiddenFile(s))) continue;
    if (!path.isAbsolute(value)) {
      if (value.includes(':') || value.split(/[\\/]/).some(s => s === '..')) continue;
      try { resolveAndValidatePath(path.resolve(workspace, value)); relativeScriptCandidates.push(redactSensitiveData(value)); } catch { /* Chặn candidate không an toàn. */ }
      continue;
    }
    const relative = path.relative(workspace, value);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !relative) continue;
    try { resolveAndValidatePath(value); scriptPaths.push(redactSensitiveData(value)); } catch { /* Bỏ đường dẫn bị policy chặn. */ }
  }
  return { available: true, scriptPaths, relativeScriptCandidates,
    commandLine: [...scriptPaths, ...relativeScriptCandidates].length ? [...scriptPaths, ...relativeScriptCandidates].map(p => JSON.stringify(p)).join(' ') + ' [other arguments omitted]' : '[arguments omitted]',
    workspaceMatch: scriptPaths.length > 0 };
}

export async function inspectProcessIdentity(workspacePath: string, pids: number[], runner: InspectionRunner = run) {
  const workspace = resolveAndValidatePath(workspacePath); await assertNoLinks(workspace);
  if (!pids.length || pids.length > 32 || pids.some(p => !Number.isSafeInteger(p) || p <= 0 || p > 2147483647)) throw new Error('INVALID_PID_LIST');
  const filter = [...new Set(pids)].map(p => `ProcessId=${p}`).join(' OR ');
  try {
    const raw = await runner(`Get-CimInstance Win32_Process -Filter '${filter}' -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CreationDate,CommandLine | ConvertTo-Json -Compress`);
    const found = rows(raw);
    return { success: true, source: 'cim', workspacePath: workspace,
      missingPids: pids.filter(p => !found.some(r => Number(r.ProcessId) === p)),
      processes: found.map(r => ({ pid: r.ProcessId, parentPid: r.ParentProcessId, name: redactSensitiveData(String(r.Name)),
        executablePath: r.ExecutablePath ? redactSensitiveData(String(r.ExecutablePath)) : null,
        createdAt: r.CreationDate, invocation: projectInvocation(r.CommandLine, workspace) })),
      limitation: 'Absolute script paths match the workspace lexically; relativeScriptCandidates have unknown process cwd. Neither path hints, omitted arguments nor missing command lines prove ownership or absence of competing writers.' };
  } catch (error) {
    return { success: false, error: 'PROCESS_IDENTITY_UNAVAILABLE', detail: redactSensitiveData((error as Error).message),
      nextAction: 'Check bridge Windows account access to Win32_Process; do not infer process ownership or stop processes from incomplete metadata.' };
  }
}

export async function inspectScheduledTasks(workspacePath: string, taskName?: string, runner: InspectionRunner = run) {
  const workspace = resolveAndValidatePath(workspacePath); await assertNoLinks(workspace);
  if (taskName && (taskName.length > 128 || /[\x00-\x1f]/.test(taskName))) throw new Error('INVALID_TASK_NAME');
  try {
    const raw = await runner("$tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.State -eq 'Running' }); if ($tasks.Count -gt 256) { throw 'TASK_LIMIT_EXCEEDED' }; $tasks | ForEach-Object { [pscustomobject]@{ Name=$_.TaskName; Path=$_.TaskPath; State=[string]$_.State; Actions=@($_.Actions | Select-Object Execute,Arguments,WorkingDirectory) } } | ConvertTo-Json -Depth 5 -Compress");
    const tasks = rows(raw).filter(t => !taskName || t.Name === taskName).map(t => ({
      name: redactSensitiveData(String(t.Name)), path: redactSensitiveData(String(t.Path)), state: t.State,
      actions: (Array.isArray(t.Actions) ? t.Actions : []).slice(0, 16).map((a: any) => ({
        execute: redactSensitiveData(String(a.Execute ?? '')), workingDirectory: redactSensitiveData(String(a.WorkingDirectory ?? '')),
        invocation: projectInvocation('"' + String(a.Execute ?? '').replace(/"/g, '') + '" ' + String(a.Arguments ?? ''), workspace) })),
      actionsTruncated: (Array.isArray(t.Actions) ? t.Actions.length : 0) > 16 }));
    return { success: true, tasks, runningOnly: true,
      limitation: 'Task actions are candidates, not proof that a task launched a specific PID. Relative script candidates require cwd verification; all other arguments are omitted.' };
  } catch (error) {
    return { success: false, error: 'SCHEDULED_TASK_INSPECTION_UNAVAILABLE', detail: redactSensitiveData((error as Error).message),
      nextAction: 'Check bridge Windows account access to ScheduledTasks; no task is changed.' };
  }
}
