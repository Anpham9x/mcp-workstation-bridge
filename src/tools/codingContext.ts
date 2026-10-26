import { randomUUID } from 'node:crypto';
import { hasOwnerAccess } from '../security/ownerAccess.js';
import { TextDecoder } from 'node:util';
import { boundedRange, type FileRange } from '../reliability/ranges.js';
import { assertNoLinks, readOptional, sha256 } from './atomicFile.js';
import { operationStatus } from '../reliability/mutations.js';
import { contextFields, authorizeFile, authorizationStatus, getToolContext, workspaceIdentity } from '../reliability/policy.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ALLOWED_WORKSPACE_ROOTS,
  checkForbiddenFile,
  evaluateWorkspacePolicy,
  isBinaryBuffer,
  isBinaryExtension,
  isIgnoredPath,
  MAX_READ_FILE_SIZE,
  redactSensitiveData,
  resolveAndValidatePath,
  validatePathForRead
} from "../security/index.js";

const execFilePromise = promisify(execFile);
const SEARCH_TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.astro', '.css', '.scss',
  '.md', '.mdx', '.json', '.html', '.txt', '.yaml', '.yml'
]);
const FRAMEWORK_DEPS = [
  'astro', 'next', 'react', 'vue', 'svelte', 'vite', 'tailwindcss',
  'express', 'fastify', '@nestjs/core', 'hono'
];
const DEFAULT_ALLOWED_PACKAGE_SCRIPTS = new Set([
  'build', 'lint', 'test', 'typecheck', 'check', 'format:check', 'preview', 'desktop:dev'
]);
const DANGEROUS_SCRIPT_PATTERNS = [
  /rm\s+-rf/i,
  /\bdel\s+\/s\b/i,
  /\brmdir\s+\/s\b/i,
  /\bformat\b/i,
  /\bshutdown\b/i,
  /curl\b[\s\S]*\|\s*sh\b/i,
  /invoke-webrequest\b[\s\S]*\|\s*iex\b/i,
  /\b(token|secret|password|api[_-]?key)=["']?[^"'\s]+/i
];

export interface SearchCodeResult {
  query: string;
  totalMatches: number;
  truncated: boolean;
  engine: 'ripgrep' | 'node';
  results: Array<{
    filePath: string;
    relativePath: string;
    lineNumber: number;
    lineText: string;
    before?: string[];
    after?: string[];
  }>;
}

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

async function listDirectoryNames(projectPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(projectPath, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
      .map(entry => entry.name);
  } catch {
    return [];
  }
}

async function listFileNames(projectPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(projectPath, { withFileTypes: true });
    return entries
      .filter(entry => entry.isFile() && !entry.isSymbolicLink())
      .map(entry => entry.name);
  } catch {
    return [];
  }
}

