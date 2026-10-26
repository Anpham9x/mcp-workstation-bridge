import { getToolContext, validateScopedGate } from '../reliability/policy.js';
import { hasOwnerAccess } from '../security/ownerAccess.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  assertSafePackageSpec,
  evaluateWorkspacePolicy,
  ProjectBridgeConfig,
  redactSensitiveData,
  resolveAndValidatePath,
  validatePathForTextWrite,
  validateProjectBridgeConfig
} from "../security/index.js";
import { getChangedFiles, getGitDiffStat, getGitReviewSnapshot } from "../git/snapshot.js";

const execFilePromise = promisify(execFile);
const PROJECT_CONFIG_RELATIVE_PATH = path.join('.ai', 'mcp-bridge.project.json');
const REPORTS_RELATIVE_DIR = path.join('.ai', 'reports');
const INSTALL_TIMEOUT_MS = 120000;
const INSTALL_MAX_BUFFER = 10 * 1024 * 1024;

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findPackageProject(workspacePath: string, project?: string): Promise<string> {
  const workspace = resolveAndValidatePath(workspacePath);
  const candidate = project ? (path.isAbsolute(project) ? project : path.join(workspace, project)) : workspace;
  const projectPath = resolveAndValidatePath(candidate);
  const relative = path.relative(workspace, projectPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path validation failed: project '${projectPath}' is outside workspace '${workspace}'.`);
  }
  if (!(await pathExists(path.join(projectPath, 'package.json')))) {
    throw new Error(`Project validation failed: package.json was not found in '${projectPath}'.`);
  }
  return projectPath;
}

async function readProjectConfig(projectPath: string): Promise<{ configPath: string; exists: boolean; config: ProjectBridgeConfig }> {
  const configPath = path.join(projectPath, PROJECT_CONFIG_RELATIVE_PATH);
  if (!(await pathExists(configPath))) {
    return {
      configPath,
      exists: false,
      config: {
        writeScope: [],
        protectedFiles: [],
        allowedPackageScripts: [],
        install: {
          requireConfirmation: true,
          defaultDryRun: true,
          allowVersionSpecs: true
        }
      }
    };
  }

  const raw = await fs.readFile(validatePathForTextWrite(configPath), 'utf8');
  const parsed = JSON.parse(raw) as ProjectBridgeConfig;
  validateProjectBridgeConfig(parsed);
  return { configPath, exists: true, config: parsed };
}

function detectPackageManager(projectPath: string): Promise<'npm' | 'pnpm' | 'yarn' | 'bun'> {
  return Promise.all([
    pathExists(path.join(projectPath, 'pnpm-lock.yaml')),
    pathExists(path.join(projectPath, 'yarn.lock')),
    pathExists(path.join(projectPath, 'bun.lockb')),
    pathExists(path.join(projectPath, 'bun.lock')),
  ]).then(([pnpm, yarn, bunLockb, bunLock]) => {
    if (pnpm) return 'pnpm';
    if (yarn) return 'yarn';
    if (bunLockb || bunLock) return 'bun';
    return 'npm';
  });
}

function commandForInstall(packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun', packageSpec: string, dryRun: boolean): {
  command: string;
  args: string[];
  display: string;
} {
  if (packageManager === 'pnpm') {
    const args = ['add', packageSpec];
    if (dryRun) args.push('--dry-run');
    return { command: 'pnpm', args, display: `pnpm ${args.join(' ')}` };
  }
  if (packageManager === 'yarn') {
    const args = ['add', packageSpec];
    if (dryRun) args.push('--dry-run');
    return { command: 'yarn', args, display: `yarn ${args.join(' ')}` };
  }
  if (packageManager === 'bun') {
    const args = ['add', packageSpec];
    if (dryRun) args.push('--dry-run');
    return { command: 'bun', args, display: `bun ${args.join(' ')}` };
  }
  const args = ['install', packageSpec];
  if (dryRun) args.push('--dry-run');
  return { command: 'npm', args, display: `npm ${args.join(' ')}` };
}

function toWindowsCommand(spec: { command: string; args: string[] }): { command: string; args: string[] } {
  if (process.platform === 'win32' && ['npm', 'pnpm', 'yarn', 'bun'].includes(spec.command)) {
    return { command: 'cmd.exe', args: ['/c', spec.command, ...spec.args] };
  }
  return spec;
}

function sanitizeReportName(reportName: string): string {
  const trimmed = reportName.trim();
  if (!trimmed || trimmed.length > 120) {
    throw new Error('Report validation failed: reportName must be 1-120 characters.');
  }
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!safe || safe.includes('..')) {
    throw new Error('Report validation failed: reportName contains no safe filename characters.');
  }
  return safe.toLowerCase().endsWith('.md') ? safe : `${safe}.md`;
}

function classifyRisk(changedFiles: string[]): { riskLevel: 'none' | 'low' | 'medium' | 'high'; riskFlags: string[] } {
  const riskFlags: string[] = [];
  for (const file of changedFiles) {
    const normalized = file.replace(/\\/g, '/').toLowerCase();
    if (normalized.includes('/security/') || normalized.startsWith('src/security/')) {
      riskFlags.push(`security policy changed: ${file}`);
    }
    if (['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'].some(name => normalized.endsWith(name))) {
      riskFlags.push(`dependency/config changed: ${file}`);
    }
    if (normalized.endsWith('tsconfig.json') || normalized.endsWith('.gitignore')) {
      riskFlags.push(`project config changed: ${file}`);
    }
  }
  const riskLevel = riskFlags.some(flag => flag.includes('security policy')) ? 'high'
    : riskFlags.length > 0 ? 'medium'
    : changedFiles.length > 0 ? 'low'
    : 'none';
  return { riskLevel, riskFlags };
}

export async function installPackageSafe(input: {
  workspacePath: string;
  project?: string;
  packageSpec: string;
  dryRun?: boolean;
  confirmInstall?: boolean;
}): Promise<any> {
  const projectPath = await findPackageProject(input.workspacePath, input.project);
  const { config } = await readProjectConfig(projectPath);
  const allowVersionSpecs = config.install?.allowVersionSpecs ?? true;
  assertSafePackageSpec(input.packageSpec, allowVersionSpecs);

  const bareName = input.packageSpec.startsWith('@')
    ? input.packageSpec.split('@').slice(0, 2).join('@')
    : input.packageSpec.split('@')[0];
  if (!hasOwnerAccess() && (config.install?.blockPackages?.includes(bareName) || config.install?.blockPackages?.includes(input.packageSpec))) {
    throw new Error(`Package install blocked by project config: '${input.packageSpec}'.`);
  }
  if (!hasOwnerAccess() && config.install?.allowPackages?.length && !config.install.allowPackages.includes(bareName) && !config.install.allowPackages.includes(input.packageSpec)) {
    throw new Error(`Package install blocked: '${input.packageSpec}' is not in install.allowPackages.`);
  }

  const dryRun = input.dryRun ?? config.install?.defaultDryRun ?? true;
  const requireConfirmation = config.install?.requireConfirmation ?? true;
  if (!dryRun && requireConfirmation && input.confirmInstall !== true) {
    throw new Error('INSTALL_CONFIRMATION_REQUIRED: set dryRun=true or pass confirmInstall=true after explicit user approval.');
  }

  const packageManager = await detectPackageManager(projectPath);
  const installSpec = commandForInstall(packageManager, input.packageSpec, dryRun);
  const execSpec = toWindowsCommand(installSpec);
  const changedBefore: string[] = await getChangedFiles(projectPath).catch(() => []);
  const startedAt = new Date().toISOString();
  try {
    const { stdout, stderr } = await execFilePromise(execSpec.command, execSpec.args, {
      cwd: projectPath,
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: INSTALL_MAX_BUFFER,
      shell: false,
      env: dryRun
        ? { PATH: process.env.PATH || '', SystemRoot: process.env.SystemRoot || '', CI: '1', PAGER: 'cat' }
        : { ...process.env, CI: '1', PAGER: 'cat' }
    });
    const changedAfter: string[] = await getChangedFiles(projectPath).catch(() => []);
    return {
      success: true,
      dryRun,
      command: installSpec.display,
      cwd: projectPath,
      packageManager,
      changedFilesBefore: changedBefore,
      changedFilesAfter: changedAfter,
      changedFileSummary: changedAfter.filter(file => !changedBefore.includes(file)),
      stdout: redactSensitiveData(stdout),
      stderr: redactSensitiveData(stderr),
      startedAt,
      finishedAt: new Date().toISOString()
    };
  } catch (error: any) {
    return {
      success: false,
      dryRun,
      command: installSpec.display,
      cwd: projectPath,
      packageManager,
      changedFilesBefore: changedBefore,
      changedFilesAfter: await getChangedFiles(projectPath).catch((): string[] => []),
      stdout: redactSensitiveData(error.stdout || ''),
      stderr: redactSensitiveData(error.stderr || error.message || ''),
      error: redactSensitiveData(error.message || 'Package install failed.'),
      startedAt,
      finishedAt: new Date().toISOString()
    };
  }
}

export async function createProjectTaskReport(input: {
  workspacePath: string;
  reportName: string;
  title: string;
  content: string;
  overwrite?: boolean;
}): Promise<any> {
  const workspace = resolveAndValidatePath(input.workspacePath);
  const reportsDir = path.join(workspace, REPORTS_RELATIVE_DIR);
  const reportPath = path.join(reportsDir, sanitizeReportName(input.reportName));
  const validatedReportPath = validatePathForTextWrite(reportPath);
  const relative = path.relative(workspace, validatedReportPath);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !relative.replace(/\\/g, '/').startsWith('.ai/reports/')) {
    throw new Error('Report validation failed: report must be written under .ai/reports/.');
  }
  if ((await pathExists(validatedReportPath)) && input.overwrite !== true) {
    throw new Error('REPORT_EXISTS: pass overwrite=true only after explicit approval.');
  }
  await fs.mkdir(path.dirname(validatedReportPath), { recursive: true });
  const now = new Date().toISOString();
  const body = [
    `# ${input.title.trim() || path.basename(validatedReportPath, '.md')}`,
    '',
    `- Created: ${now}`,
    `- Workspace: ${workspace}`,
    '',
    input.content.trim(),
    ''
  ].join('\n');
  await fs.writeFile(validatedReportPath, body, 'utf8');
  return {
    success: true,
    reportPath: validatedReportPath,
    relativePath: relative.replace(/\\/g, '/'),
    bytesWritten: Buffer.byteLength(body, 'utf8')
  };
}

