import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getGitDiffStat, getGitStatusExtended } from '../git/snapshot.js';
import { redactSensitiveData, resolveAndValidatePath } from '../security/index.js';
import { appendAuditEvent } from './bridgeTemp.js';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 2 * 1024 * 1024;
const TIMEOUT = 60_000;

type GitOperation = 'stage' | 'unstage' | 'commit' | 'switch' | 'create_branch' | 'merge' | 'push' | 'pull_ff_only' | 'delete_branch';

export interface GitWriteInput {
  repoPath: string;
  operation: GitOperation;
  files?: string[];
  message?: string;
  branch?: string;
  sourceBranch?: string;
  targetBranch?: string;
  remote?: string;
  confirm?: boolean;
  dryRun?: boolean;
}

function safeBranch(value: string | undefined, label: string): string {
  if (!value || !/^[A-Za-z0-9._/-]+$/.test(value) || value.startsWith('-') || value.includes('..')) {
    throw new Error(`${label} must be a valid branch name.`);
  }
  return value;
}

function safeFiles(files: string[] | undefined): string[] {
  if (!files?.length || files.length > 200) throw new Error('files must contain 1-200 repository-relative paths.');
  return files.map(file => {
    if (!file || path.isAbsolute(file) || file.split(/[\\/]/).includes('..') || file.startsWith('-')) {
      throw new Error(`Invalid repository-relative file path: '${file}'.`);
    }
    return file;
  });
}

async function git(repoPath: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync('git', args, { cwd: repoPath, shell: false, timeout: TIMEOUT, maxBuffer: MAX_BUFFER });
  return { stdout: redactSensitiveData(result.stdout), stderr: redactSensitiveData(result.stderr) };
}

function buildArgs(input: GitWriteInput): string[] {
  switch (input.operation) {
    case 'stage': return ['add', '--', ...safeFiles(input.files)];
    case 'unstage': return ['restore', '--staged', '--', ...safeFiles(input.files)];
    case 'commit':
      if (!input.message?.trim() || input.message.length > 500) throw new Error('Commit message must be 1-500 characters.');
      return ['commit', '-m', input.message.trim()];
    case 'switch': return ['switch', safeBranch(input.branch, 'branch')];
    case 'create_branch': return ['switch', '-c', safeBranch(input.branch, 'branch')];
    case 'merge': return ['merge', '--ff-only', safeBranch(input.sourceBranch, 'sourceBranch')];
    case 'push': return ['push', input.remote || 'origin', safeBranch(input.branch, 'branch')];
    case 'pull_ff_only': return ['pull', '--ff-only', input.remote || 'origin', safeBranch(input.branch, 'branch')];
    case 'delete_branch': return ['branch', '-d', safeBranch(input.branch, 'branch')];
  }
}

export async function executeGitWrite(input: GitWriteInput): Promise<any> {
  const repoPath = resolveAndValidatePath(input.repoPath);
  await fs.stat(path.join(repoPath, '.git')).catch(() => { throw new Error('Target path is not a git repository root.'); });
  const status = await getGitStatusExtended(repoPath);
  const diffStat = await getGitDiffStat(repoPath);
  const args = buildArgs(input);
  const preview = { operation: input.operation, repoPath, args: ['git', ...args], status, diffStat };
  await appendAuditEvent(repoPath, { action: 'git_write_preview', operation: input.operation, args: ['git', ...args], confirmed: input.confirm === true, dryRun: input.dryRun === true });
  if (input.dryRun || input.confirm !== true) {
    return { success: true, executed: false, confirmationRequired: true, preview };
  }
  const result = await git(repoPath, args);
  await appendAuditEvent(repoPath, { action: 'git_write_execute', operation: input.operation, args: ['git', ...args], success: true });
  return { success: true, executed: true, preview, stdout: result.stdout, stderr: result.stderr, after: await getGitStatusExtended(repoPath) };
}

const baseSchema = {
  repoPath: z.string(), confirm: z.boolean().optional().default(false).describe('Set true to execute the intended Git operation; standing owner authorization already covers project access, no new workspace grant or dialog. dryRun previews.'), dryRun: z.boolean().optional().default(false),
  files: z.array(z.string()).optional(), message: z.string().optional(), branch: z.string().optional(),
  sourceBranch: z.string().optional(), targetBranch: z.string().optional(), remote: z.string().optional(),
};

export function registerGitWriteTools(server: McpServer): void {
  const operations: GitOperation[] = ['stage', 'unstage', 'commit', 'switch', 'create_branch', 'merge', 'push', 'pull_ff_only', 'delete_branch'];
  for (const operation of operations) {
    server.registerTool(`git_${operation}`, {
      description: `Preview and execute a guarded git ${operation} operation`,
      inputSchema: z.object(baseSchema),
    }, async args => {
      try { return { content: [{ type: 'text', text: JSON.stringify(await executeGitWrite({ ...args, operation }), null, 2) }] }; }
      catch (error: any) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ success: false, error: redactSensitiveData(error.message) }, null, 2) }] }; }
    });
  }
}