function isSearchableTextPath(filePath: string): boolean {
  return SEARCH_TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function simpleGlobMatches(relativePath: string, fileGlob?: string): boolean {
  if (!fileGlob) {
    return true;
  }
  const normalized = relativePath.replace(/\\/g, '/');
  const escaped = fileGlob
    .replace(/\\/g, '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLE_STAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLE_STAR::/g, '.*');
  return new RegExp(`^${escaped}$`).test(normalized);
}

async function assertSafeRegularTextFile(filePath: string, maxBytesPerFile: number): Promise<{ size: number }> {
  const validated = validatePathForRead(filePath, ALLOWED_WORKSPACE_ROOTS);
  const stat = await fs.lstat(validated);
  if (stat.isSymbolicLink()) {
    throw new Error(`Security violation: File '${path.basename(validated)}' is a symbolic link.`);
  }
  if (!stat.isFile()) {
    throw new Error(`Path validation failed: '${validated}' is not a regular file.`);
  }
  if (stat.size > Math.min(maxBytesPerFile, MAX_READ_FILE_SIZE)) {
    throw new Error(`Security violation: File size ${stat.size} exceeds the maximum allowed limit.`);
  }
  return { size: stat.size };
}

async function readSafeTextFile(filePath: string, maxBytesPerFile: number): Promise<string> {
  await assertSafeRegularTextFile(filePath, maxBytesPerFile);
  const buffer = await fs.readFile(filePath);
  if (isBinaryBuffer(buffer)) {
    throw new Error(`Security violation: Binary content detected in file '${path.basename(filePath)}'.`);
  }
  return buffer.toString('utf8');
}

async function addLineContext(
  filePath: string,
  lineNumber: number,
  includeLineContext: number,
  maxBytesPerFile: number
): Promise<{ before?: string[]; after?: string[] }> {
  if (includeLineContext <= 0) {
    return {};
  }
  const content = await readSafeTextFile(filePath, maxBytesPerFile);
  const lines = content.split(/\r?\n/);
  const index = lineNumber - 1;
  return {
    before: lines.slice(Math.max(0, index - includeLineContext), index),
    after: lines.slice(index + 1, index + 1 + includeLineContext)
  };
}

async function hasRipgrep(): Promise<boolean> {
  try {
    await execFilePromise('rg', ['--version'], { timeout: 3000, maxBuffer: 64 * 1024 });
    return true;
  } catch {
    return false;
  }
}

async function searchWithRipgrep(options: {
  workspacePath: string;
  query: string;
  fileGlob?: string;
  caseSensitive: boolean;
  regex: boolean;
  maxResults: number;
  maxBytesPerFile: number;
  includeLineContext: number;
}): Promise<SearchCodeResult> {
  const args = [
    '--json',
    '--line-number',
    '--hidden',
    '--glob', '!node_modules/**',
    '--glob', '!.git/**',
    '--glob', '!dist/**',
    '--glob', '!build/**',
    '--glob', '!.next/**',
    '--glob', '!.astro/**',
    '--glob', '!coverage/**',
    '--max-filesize', `${Math.min(options.maxBytesPerFile, MAX_READ_FILE_SIZE)}`,
  ];

  if (!options.caseSensitive) {
    args.push('--ignore-case');
  }
  if (!options.regex) {
    args.push('--fixed-strings');
  }
  if (options.fileGlob) {
    args.push('--glob', options.fileGlob);
    if (options.fileGlob.replace(/\\/g, '/').endsWith('/**')) {
      args.push('--glob', `${options.fileGlob.replace(/\\/g, '/').slice(0, -3)}/*`);
    }
  }
  args.push(options.query, '.');

  let stdout = '';
  try {
    const result = await execFilePromise('rg', args, {
      cwd: options.workspacePath,
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
      shell: false
    });
    stdout = result.stdout;
  } catch (error: any) {
    if (error.code === 1) {
      stdout = error.stdout || '';
    } else {
      throw error;
    }
  }

  const results: SearchCodeResult['results'] = [];
  let totalMatches = 0;
  let truncated = false;
  for (const rawLine of stdout.split(/\r?\n/)) {
    if (!rawLine.trim()) {
      continue;
    }
    const event = JSON.parse(rawLine);
    if (event.type !== 'match') {
      continue;
    }
    const filePath = path.resolve(options.workspacePath, event.data.path.text);
    if (!isSearchableTextPath(filePath) || isIgnoredPath(filePath) || checkForbiddenFile(filePath) || isBinaryExtension(filePath)) {
      continue;
    }
    try {
      await assertSafeRegularTextFile(filePath, options.maxBytesPerFile);
    } catch {
      continue;
    }
    totalMatches++;
    if (results.length >= options.maxResults) {
      truncated = true;
      continue;
    }
    const context = await addLineContext(filePath, event.data.line_number, options.includeLineContext, options.maxBytesPerFile);
    results.push({
      filePath,
      relativePath: path.relative(options.workspacePath, filePath).replace(/\\/g, '/'),
      lineNumber: event.data.line_number,
      lineText: String(event.data.lines.text || '').replace(/\r?\n$/, ''),
      ...context
    });
  }

  return {
    query: options.query,
    totalMatches,
    truncated,
    engine: 'ripgrep',
    results
  };
}

async function collectTextFiles(rootPath: string, maxBytesPerFile: number, fileGlob?: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(currentDir: string): Promise<void> {
    let entries: Array<import('node:fs').Dirent>;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isSymbolicLink() || isIgnoredPath(fullPath) || checkForbiddenFile(fullPath)) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !isSearchableTextPath(fullPath) || isBinaryExtension(fullPath)) {
        continue;
      }
      const relativePath = path.relative(rootPath, fullPath).replace(/\\/g, '/');
      if (!simpleGlobMatches(relativePath, fileGlob)) {
        continue;
      }
      try {
        await assertSafeRegularTextFile(fullPath, maxBytesPerFile);
        files.push(fullPath);
      } catch {
        continue;
      }
    }
  }
  await walk(rootPath);
  return files;
}

