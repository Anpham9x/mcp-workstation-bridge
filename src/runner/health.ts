import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ALLOWED_WORKSPACE_ROOTS } from '../security/index.js';

const execFileAsync = promisify(execFile);

export interface ToolStatus {
  available: boolean;
  path?: string;
  version?: string;
}

export interface EnvironmentHealth {
  agy: ToolStatus;
  git: ToolStatus;
  node: ToolStatus;
  npm: ToolStatus;
  workspaceRoots: string[];
}

/**
 * Resolves the absolute path of an executable in the system PATH on Windows.
 * Uses C:\Windows\System32\where.exe safely without a shell.
 */
async function resolvePath(name: string): Promise<string | null> {
  try {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const wherePath = path.join(systemRoot, 'System32', 'where.exe');
    
    const { stdout } = await execFileAsync(wherePath, [name], { timeout: 1000 });
    const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length > 0) {
      return lines[0];
    }
  } catch {
    // Command fails (exit code 1) if the executable is not found in PATH
  }
  return null;
}

/**
 * Executes the tool with the specified version argument and retrieves its version string.
 * On Windows, .cmd or .bat files are executed via cmd.exe safely without using a shell environment.
 */
async function getToolVersion(executablePath: string, versionArgs: string[] = ['--version']): Promise<string | null> {
  try {
    const isWin = process.platform === 'win32';
    const isCmdOrBat = executablePath.toLowerCase().endsWith('.cmd') || executablePath.toLowerCase().endsWith('.bat');

    if (isWin && isCmdOrBat) {
      const systemRoot = process.env.SystemRoot || 'C:\\Windows';
      const cmdPath = path.join(systemRoot, 'System32', 'cmd.exe');
      const { stdout } = await execFileAsync(cmdPath, ['/c', executablePath, ...versionArgs], { timeout: 1500 });
      return stdout.trim();
    } else {
      const { stdout } = await execFileAsync(executablePath, versionArgs, { timeout: 1500 });
      return stdout.trim();
    }
  } catch {
    return null;
  }
}

/**
 * Bounded discovery helper for a single command/tool.
 */
export async function discoverTool(
  name: string,
  fallbackPath?: string,
  versionArgs: string[] = ['--version']
): Promise<ToolStatus> {
  let resolvedPath = await resolvePath(name);

  if (!resolvedPath && fallbackPath) {
    try {
      const stats = await fs.stat(fallbackPath);
      if (stats.isFile()) {
        resolvedPath = fallbackPath;
      }
    } catch {
      // Fallback path does not exist
    }
  }

  if (!resolvedPath) {
    return { available: false };
  }

  const version = await getToolVersion(resolvedPath, versionArgs);
  return {
    available: !!version,
    path: resolvedPath,
    version: version || undefined,
  };
}

/**
 * Discovers the versions and paths of agy, git, node, and npm.
 */
export async function discoverEnvironmentHealth(): Promise<EnvironmentHealth> {
  const agyFallback = path.join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe');

  // Discover all tools in parallel with bounds
  const [agyStatus, gitStatus, nodeStatus, npmStatus] = await Promise.all([
    discoverTool('agy', agyFallback, ['--version']),
    discoverTool('git', undefined, ['--version']),
    discoverTool('node', undefined, ['--version']),
    // On Windows, npm must be run using npm.cmd for execFile to work without a shell
    discoverTool('npm.cmd', undefined, ['--version']).then(async (status) => {
      if (status.available) return status;
      return discoverTool('npm', undefined, ['--version']);
    }),
  ]);

  return {
    agy: agyStatus,
    git: gitStatus,
    node: nodeStatus,
    npm: npmStatus,
    workspaceRoots: [...ALLOWED_WORKSPACE_ROOTS],
  };
}
