import fs from 'node:fs/promises';
import path from 'node:path';
import { ChildProcess, execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ALLOWED_WORKSPACE_ROOTS,
  assertAllowedDevServerScript,
  assertLocalBrowserUrl,
  evaluateWorkspacePolicy,
  redactSensitiveData,
  resolveAndValidatePath
} from "../security/index.js";

const execFilePromise = promisify(execFile);
const MAX_LOG_LINES = 1000;

export interface ManagedDevServer {
  id: string;
  workspacePath: string;
  projectPath: string;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun';
  script: string;
  command: string;
  args: string[];
  pid: number | null;
  url: string;
  startedAt: string;
  status: 'starting' | 'ready' | 'stopped' | 'crashed';
  exitCode: number | null;
  logs: string[];
  outputTruncated: boolean;
  process: ChildProcess;
}

const devServers = new Map<string, ManagedDevServer>();

function normalizeProjectPath(workspacePath: string, project?: string): string {
  const workspace = resolveAndValidatePath(workspacePath, ALLOWED_WORKSPACE_ROOTS);
  const candidate = project
    ? (path.isAbsolute(project) ? project : path.join(workspace, project))
    : workspace;
  const projectPath = resolveAndValidatePath(candidate, ALLOWED_WORKSPACE_ROOTS);
  const relative = path.relative(workspace, projectPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path validation failed: project '${projectPath}' is outside workspace '${workspace}'.`);
  }
  return projectPath;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function detectPackageManager(projectPath: string): Promise<ManagedDevServer['packageManager']> {
  if (await pathExists(path.join(projectPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await pathExists(path.join(projectPath, 'yarn.lock'))) return 'yarn';
  if (await pathExists(path.join(projectPath, 'bun.lockb')) || await pathExists(path.join(projectPath, 'bun.lock'))) return 'bun';
  return 'npm';
}

async function readPackageScripts(projectPath: string): Promise<Record<string, string>> {
  const packageJsonPath = path.join(projectPath, 'package.json');
  const decision = evaluateWorkspacePolicy({
    workspacePath: projectPath,
    action: 'read',
    targetPath: packageJsonPath
  });
  if (!decision.allowed) {
    throw new Error(decision.reason);
  }
  const parsed = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  return parsed.scripts && typeof parsed.scripts === 'object' ? parsed.scripts : {};
}

function commandForPackageScript(packageManager: ManagedDevServer['packageManager'], script: string): { command: string; args: string[]; display: string } {
  const args = ['run', script];
  return {
    command: packageManager,
    args,
    display: `${packageManager} run ${script}`
  };
}

function commandForSpawn(packageManager: ManagedDevServer['packageManager'], script: string): { command: string; args: string[]; display: string } {
  const spec = commandForPackageScript(packageManager, script);
  if (process.platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/c', spec.command, ...spec.args],
      display: spec.display
    };
  }
  return spec;
}

function appendLog(server: ManagedDevServer, chunk: Buffer | string): void {
  const text = redactSensitiveData(String(chunk));
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    server.logs.push(line);
  }
  if (server.logs.length > MAX_LOG_LINES) {
    server.logs.splice(0, server.logs.length - MAX_LOG_LINES);
    server.outputTruncated = true;
  }
}

async function waitForReady(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.status < 500) {
        return true;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}

async function isPortAlreadyServing(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(750) });
    return response.status < 500;
  } catch {
    return false;
  }
}

async function killManagedProcess(server: ManagedDevServer): Promise<void> {
  if (!server.process.pid) {
    return;
  }
  if (process.platform === 'win32') {
    try {
      await execFilePromise('taskkill', ['/PID', String(server.process.pid), '/T', '/F'], { timeout: 10000 });
      return;
    } catch {}
  }
  server.process.kill('SIGTERM');
}

export async function devServerStart(input: {
  workspacePath: string;
  project?: string;
  script?: string;
  port?: number;
  host?: string;
  timeoutMs?: number;
}): Promise<Omit<ManagedDevServer, 'process'>> {
  const projectPath = normalizeProjectPath(input.workspacePath, input.project);
  const scripts = await readPackageScripts(projectPath);
  const script = input.script ?? (scripts.dev ? 'dev' : scripts.start ? 'start' : 'preview');
  const scriptBody = scripts[script];
  if (!scriptBody) {
    throw new Error(`DEV_SERVER_SCRIPT_NOT_FOUND: Script '${script}' was not found in package.json.`);
  }
  assertAllowedDevServerScript(script, scriptBody);

  const packageManager = await detectPackageManager(projectPath);
  const commandSpec = commandForSpawn(packageManager, script);
  const port = Math.min(Math.max(input.port ?? 5173, 1), 65535);
  const host = input.host ?? '127.0.0.1';
  if (!['127.0.0.1', 'localhost'].includes(host)) {
    throw new Error('DEV_SERVER_HOST_NOT_ALLOWED: host must be 127.0.0.1 or localhost.');
  }
  const url = `http://${host}:${port}/`;
  assertLocalBrowserUrl(url);
  if (await isPortAlreadyServing(url)) {
    throw new Error(`DEV_SERVER_PORT_IN_USE: '${url}' is already responding before bridge start.`);
  }

  const child = spawn(commandSpec.command, commandSpec.args, {
    cwd: projectPath,
    shell: false,
    env: {
      PATH: process.env.PATH || '',
      SystemRoot: process.env.SystemRoot || '',
      PORT: String(port),
      HOST: host,
      CI: process.env.CI || '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const server: ManagedDevServer = {
    id: randomUUID(),
    workspacePath: resolveAndValidatePath(input.workspacePath, ALLOWED_WORKSPACE_ROOTS),
    projectPath,
    packageManager,
    script,
    command: commandSpec.display,
    args: commandSpec.args,
    pid: child.pid ?? null,
    url,
    startedAt: new Date().toISOString(),
    status: 'starting',
    exitCode: null,
    logs: [],
    outputTruncated: false,
    process: child
  };
  devServers.set(server.id, server);
  child.stdout.on('data', chunk => appendLog(server, chunk));
  child.stderr.on('data', chunk => appendLog(server, chunk));
  child.on('exit', code => {
    server.exitCode = code;
    if (server.status !== 'stopped') {
      server.status = 'crashed';
    }
  });

  const ready = await waitForReady(url, Math.min(Math.max(input.timeoutMs ?? 30000, 1000), 120000));
  server.status = ready ? 'ready' : (server.exitCode === null ? 'starting' : 'crashed');
  return summarizeServer(server);
}

export function listDevServers(): Array<Omit<ManagedDevServer, 'process'>> {
  return [...devServers.values()].map(summarizeServer);
}

export function devServerLogs(input: { serverId: string; maxLines?: number }): { server: Omit<ManagedDevServer, 'process'>; lines: string[]; truncated: boolean } {
  const server = devServers.get(input.serverId);
  if (!server) {
    throw new Error(`DEV_SERVER_NOT_FOUND: No managed dev server with id '${input.serverId}'.`);
  }
  const maxLines = Math.min(Math.max(input.maxLines ?? 100, 1), MAX_LOG_LINES);
  return {
    server: summarizeServer(server),
    lines: server.logs.slice(-maxLines),
    truncated: server.outputTruncated || server.logs.length > maxLines
  };
}

export async function devServerStop(input: { serverId: string }): Promise<Omit<ManagedDevServer, 'process'>> {
  const server = devServers.get(input.serverId);
  if (!server) {
    throw new Error(`DEV_SERVER_NOT_FOUND: No managed dev server with id '${input.serverId}'.`);
  }
  server.status = 'stopped';
  await killManagedProcess(server);
  devServers.delete(input.serverId);
  return summarizeServer(server);
}

function summarizeServer(server: ManagedDevServer): Omit<ManagedDevServer, 'process'> {
  return {
    id: server.id,
    workspacePath: server.workspacePath,
    projectPath: server.projectPath,
    packageManager: server.packageManager,
    script: server.script,
    command: server.command,
    args: server.args,
    pid: server.pid,
    url: server.url,
    startedAt: server.startedAt,
    status: server.status,
    exitCode: server.exitCode,
    logs: server.logs.slice(-20),
    outputTruncated: server.outputTruncated
  };
}

function jsonContent(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function jsonError(error: any) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: redactSensitiveData(error.message || 'Dev server tool failed.') }, null, 2) }]
  };
}