function lineMatches(line: string, query: string, caseSensitive: boolean, regex: boolean): boolean {
  if (regex) {
    const flags = caseSensitive ? '' : 'i';
    return new RegExp(query, flags).test(line);
  }
  const haystack = caseSensitive ? line : line.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  return haystack.includes(needle);
}

async function searchWithNode(options: {
  workspacePath: string;
  query: string;
  fileGlob?: string;
  caseSensitive: boolean;
  regex: boolean;
  maxResults: number;
  maxBytesPerFile: number;
  includeLineContext: number;
}): Promise<SearchCodeResult> {
  const results: SearchCodeResult['results'] = [];
  let totalMatches = 0;
  let truncated = false;
  const files = await collectTextFiles(options.workspacePath, options.maxBytesPerFile, options.fileGlob);
  for (const filePath of files) {
    const content = await readSafeTextFile(filePath, options.maxBytesPerFile);
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!lineMatches(lines[i], options.query, options.caseSensitive, options.regex)) {
        continue;
      }
      totalMatches++;
      if (results.length >= options.maxResults) {
        truncated = true;
        continue;
      }
      const lineNumber = i + 1;
      results.push({
        filePath,
        relativePath: path.relative(options.workspacePath, filePath).replace(/\\/g, '/'),
        lineNumber,
        lineText: lines[i],
        before: options.includeLineContext > 0 ? lines.slice(Math.max(0, i - options.includeLineContext), i) : undefined,
        after: options.includeLineContext > 0 ? lines.slice(i + 1, i + 1 + options.includeLineContext) : undefined
      });
    }
  }
  return {
    query: options.query,
    totalMatches,
    truncated,
    engine: 'node',
    results
  };
}

export async function searchCode(input: {
  workspacePath: string;
  query: string;
  fileGlob?: string;
  caseSensitive?: boolean;
  regex?: boolean;
  maxResults?: number;
  maxBytesPerFile?: number;
  includeLineContext?: number;
}): Promise<SearchCodeResult> {
  const workspacePath = resolveAndValidatePath(input.workspacePath, ALLOWED_WORKSPACE_ROOTS);
  if (isIgnoredPath(workspacePath) || checkForbiddenFile(workspacePath)) {
    throw new Error('Workspace path is forbidden or ignored.');
  }
  const query = input.query;
  if (!query || query.length > 1000) {
    throw new Error('Search query must be non-empty and at most 1000 characters.');
  }
  if (input.regex) {
    new RegExp(query);
  }
  const options = {
    workspacePath,
    query,
    fileGlob: input.fileGlob,
    caseSensitive: input.caseSensitive ?? false,
    regex: input.regex ?? false,
    maxResults: Math.min(Math.max(input.maxResults ?? 100, 1), 500),
    maxBytesPerFile: Math.min(Math.max(input.maxBytesPerFile ?? 1024 * 1024, 1), MAX_READ_FILE_SIZE),
    includeLineContext: Math.min(Math.max(input.includeLineContext ?? 2, 0), 10)
  };
  if ((await hasRipgrep())) {
    return searchWithRipgrep(options);
  }
  return searchWithNode(options);
}

export interface PackageScriptsResult {
  packageJsonPath: string;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'unknown';
  scripts: Record<string, string>;
  dependenciesSummary: {
    dependenciesCount: number;
    devDependenciesCount: number;
    mainFrameworks: string[];
  };
}