export async function gitSafeCommitSummary(input: {
  repoPath: string;
  riskNotes?: string;
  requireRiskNotes?: boolean;
  maxFiles?: number;
}): Promise<any> {
  const repoPath = resolveAndValidatePath(input.repoPath);
  const snapshot = await getGitReviewSnapshot(repoPath);
  const changedFiles = snapshot.changedFiles.slice(0, Math.min(Math.max(input.maxFiles ?? 50, 1), 200));
  const { riskLevel, riskFlags } = classifyRisk(snapshot.changedFiles);
  const requireRiskNotes = input.requireRiskNotes ?? true;
  if (requireRiskNotes && riskFlags.length > 0 && !input.riskNotes?.trim()) {
    throw new Error('RISK_NOTES_REQUIRED: dependency, config, or security-sensitive changes need a reviewer risk note before commit summary approval.');
  }
  const title = snapshot.changedFiles.length === 0
    ? 'chore: no local changes'
    : `chore: update ${changedFiles[0].replace(/\\/g, '/')}${snapshot.changedFiles.length > 1 ? ` and ${snapshot.changedFiles.length - 1} more` : ''}`;
  return {
    success: true,
    clean: snapshot.changedFiles.length === 0,
    changedFiles,
    totalChangedFiles: snapshot.changedFiles.length,
    diffStat: await getGitDiffStat(repoPath),
    suggestedCommit: {
      title,
      body: [
        'Summary:',
        ...changedFiles.slice(0, 10).map(file => `- ${file.replace(/\\/g, '/')}`),
        '',
        `Risk: ${riskLevel}`,
        ...(input.riskNotes?.trim() ? [`Risk notes: ${input.riskNotes.trim()}`] : [])
      ].join('\n')
    },
    riskLevel,
    riskFlags,
    commitsCreated: 0
  };
}