export function registerDevServerTools(server: McpServer): void {
  server.registerTool(
    "dev_server_start",
    {
      description: "Start a managed local package-script dev server and wait for local URL readiness",
      inputSchema: z.object({
        workspacePath: z.string(),
        project: z.string().optional(),
        script: z.enum(['dev', 'start', 'preview', 'desktop:dev']).optional(),
        port: z.number().min(1).max(65535).optional().default(5173),
        host: z.enum(['127.0.0.1', 'localhost']).optional().default('127.0.0.1'),
        timeoutMs: z.number().min(1000).max(120000).optional().default(30000)
      }),
    },
    async (args) => {
      try {
        return jsonContent({ success: true, server: await devServerStart(args) });
      } catch (error: any) {
        return jsonError(error);
      }
    }
  );

  server.registerTool(
    "dev_server_logs",
    {
      description: "Read bounded redacted logs for a bridge-managed dev server",
      inputSchema: z.object({
        serverId: z.string(),
        maxLines: z.number().min(1).max(MAX_LOG_LINES).optional().default(100)
      }),
    },
    async (args) => {
      try {
        return jsonContent({ success: true, ...devServerLogs(args) });
      } catch (error: any) {
        return jsonError(error);
      }
    }
  );

  server.registerTool(
    "dev_server_stop",
    {
      description: "Stop only a dev server process that was started and tracked by this bridge",
      inputSchema: z.object({
        serverId: z.string()
      }),
    },
    async (args) => {
      try {
        return jsonContent({ success: true, server: await devServerStop(args) });
      } catch (error: any) {
        return jsonError(error);
      }
    }
  );

  server.registerTool(
    "list_dev_servers",
    {
      description: "List bridge-managed dev servers and their current status",
      inputSchema: z.object({}).optional(),
    },
    async () => jsonContent({ success: true, servers: listDevServers() })
  );
}