async function detectPackageManager(projectPath: string): Promise<PackageScriptsResult['packageManager']> {
  if (await pathExists(path.join(projectPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await pathExists(path.join(projectPath, 'yarn.lock'))) return 'yarn';
  if (await pathExists(path.join(projectPath, 'bun.lockb')) || await pathExists(path.join(projectPath, 'bun.lock'))) return 'bun';
  if (await pathExists(path.join(projectPath, 'package-lock.json'))) return 'npm';
  return 'unknown';
}

function commandForPackageScript(packageManager: PackageScriptsResult['packageManager'], script: string): { command: string; args: string[]; display: string } {
  const manager = packageManager === 'unknown' ? 'npm' : packageManager;
  const args = ['run', script];
  return {
    command: manager,
    args,
    display: `${manager} run ${script}`
  };
}

function assertAllowedPackageScript(script: string, scriptBody: string): void {
  if(hasOwnerAccess()){if(!/^[A-Za-z0-9:_-]{1,100}$/.test(script))throw new Error('INVALID_SCRIPT_NAME');return;}
  if (!DEFAULT_ALLOWED_PACKAGE_SCRIPTS.has(script)) {
    throw new Error(`SCRIPT_NOT_ALLOWED: Script '${script}' is not in the default package-script allowlist.`);
  }
  for (const pattern of DANGEROUS_SCRIPT_PATTERNS) {
    if (pattern.test(scriptBody)) {
      throw new Error(`SCRIPT_NOT_ALLOWED: Script '${script}' contains a dangerous command pattern.`);
    }
  }
}

function truncateLines(text: string, maxLines: number): { text: string; truncated: boolean } {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) {
    return { text, truncated: false };
  }
  return {
    text: lines.slice(0, maxLines).join('\n'),
    truncated: true
  };
}

export async function listPackageScripts(input: { workspacePath: string; project?: string }): Promise<PackageScriptsResult> {
  const projectPath = normalizeProjectPath(input.workspacePath, input.project);
  const packageJsonPath = path.join(projectPath, 'package.json');
  const decision = evaluateWorkspacePolicy({
    workspacePath: input.workspacePath,
    action: 'read',
    targetPath: packageJsonPath
  });
  if (!decision.allowed) {
    throw new Error(decision.reason);
  }
  const raw = await readSafeTextFile(packageJsonPath, MAX_READ_FILE_SIZE);
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (error: any) {
    throw new Error(`Invalid package.json: ${error.message}`);
  }

  const dependencies = parsed.dependencies && typeof parsed.dependencies === 'object' ? parsed.dependencies : {};
  const devDependencies = parsed.devDependencies && typeof parsed.devDependencies === 'object' ? parsed.devDependencies : {};
  const allDeps = { ...dependencies, ...devDependencies };
  const mainFrameworks = FRAMEWORK_DEPS.filter(dep => Object.prototype.hasOwnProperty.call(allDeps, dep));

  return {
    packageJsonPath,
    packageManager: await detectPackageManager(projectPath),
    scripts: parsed.scripts && typeof parsed.scripts === 'object' ? parsed.scripts : {},
    dependenciesSummary: {
      dependenciesCount: Object.keys(dependencies).length,
      devDependenciesCount: Object.keys(devDependencies).length,
      mainFrameworks
    }
  };
}

export interface RunPackageScriptResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  startedAt: string;
  finishedAt: string;
}