export function registerProjectSafetyTools(server: McpServer): void {
  server.registerTool(
    "validate_workspace_policy",
    {
      description: "Validate whether a workspace action is allowed and explain the matched policy rule",
      inputSchema: z.object({
        workspacePath: z.string(),
        action: z.enum(['read', 'write', 'execute', 'install', 'browser', 'search']),
        targetPath: z.string().optional(),
        command: z.string().optional(), authorizationId: z.string().optional()
      }),
    },
    async (args) => {
      try {
        const workspacePath = resolveAndValidatePath(args.workspacePath);
        const projectConfig = await readProjectConfig(workspacePath).catch(error => ({
          configPath: path.join(workspacePath, PROJECT_CONFIG_RELATIVE_PATH),
          exists: false,
          config: null,
          error: redactSensitiveData(error.message || 'Failed to read project config.')
        }));
        let decision;
        if (!hasOwnerAccess() && args.action === 'execute' && args.command === 'repository_preflight') {
          const context = getToolContext(server);
          if (!context) throw new Error('MANAGED_CONTEXT_REQUIRED');
          const grant = await validateScopedGate(context,args.authorizationId,workspacePath);
          decision = { allowed: true, reason: 'Trusted scoped gate contract verified; execution and fresh attestation still required.', authorizationId: grant.id };
        } else {
          decision = evaluateWorkspacePolicy(args);
        }
        return { content: [{ type: "text", text: JSON.stringify({ success: true, workspacePath, decision, projectConfig }, null, 2) }] };
      } catch (error: any) {
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ success: false, error: redactSensitiveData(error.message) }, null, 2) }] };
      }
    }
  );

  server.registerTool(
    "install_package_safe",
    {
      description: "Safely install or dry-run a registry package with package-name validation and explicit confirmation",
      inputSchema: z.object({
        workspacePath: z.string(),
        project: z.string().optional(),
        packageSpec: z.string(),
        dryRun: z.boolean().optional().default(true),
        confirmInstall: z.boolean().optional().default(false)
      }),
    },
    async (args) => {
      const result = await installPackageSafe(args);
      return { isError: result.success ? undefined : true, content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "create_project_task_report",
    {
      description: "Create a Markdown task report under .ai/reports without overwriting by default",
      inputSchema: z.object({
        workspacePath: z.string(),
        reportName: z.string(),
        title: z.string(),
        content: z.string(),
        overwrite: z.boolean().optional().default(false)
      }),
    },
    async (args) => {
      try {
        const result = await createProjectTaskReport(args);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error: any) {
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ success: false, error: redactSensitiveData(error.message) }, null, 2) }] };
      }
    }
  );

  server.registerTool(
    "git_safe_commit_summary",
    {
      description: "Summarize current git changes, propose a commit message, and require risk notes for config/dependency/security changes without committing",
      inputSchema: z.object({
        repoPath: z.string(),
        riskNotes: z.string().optional(),
        requireRiskNotes: z.boolean().optional().default(true),
        maxFiles: z.number().min(1).max(200).optional().default(50)
      }),
    },
    async (args) => {
      try {
        const result = await gitSafeCommitSummary(args);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error: any) {
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ success: false, error: redactSensitiveData(error.message) }, null, 2) }] };
      }
    }
  );
}