export async function runPackageScript(input: {
  workspacePath: string;
  project?: string;
  script: string;
  timeoutMs?: number;
  maxOutputLines?: number;
  envMode?: 'safe' | 'inherit-minimal';
}): Promise<RunPackageScriptResult> {
  const projectPath = normalizeProjectPath(input.workspacePath, input.project);
  const packageInfo = await listPackageScripts({ workspacePath: input.workspacePath, project: input.project });
  const scriptBody = packageInfo.scripts[input.script];
  if (!scriptBody) {
    throw new Error(`SCRIPT_NOT_FOUND: Script '${input.script}' was not found in package.json.`);
  }
  assertAllowedPackageScript(input.script, scriptBody);

  const commandSpec = commandForPackageScript(packageInfo.packageManager, input.script);
  let execCommand = commandSpec.command;
  let execArgs = commandSpec.args;
  if (process.platform === 'win32' && ['npm', 'pnpm', 'yarn', 'bun'].includes(execCommand)) {
    execCommand = 'cmd.exe';
    execArgs = ['/c', commandSpec.command, ...commandSpec.args];
  }

  const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 120000, 1000), 10 * 60 * 1000);
  const maxOutputLines = Math.min(Math.max(input.maxOutputLines ?? 500, 1), 5000);
  const startedAt = new Date().toISOString();

  try {
    const { stdout, stderr } = await execFilePromise(execCommand, execArgs, {
      cwd: projectPath,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      shell: false,
      env: input.envMode === 'inherit-minimal'
        ? { ...process.env, PAGER: 'cat', CI: process.env.CI || '1' }
        : { PATH: process.env.PATH || '', SystemRoot: process.env.SystemRoot || '', PAGER: 'cat', CI: '1' }
    });
    const out = truncateLines(redactSensitiveData(stdout), maxOutputLines);
    const err = truncateLines(redactSensitiveData(stderr), maxOutputLines);
    return {
      command: commandSpec.display,
      cwd: projectPath,
      exitCode: 0,
      timedOut: false,
      stdout: out.text,
      stderr: err.text,
      outputTruncated: out.truncated || err.truncated,
      startedAt,
      finishedAt: new Date().toISOString()
    };
  } catch (error: any) {
    const out = truncateLines(redactSensitiveData(error.stdout || ''), maxOutputLines);
    const err = truncateLines(redactSensitiveData(error.stderr || error.message || ''), maxOutputLines);
    return {
      command: commandSpec.display,
      cwd: projectPath,
      exitCode: typeof error.code === 'number' ? error.code : null,
      timedOut: Boolean(error.killed && error.signal === 'SIGTERM') || /timed out/i.test(error.message || ''),
      stdout: out.text,
      stderr: err.text,
      outputTruncated: out.truncated || err.truncated,
      startedAt,
      finishedAt: new Date().toISOString()
    };
  }
}

export interface ProjectProfileResult {
  workspacePath: string;
  projectName: string;
  detectedType: string[];
  framework: string | null;
  language: string[];
  packageManager: PackageScriptsResult['packageManager'] | null;
  scripts: Record<string, string>;
  importantFiles: string[];
  importantDirectories: string[];
  likelyEntryPoints: string[];
  routesDir?: string;
  componentsDir?: string;
  publicDir?: string;
  stylesDir?: string;
  testFramework?: string | null;
  notes: string[];
}

export async function projectProfile(input: { workspacePath: string; maxDepth?: number }): Promise<ProjectProfileResult> {
  const projectPath = normalizeProjectPath(input.workspacePath);
  const files = await listFileNames(projectPath);
  const dirs = await listDirectoryNames(projectPath);
  let packageInfo: PackageScriptsResult | null = null;
  try {
    packageInfo = await listPackageScripts({ workspacePath: projectPath });
  } catch {}

  const packageJsonPath = path.join(projectPath, 'package.json');
  let packageJson: any = {};
  if (await pathExists(packageJsonPath)) {
    try {
      packageJson = JSON.parse(await readSafeTextFile(packageJsonPath, MAX_READ_FILE_SIZE));
    } catch {}
  }
  const deps = { ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) };
  const hasDep = (name: string) => Object.prototype.hasOwnProperty.call(deps, name);
  const hasConfig = (prefix: string) => files.some(file => file.toLowerCase().startsWith(prefix));

  const detectedType: string[] = [];
  const language = new Set<string>();
  const notes: string[] = [];
  let framework: string | null = null;

  if (hasConfig('astro.config') || hasDep('astro')) {
    detectedType.push('frontend', 'astro');
    framework = 'Astro';
  } else if (hasConfig('next.config') || hasDep('next')) {
    detectedType.push('frontend', 'nextjs');
    framework = 'Next.js';
  } else if (hasConfig('vite.config') || hasDep('vite')) {
    detectedType.push('frontend', hasDep('react') ? 'vite-react' : 'vite');
    framework = hasDep('react') ? 'Vite React' : 'Vite';
  } else if (hasDep('react')) {
    detectedType.push('frontend', 'react');
    framework = 'React';
  }
  if (hasDep('express') || hasDep('fastify') || hasDep('@nestjs/core') || hasDep('hono')) {
    detectedType.push('node-backend');
  }
  if (dirs.includes('src-tauri')) {
    detectedType.push('tauri');
  }
  if (files.includes('tsconfig.json') || [...files, ...dirs].some(name => name.toLowerCase().includes('ts'))) {
    language.add('TypeScript');
  }
  if (await pathExists(packageJsonPath)) {
    language.add('JavaScript');
  }
  if (files.some(file => file === 'pyproject.toml' || file === 'requirements.txt')) {
    language.add('Python');
    detectedType.push('python');
  }
  if (hasDep('tailwindcss') || hasConfig('tailwind.config')) {
    notes.push('Tailwind CSS detected.');
  }
  if (!packageInfo) {
    notes.push('No readable package.json found; JS package metadata is unavailable.');
  }

  const importantFiles = files.filter(file =>
    ['package.json', 'tsconfig.json', 'astro.config.mjs', 'astro.config.ts', 'next.config.js', 'next.config.mjs', 'vite.config.ts', 'vite.config.js', 'tailwind.config.js', 'tailwind.config.ts'].includes(file)
  );
  const importantDirectories = dirs.filter(dir =>
    ['src', 'app', 'pages', 'components', 'public', 'styles', 'test', 'tests', 'src-tauri'].includes(dir)
  );
  const entryCandidates = [
    'src/main.tsx', 'src/main.ts', 'src/App.tsx', 'src/App.jsx',
    'app/page.tsx', 'pages/index.tsx', 'src/pages/index.astro', 'src/index.ts'
  ];
  const likelyEntryPoints: string[] = [];
  for (const rel of entryCandidates) {
    if (await pathExists(path.join(projectPath, rel))) {
      likelyEntryPoints.push(rel);
    }
  }

  let routesDir: string | undefined;
  for (const rel of ['app', 'pages', 'src/pages']) {
    if (await pathExists(path.join(projectPath, rel))) {
      routesDir = rel;
      break;
    }
  }
  let componentsDir: string | undefined;
  for (const rel of ['components', 'src/components']) {
    if (await pathExists(path.join(projectPath, rel))) {
      componentsDir = rel;
      break;
    }
  }
  const publicDir = ['public'].find(rel => dirs.includes(rel));
  let stylesDir: string | undefined;
  for (const rel of ['styles', 'src/styles']) {
    if (await pathExists(path.join(projectPath, rel))) {
      stylesDir = rel;
      break;
    }
  }
  const testFramework = hasDep('vitest') ? 'vitest' : hasDep('jest') ? 'jest' : hasDep('@playwright/test') ? 'playwright' : null;

  return {
    workspacePath: projectPath,
    projectName: packageJson.name || path.basename(projectPath),
    detectedType: [...new Set(detectedType)],
    framework,
    language: [...language],
    packageManager: packageInfo?.packageManager || null,
    scripts: packageInfo?.scripts || {},
    importantFiles,
    importantDirectories,
    likelyEntryPoints,
    routesDir,
    componentsDir,
    publicDir,
    stylesDir,
    testFramework,
    notes
  };
}

export interface ReadManyFilesResult {
  requestId: string; durationMs: number; returnedBytes: number; readBytes: number; readBytesComplete:boolean;
  files: Array<{filePath:string;ok:boolean;content?:string;error?:string;truncated?:boolean;
    readBytes?:number;returnedBytes?:number;linesRead?:number;rangeComplete?:boolean;
    fileHash?:string;requestedRange?:FileRange;durationMs?:number;errorLayer?:string;retryable?:boolean}>;
}
export async function readManyFiles(input: {
 workspacePath:string; files:Array<string|FileRange>;maxBytesPerFile?:number;maxTotalBytes?:number;includeLineNumbers?:boolean;
}):Promise<ReadManyFilesResult>{
 const start=performance.now(),requestId=randomUUID();
 const root=resolveAndValidatePath(input.workspacePath,ALLOWED_WORKSPACE_ROOTS);
 await assertNoLinks(root);
 const per=Math.min(Math.max(input.maxBytesPerFile??300*1024,1),MAX_READ_FILE_SIZE);
 const total=Math.min(Math.max(input.maxTotalBytes??1536*1024,1),5*1024*1024);
 const results:ReadManyFilesResult['files']=[];
 let returnedBytes=0,readBytes=0,scanUsed=0,readBytesComplete=true;
 for(const spec of input.files.slice(0,50)){
  const now=performance.now(),name=typeof spec==='string'?spec:spec.filePath;
  let file=path.isAbsolute(name)?name:path.join(root,name);
  try{
   file=validatePathForRead(file,ALLOWED_WORKSPACE_ROOTS);await assertNoLinks(file);
   const rel=path.relative(root,file);
   if(rel.startsWith('..')||path.isAbsolute(rel))throw new Error('FILE_OUTSIDE_WORKSPACE');
   const stat=await fs.lstat(file);
   if(!stat.isFile())throw new Error('NOT_REGULAR_FILE');
   const remaining=total-returnedBytes;
   if(remaining<=0||scanUsed>=5*1024*1024)throw new Error('TOTAL_LIMIT_EXCEEDED');
   if(typeof spec!=='string'){
    const result=await boundedRange(file,spec,Math.min(per,remaining),!!input.includeLineNumbers,5*1024*1024-scanUsed);
    returnedBytes+=result.returnedBytes;readBytes+=result.readBytes;scanUsed+=result.readBytes;
    results.push({filePath:file,ok:true,...result,durationMs:performance.now()-now});continue;
   }
   if(stat.size>per)throw new Error('FILE_TOO_LARGE: use explicit per-file range');
   if(stat.size>remaining||stat.size+scanUsed>5*1024*1024)throw new Error('TOTAL_LIMIT_EXCEEDED');
   const b=await fs.readFile(file);
   if(isBinaryBuffer(b))throw new Error('BINARY_FILE');
   const text=new TextDecoder('utf8',{fatal:true}).decode(b);
   const content=input.includeLineNumbers?text.split(/\r?\n/).map((l,i)=>(i+1)+': '+l).join('\n'):text;
   const bytes=Buffer.byteLength(content);
   if(bytes>per||bytes>remaining)throw new Error('OUTPUT_LIMIT_EXCEEDED');
   returnedBytes+=bytes;readBytes+=b.length;scanUsed+=b.length;
   results.push({filePath:file,ok:true,content,truncated:false,fileHash:sha256(b),readBytes:b.length,returnedBytes:bytes,durationMs:performance.now()-now});
  }catch(error){
   readBytesComplete=false;if(typeof spec!=="string")scanUsed=5*1024*1024;
   results.push({filePath:file,ok:false,error:redactSensitiveData(error instanceof Error?error.message:String(error)),
    truncated:false,errorLayer:'read',retryable:false,durationMs:performance.now()-now});
  }
 }
 return {requestId,durationMs:performance.now()-start,files:results,readBytes,readBytesComplete,returnedBytes};
}

export function registerCodingContextTools(server: McpServer): void {
  server.registerTool(
    "search_code",
    {
      description: "Search code/text in an approved workspace with safe limits and ignored-path guards",
      inputSchema: z.object({
        workspacePath: z.string(),
        query: z.string(),
        fileGlob: z.string().optional(),
        caseSensitive: z.boolean().optional().default(false),
        regex: z.boolean().optional().default(false),
        maxResults: z.number().min(1).max(500).optional().default(100),
        maxBytesPerFile: z.number().min(1).max(MAX_READ_FILE_SIZE).optional().default(1024 * 1024),
        includeLineContext: z.number().min(0).max(10).optional().default(2)
      }),
    },
    async (args) => {
      try {
        const result = await searchCode(args);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error: any) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ success: false, error: redactSensitiveData(error.message) }, null, 2) }]
        };
      }
    }
  );

  server.registerTool(
    "list_package_scripts",
    {
      description: "Read package.json scripts and package manager metadata for an approved JS project",
      inputSchema: z.object({
        workspacePath: z.string(),
        project: z.string().optional()
      }),
    },
    async (args) => {
      try {
        const result = await listPackageScripts(args);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error: any) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ success: false, error: redactSensitiveData(error.message) }, null, 2) }]
        };
      }
    }
  );

  server.registerTool(
    "run_package_script",
    {
      description: "Run an allowlisted package.json script with timeout and bounded redacted output",
      inputSchema: z.object({
        workspacePath: z.string(),
        project: z.string().optional(),
        script: z.string(),
        timeoutMs: z.number().min(1000).max(10 * 60 * 1000).optional().default(120000),
        maxOutputLines: z.number().min(1).max(5000).optional().default(500),
        envMode: z.enum(['safe', 'inherit-minimal']).optional().default('safe')
      }),
    },
    async (args) => {
      try {
        const result = await runPackageScript(args);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error: any) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ success: false, error: redactSensitiveData(error.message) }, null, 2) }]
        };
      }
    }
  );

  server.registerTool(
    "project_profile",
    {
      description: "Detect framework, repo identity, file state/operation outcome or authorization_status. accessMode=owner means standing filesystem/PowerShell access: no per-project grants, bootstrap, preflight or local approval dialog needed. Use filesystem_manage and existing text tools directly. Scoped callers retain their grant requirements.",
      inputSchema: z.object({
        workspacePath: z.string(),
        ...contextFields,
        filePath: z.string().optional(),
        action: z.enum(["profile","identity","operation_status","file_state","authorization_status"]).optional().default("profile"),
        maxDepth: z.number().min(1).max(5).optional().default(3)
      }),
    },
    async (args) => {
      try {
        const context=getToolContext(server);
        if(args.action==='authorization_status'){if(!context)throw new Error('MANAGED_CONTEXT_REQUIRED');return {content:[{type:'text',text:JSON.stringify(await authorizationStatus(context,args.workspacePath))}]};}
        if(args.action==="operation_status"&&!context)throw new Error("MANAGED_CONTEXT_REQUIRED");
        if(args.action==="file_state"){
          if(!context||!args.filePath)throw new Error("SCOPED_FILE_REQUIRED");
          if(!hasOwnerAccess())await authorizeFile(context,args.authorizationId,args.filePath,false);
          const b=await readOptional(args.filePath);
          return {content:[{type:"text",text:JSON.stringify({success:true,filePath:args.filePath,fileHash:b?sha256(b):"ABSENT",bytes:b?.length??0})}]};
        }
        const result = args.action === "operation_status" ? await operationStatus(context!,args.authorizationId,args.operationId) : args.action === "identity" ? await workspaceIdentity(args.workspacePath) : await projectProfile(args);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error: any) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ success: false, error: redactSensitiveData(error.message) }, null, 2) }]
        };
      }
    }
  );

  server.registerTool(
    "read_many_files",
    {
      description: "Read multiple safe text files in one bounded call with per-file errors",
      inputSchema: z.object({
        workspacePath: z.string(),
        files: z.array(z.union([z.string(), z.object({filePath:z.string(),startLine:z.number().int().min(1),endLine:z.number().int().min(1),maxLines:z.number().int().min(1).max(1000).optional()})])).min(1).max(50),
        maxBytesPerFile: z.number().min(1).max(MAX_READ_FILE_SIZE).optional().default(300 * 1024),
        maxTotalBytes: z.number().min(1).max(5 * 1024 * 1024).optional().default(1536 * 1024),
        includeLineNumbers: z.boolean().optional().default(false)
      }),
    },
    async (args) => {
      try {
        const result = await readManyFiles(args);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error: any) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ success: false, error: redactSensitiveData(error.message) }, null, 2) }]
        };
      }
    }
  );
}
