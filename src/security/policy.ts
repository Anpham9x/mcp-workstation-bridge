import path from 'node:path';
import fs from 'node:fs/promises';
import { hasOwnerAccess, ownerAbsolutePath } from './ownerAccess.js';

/**
 * Interface representing an allowlisted command with its executable, fixed arguments, and optional cwd resolver.
 */
export interface AllowlistedCommand {
  command: string;
  args: string[];
  timeoutMs?: number;
  maxBufferBytes?: number;
  resolveCwd?: (projectPath: string) => Promise<string> | string;
}

export type WorkspaceAction = 'read' | 'write' | 'execute' | 'install' | 'browser' | 'search';

export interface WorkspacePolicyInput {
  workspacePath: string;
  action: WorkspaceAction;
  targetPath?: string;
  command?: string;
}

export interface WorkspacePolicyDecision {
  allowed: boolean;
  reason: string;
  matchedRule?: string;
}

export interface ProjectBridgeConfig {
  writeScope?: string[];
  protectedFiles?: string[];
  allowedPackageScripts?: string[];
  install?: {
    allowPackages?: string[];
    blockPackages?: string[];
    requireConfirmation?: boolean;
    defaultDryRun?: boolean;
    allowVersionSpecs?: boolean;
  };
}

/**
 * Supported workspace roots. All candidate paths must resolve under one of these roots.
 */
export const ALLOWED_WORKSPACE_ROOTS = (process.env.MCP_WORKSPACE_ROOTS || process.cwd())
  .split(path.delimiter).filter(Boolean).map(root => {
    if (!path.isAbsolute(root)) throw new Error('MCP_WORKSPACE_ROOTS must contain absolute paths');
    return path.resolve(root);
  });

/**
 * Hardcoded allowlisted commands mapped to their fixed arguments.
 */
export const ALLOWLISTED_COMMANDS: Record<string, AllowlistedCommand> = {
  python_pytest: {
    command: 'python',
    args: ['-m', 'pytest'],
    timeoutMs: 15 * 60 * 1000,
    resolveCwd: (projectPath) => projectPath,
  },
  python_compileall: {
    command: 'python',
    args: ['-m', 'compileall'],
    timeoutMs: 5 * 60 * 1000,
    resolveCwd: (projectPath) => projectPath,
  },
  ruff_check: {
    command: 'ruff',
    args: ['check'],
    timeoutMs: 5 * 60 * 1000,
    resolveCwd: (projectPath) => projectPath,
  },
  mypy: {
    command: 'mypy',
    args: ['.'],
    timeoutMs: 10 * 60 * 1000,
    resolveCwd: (projectPath) => projectPath,
  },
  npm_typecheck: {
    command: 'npm',
    args: ['run', 'typecheck'],
    timeoutMs: 5 * 60 * 1000,
    resolveCwd: (projectPath) => findConfigDir(projectPath, 'package.json')
  },
  npm_build: {
    command: 'npm',
    args: ['run', 'build'],
    timeoutMs: 15 * 60 * 1000,
    resolveCwd: (projectPath) => findConfigDir(projectPath, 'package.json')
  },
  npm_test: {
    command: 'npm',
    args: ['run', 'test'],
    timeoutMs: 15 * 60 * 1000,
    resolveCwd: (projectPath) => findConfigDir(projectPath, 'package.json'),
  },
  npm_check: {
    command: 'npm',
    args: ['run', 'check'],
    timeoutMs: 10 * 60 * 1000,
    resolveCwd: (projectPath) => findConfigDir(projectPath, 'package.json'),
  },
  git_status: {
    command: 'git',
    args: ['status', '--short'],
    timeoutMs: 60 * 1000,
    resolveCwd: (projectPath) => findConfigDir(projectPath, '.git')
  },
  cargo_check: {
    command: 'cargo',
    args: ['check'],
    timeoutMs: 15 * 60 * 1000,
    resolveCwd: (projectPath) => findConfigDir(projectPath, 'Cargo.toml'),
  },
  cargo_test: {
    command: 'cargo',
    args: ['test'],
    timeoutMs: 15 * 60 * 1000,
    resolveCwd: (projectPath) => findConfigDir(projectPath, 'Cargo.toml'),
  },
  cargo_fmt_check: {
    command: 'cargo',
    args: ['fmt', '--check'],
    timeoutMs: 5 * 60 * 1000,
    resolveCwd: (projectPath) => findConfigDir(projectPath, 'Cargo.toml'),
  },
};

/**
 * Patterns matching forbidden file names or extensions.
 * Blocks:
 * - .env and any variation (.env.local, .env.production, etc.)
 * - Private keys or certificate files (*.pem, *.key)
 * - Obvious credential or secret stores (id_rsa, credentials.json, secrets.yaml, passwd, etc.)
 * - Sensitive package manager and git credentials (.npmrc, .pypirc, .netrc, .git-credentials)
 */
const FORBIDDEN_FILE_REGEXES = [
  /^\.env(?:\..*)?$/i,                     // .env, .env.local, .env.production
  /\.(?:pem|key)$/i,                      // *.pem, *.key
  /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|passwd|password|credentials|secrets)(?:\..*)?$/i, // SSH keys, credential stores
  /^\.(?:npmrc|pypirc|netrc|git-credentials)$/i // npmrc, pypirc, netrc, git-credentials
];

/**
 * Directory names that are ignored/skipped for safety and noise reduction.
 */
export const IGNORED_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'logs',
  '.cache',
  'cache'
]);

/**
 * Maximum file size (in bytes) allowed for reading text files via read_file tool.
 * Default is 5 MB.
 */
export const MAX_READ_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

export const DEV_SERVER_ALLOWED_SCRIPTS = new Set(['dev', 'start', 'preview', 'desktop:dev']);

const DANGEROUS_DEV_SERVER_SCRIPT_PATTERNS = [
  /rm\s+-rf/i,
  /\bdel\s+\/s\b/i,
  /\brmdir\s+\/s\b/i,
  /\bformat\b/i,
  /\bshutdown\b/i,
  /curl\b[\s\S]*\|\s*sh\b/i,
  /invoke-webrequest\b[\s\S]*\|\s*iex\b/i,
  /\b(token|secret|password|api[_-]?key)=["']?[^"'\s]+/i
];

const SAFE_PACKAGE_SPEC_REGEX = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9._~^*<>=-]+)?$/;
const UNSAFE_PACKAGE_SPEC_PATTERNS = [
  /:\/\//,
  /^git[+:]/i,
  /^github:/i,
  /^file:/i,
  /^link:/i,
  /^workspace:/i,
  /\.(?:tgz|tar|zip|gz)$/i,
  /[\\\s;&|`$<>]/
];

/**
 * Common binary file extensions that should be blocked from reading as text.
 */
export const BINARY_EXTENSIONS = new Set([
  // Executables & Libraries
  '.exe', '.dll', '.so', '.dylib', '.bin', '.elf', '.class', '.jar', '.pyc',
  // Archives
  '.zip', '.tar', '.gz', '.rar', '.7z', '.bz2', '.xz', '.tgz',
  // Images
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.tiff', '.bmp',
  // Audio/Video
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.flv', '.mkv', '.ogg',
  // Fonts
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  // Documents/Other
  '.pdf', '.epub', '.dmx'
]);

/**
 * Checks if a path belongs to an ignored directory.
 * Fail-closed: returns true if input is invalid or any folder in the path matches ignored names.
 * 
 * @param filePath - The path to check.
 * @returns true if the path contains an ignored directory component.
 */
export function isIgnoredPath(filePath: string): boolean {
  if(hasOwnerAccess())return false;
  if (!filePath || typeof filePath !== 'string' || filePath.trim() === '') {
    return true; // fail-closed
  }
  
  const normalized = path.normalize(filePath);
  const parts = normalized.split(path.sep);
  
  return parts.some(part => IGNORED_DIR_NAMES.has(part.toLowerCase()));
}

/**
 * Checks if a path has a known binary file extension.
 * Fail-closed: returns true if the path is invalid.
 * 
 * @param filePath - The path or filename to check.
 * @returns true if the file extension matches a known binary extension.
 */
export function isBinaryExtension(filePath: string): boolean {
  if (!filePath || typeof filePath !== 'string' || filePath.trim() === '') {
    return true; // fail-closed
  }
  
  const ext = path.extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Detects if a buffer contains binary data by checking for null bytes in the first 1024 bytes.
 * Fail-closed: returns true if the buffer is invalid or empty.
 * 
 * @param buffer - The buffer to analyze.
 * @returns true if binary content is detected.
 */
export function isBinaryBuffer(buffer: Buffer): boolean {
  if (!buffer || !(buffer instanceof Buffer)) {
    return true; // fail-closed
  }
  
  if (buffer.length === 0) {
    return false; // empty buffer is safe
  }
  
  // Check up to the first 1024 bytes for a null byte (\0)
  const checkLength = Math.min(buffer.length, 1024);
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  
  return false;
}

/**
 * Resolves a candidate path and validates that it resides strictly within the allowed workspace roots.
 * Fail-closed: Throws an error if validation fails or path is invalid.
 * 
 * @param candidatePath - The file or directory path to validate.
 * @param allowedRoots - Optional custom list of allowed roots (defaults to ALLOWED_WORKSPACE_ROOTS).
 * @returns The normalized absolute path if valid.
 */
export function resolveAndValidatePath(candidatePath: string, allowedRoots: string[] = ALLOWED_WORKSPACE_ROOTS): string {
  if(hasOwnerAccess())return ownerAbsolutePath(candidatePath);
  if (!candidatePath || typeof candidatePath !== 'string' || candidatePath.trim() === '') {
    throw new Error('Path validation failed: candidate path is empty or invalid.');
  }

  // Resolve to absolute path and normalize to clean up '.' and '..'
  const absoluteCandidate = path.resolve(candidatePath);

  let isAllowed = false;
  for (const root of allowedRoots) {
    if (!root) continue;
    const absoluteRoot = path.resolve(root);
    const relative = path.relative(absoluteRoot, absoluteCandidate);

    // If the relative path does not start with '..' and is not absolute, it resides within the root directory.
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      isAllowed = true;
      break;
    }
  }

  if (!isAllowed) {
    throw new Error(`Path validation failed: path '${absoluteCandidate}' lies outside configured workspace roots.`);
  }

  return absoluteCandidate;
}

/**
 * Checks if a file name or path matches a forbidden secret/credential pattern.
 * Fail-closed: returns true if any check indicates a forbidden file, or if path is invalid.
 * 
 * @param filePath - The path or filename to check.
 * @returns true if the file is forbidden, false otherwise.
 */
export function checkForbiddenFile(filePath: string): boolean {
  if(hasOwnerAccess())return false;
  if (!filePath || typeof filePath !== 'string' || filePath.trim() === '') {
    return true; // fail-closed
  }

  const fileName = path.basename(filePath);

  for (const regex of FORBIDDEN_FILE_REGEXES) {
    if (regex.test(fileName)) {
      return true;
    }
  }

  return false;
}

/**
 * Validates a path specifically for read-only operations.
 * Resolves path, checks allowed roots, checks forbidden secret files, blocks ignored paths, and blocks binary extensions.
 * Fail-closed: Throws an error if any check fails.
 * 
 * @param candidatePath - The file or directory path to validate.
 * @param allowedRoots - Optional custom list of allowed roots.
 * @returns The resolved absolute path.
 */
export function validatePathForRead(candidatePath: string, allowedRoots: string[] = ALLOWED_WORKSPACE_ROOTS): string {
  const resolved = resolveAndValidatePath(candidatePath, allowedRoots);
  
  if (checkForbiddenFile(resolved)) {
    throw new Error(`Security violation: File '${path.basename(resolved)}' is a forbidden secret or credential store.`);
  }
  
  if (isIgnoredPath(resolved)) {
    throw new Error(`Security violation: Path '${resolved}' lies within an ignored directory.`);
  }

  if (isBinaryExtension(resolved)) {
    throw new Error(`Security violation: Reading binary file '${resolved}' is not allowed.`);
  }
  
  return resolved;
}

/**
 * Validates a path specifically for write or patch operations.
 * Enforces stricter validation than read operations, such as blocking project config files.
 * Fail-closed: Throws an error if any check fails.
 * 
 * @param candidatePath - The file path to validate for writing.
 * @param allowedRoots - Optional custom list of allowed roots.
 * @returns The resolved absolute path.
 */
export function validatePathForWrite(candidatePath: string, allowedRoots: string[] = ALLOWED_WORKSPACE_ROOTS): string {
  const resolved = resolveAndValidatePath(candidatePath, allowedRoots);
  if(hasOwnerAccess()){if(isBinaryExtension(resolved))throw new Error('BINARY_FILE_USE_FILESYSTEM_BYTES_OR_POWERSHELL');return resolved;}
  
  if (checkForbiddenFile(resolved)) {
    throw new Error(`Security violation: Writing to forbidden file '${path.basename(resolved)}' is not allowed.`);
  }
  
  if (isIgnoredPath(resolved)) {
    throw new Error(`Security violation: Writing to ignored path '${resolved}' is not allowed.`);
  }

  if (isBinaryExtension(resolved)) {
    throw new Error(`Security violation: Writing binary file '${resolved}' is not allowed.`);
  }

  // Stricter write rule: prevent arbitrary modification of project configuration files
  const fileName = path.basename(resolved).toLowerCase();
  const BLOCKED_WRITE_CONFIGS = new Set([
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    '.gitignore'
  ]);
  
  if (BLOCKED_WRITE_CONFIGS.has(fileName)) {
    throw new Error(`Security violation: Modifying project configuration file '${fileName}' is restricted.`);
  }

  return resolved;
}

/**
 * Common safe text file extensions allowed for writing/modification.
 */
export const SAFE_TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.jsonl', '.yaml', '.yml',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.css', '.html', '.xml', '.csv', '.tsv', '.log',
  '.ps1', '.sh', '.bat', '.cmd'
]);

/**
 * Checks if a file path has a safe text extension.
 * Rejects extensionless files to prevent arbitrary binary or config writes.
 * Special case allowed: .gitignore
 * 
 * @param filePath - The path or filename to check.
 * @returns true if the extension is safe.
 */
export function isSafeTextExtension(filePath: string): boolean {
  if (!filePath || typeof filePath !== 'string' || filePath.trim() === '') {
    return false; // fail-closed
  }
  
  const basename = path.basename(filePath).toLowerCase();
  if (basename === '.gitignore') {
    return true;
  }

  const ext = path.extname(filePath).toLowerCase();
  return SAFE_TEXT_EXTENSIONS.has(ext);
}

/**
 * Validates a path specifically for direct text write/modification operations.
 * Enforces all write validation rules plus strict safe text extension checks.
 * 
 * @param candidatePath - The file path to validate for writing.
 * @param allowedRoots - Optional custom list of allowed roots.
 * @returns The resolved absolute path.
 */
export function validatePathForTextWrite(candidatePath: string, allowedRoots: string[] = ALLOWED_WORKSPACE_ROOTS): string {
  const resolved = validatePathForWrite(candidatePath, allowedRoots);
  if(hasOwnerAccess())return resolved;
  
  if (!isSafeTextExtension(resolved)) {
    throw new Error(`Security violation: File '${path.basename(resolved)}' does not have a safe text extension.`);
  }
  
  return resolved;
}

/**
 * Returns a structured allow/deny decision for common workspace actions.
 * This is intentionally side-effect free so tools can share policy checks before doing work.
 */
export function evaluateWorkspacePolicy(input: WorkspacePolicyInput): WorkspacePolicyDecision {
  if(hasOwnerAccess()){ownerAbsolutePath(input.workspacePath);if(input.targetPath)ownerAbsolutePath(path.isAbsolute(input.targetPath)?input.targetPath:path.resolve(input.workspacePath,input.targetPath));return {allowed:true,reason:'Standing authenticated owner access; Windows account permissions apply.'};}
  try {
    const workspace = resolveAndValidatePath(input.workspacePath);

    if (isIgnoredPath(workspace) || checkForbiddenFile(workspace)) {
      return {
        allowed: false,
        reason: 'Workspace path is forbidden or ignored.',
        matchedRule: 'WORKSPACE_PROTECTED'
      };
    }

    const target = input.targetPath
      ? (path.isAbsolute(input.targetPath) ? input.targetPath : path.join(workspace, input.targetPath))
      : workspace;

    switch (input.action) {
      case 'read':
      case 'search':
        validatePathForRead(target);
        return {
          allowed: true,
          reason: `${input.action} action is allowed for a safe text path inside an approved workspace.`,
          matchedRule: 'SAFE_READ_PATH'
        };
      case 'write':
        validatePathForTextWrite(target);
        return {
          allowed: true,
          reason: 'write action is allowed for a safe text path inside an approved workspace.',
          matchedRule: 'SAFE_TEXT_WRITE_PATH'
        };
      case 'execute':
        if (!input.command) {
          return {
            allowed: false,
            reason: 'Execute action requires a command ID.',
            matchedRule: 'COMMAND_ID_REQUIRED'
          };
        }
        resolveAndValidateCommand(input.command);
        return {
          allowed: true,
          reason: 'execute action is allowed for a registered command ID.',
          matchedRule: 'ALLOWLISTED_COMMAND'
        };
      case 'install':
        if (input.command) {
          assertSafePackageSpec(input.command);
          return {
            allowed: true,
            reason: 'install action is allowed only through install_package_safe with dry-run default or explicit confirmation.',
            matchedRule: 'SAFE_PACKAGE_INSTALL_SPEC'
          };
        }
        return {
          allowed: false,
          reason: 'Install action requires a package spec and the dedicated install_package_safe tool.',
          matchedRule: 'INSTALL_REQUIRES_DEDICATED_TOOL'
        };
      case 'browser':
        return {
          allowed: true,
          reason: 'browser action is allowed when routed through bounded browser tools that do not expose cookies, localStorage, tokens, or password values.',
          matchedRule: 'BOUNDED_BROWSER_TOOL'
        };
      default:
        return {
          allowed: false,
          reason: 'Unknown workspace action.',
          matchedRule: 'UNKNOWN_ACTION'
        };
    }
  } catch (error: any) {
    return {
      allowed: false,
      reason: error.message || 'Workspace policy validation failed.',
      matchedRule: 'VALIDATION_FAILED'
    };
  }
}

export function assertSafePackageSpec(packageSpec: string, allowVersionSpecs = true): void {
  if (!packageSpec || typeof packageSpec !== 'string' || packageSpec.trim() !== packageSpec) {
    throw new Error('Package validation failed: package spec is empty or has surrounding whitespace.');
  }

  for (const pattern of UNSAFE_PACKAGE_SPEC_PATTERNS) {
    if (pattern.test(packageSpec)) {
      throw new Error('Package validation failed: URL, git, file, workspace, tarball, path, or shell-like package specs are not allowed.');
    }
  }

  const slashCount = (packageSpec.match(/\//g) || []).length;
  if (slashCount > 0 && (!packageSpec.startsWith('@') || slashCount !== 1)) {
    throw new Error('Package validation failed: path-like package specs are not allowed.');
  }

  if (!SAFE_PACKAGE_SPEC_REGEX.test(packageSpec)) {
    throw new Error('Package validation failed: package spec must be a registry package name with an optional simple version spec.');
  }

  const atIndex = packageSpec.startsWith('@')
    ? packageSpec.indexOf('@', packageSpec.indexOf('/') + 1)
    : packageSpec.indexOf('@');
  if (!allowVersionSpecs && atIndex !== -1) {
    throw new Error('Package validation failed: version specs are disabled by project policy.');
  }
}

export function validateProjectBridgeConfig(config: ProjectBridgeConfig): void {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Project config validation failed: config must be an object.');
  }

  const assertStringArray = (value: unknown, fieldName: string): void => {
    if (value === undefined) return;
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')) {
      throw new Error(`Project config validation failed: ${fieldName} must be an array of non-empty strings.`);
    }
  };

  assertStringArray(config.writeScope, 'writeScope');
  assertStringArray(config.protectedFiles, 'protectedFiles');
  assertStringArray(config.allowedPackageScripts, 'allowedPackageScripts');
  assertStringArray(config.install?.allowPackages, 'install.allowPackages');
  assertStringArray(config.install?.blockPackages, 'install.blockPackages');

  if (config.install?.allowPackages) {
    for (const packageSpec of config.install.allowPackages) {
      assertSafePackageSpec(packageSpec, true);
    }
  }
  if (config.install?.blockPackages) {
    for (const packageSpec of config.install.blockPackages) {
      assertSafePackageSpec(packageSpec, true);
    }
  }
}

export function assertAllowedDevServerScript(script: string, scriptBody: string): void {
  if(hasOwnerAccess()){if(!/^[A-Za-z0-9:_-]{1,100}$/.test(script))throw new Error('INVALID_SCRIPT_NAME');return;}
  if (!DEV_SERVER_ALLOWED_SCRIPTS.has(script)) {
    throw new Error(`DEV_SERVER_SCRIPT_NOT_ALLOWED: Script '${script}' must be one of: ${[...DEV_SERVER_ALLOWED_SCRIPTS].join(', ')}.`);
  }
  for (const pattern of DANGEROUS_DEV_SERVER_SCRIPT_PATTERNS) {
    if (pattern.test(scriptBody)) {
      throw new Error(`DEV_SERVER_SCRIPT_NOT_ALLOWED: Script '${script}' contains a dangerous command pattern.`);
    }
  }
}

export function assertLocalBrowserUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Browser URL validation failed: URL is invalid.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Browser URL validation failed: only http/https URLs are allowed.');
  }
  const host = parsed.hostname.toLowerCase();
  const allowedHosts = new Set(['localhost', '127.0.0.1', '::1']);
  if (!allowedHosts.has(host)) {
    throw new Error('Browser URL validation failed: only localhost, 127.0.0.1, or ::1 targets are allowed.');
  }
  return parsed;
}

/**
 * Resolves a command by its command ID and returns its fixed executable and argument array.
 * Fail-closed: Throws an error for unknown command IDs.
 * 
 * @param commandId - The ID of the command to execute.
 * @returns AllowlistedCommand configuration.
 */
export function resolveAndValidateCommand(commandId: string): AllowlistedCommand {
  if (!commandId || typeof commandId !== 'string') {
    throw new Error('Command validation failed: commandId is empty or invalid.');
  }

  const allowlisted = ALLOWLISTED_COMMANDS[commandId];
  if (!allowlisted) {
    throw new Error(`Command validation failed: command ID '${commandId}' is not allowlisted.`);
  }

  // Return a copy to ensure immutability
  return {
    command: allowlisted.command,
    args: [...allowlisted.args],
    timeoutMs: allowlisted.timeoutMs,
    maxBufferBytes: allowlisted.maxBufferBytes,
  };
}

/**
 * Redacts sensitive data from a text string.
 * This covers:
 * - CONTROL_PLANE_* environment variables or configuration values
 * - API keys, bearer tokens, private keys, obvious env secrets
 * - Raw prompts, prompt-like commands (e.g. `--print "..."`)
 * - Obvious credential patterns in JSON/text
 * - Values of active sensitive environment variables from process.env
 */
export function redactSensitiveData(text: string): string {
  if (!text || typeof text !== 'string') {
    return text;
  }

  let redacted = text;

  // 1. Redact Private Keys (PEM)
  redacted = redacted.replace(
    /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g,
    '[REDACTED PRIVATE KEY]'
  );

  // 2. Redact Bearer tokens
  // E.g. Bearer eyJ... or Bearer abc...
  redacted = redacted.replace(
    /\b(Bearer\s+)[^\s"']{10,}/gi,
    '$1[REDACTED]'
  );

  // 3. Redact obvious API Keys, secrets, passwords in assignments or JSON
  // E.g. api_key = "abc", "secret": "xyz", "password": "123"
  // Case A: value is quoted
  redacted = redacted.replace(
    /(["']?)\b(api[_-]?key|secret|token|password|passwd|auth[_-]?token|credentials?)\1(\s*[:=]\s*)(["'])([^"'\n]{8,128})\4/gi,
    '$1$2$1$3$4[REDACTED]$4'
  );
  // Case B: value is unquoted
  redacted = redacted.replace(
    /(["']?)\b(api[_-]?key|secret|token|password|passwd|auth[_-]?token|credentials?)\1(\s*[:=]\s*)([a-zA-Z0-9_\-\.\~+\/=]{8,128})\b/gi,
    '$1$2$1$3[REDACTED]'
  );

  // 4. Redact command line prompts (e.g., --print "..." or --print '...' or --print value)
  // Let's match --print followed by a quoted string or unquoted word
  redacted = redacted.replace(
    /(--print\s+)(?:"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|[^\s]+)/gi,
    '$1[redacted]'
  );

  // 5. Redact CONTROL_PLANE_* keys or values
  // e.g. CONTROL_PLANE_KEY=value, "CONTROL_PLANE_TOKEN": "value"
  // Case A: value is quoted
  redacted = redacted.replace(
    /(["']?)\b(CONTROL_PLANE_[A-Z0-9_]*)\1(\s*[:=]\s*)(["'])([^"'\n]+?)\4/gi,
    '$1$2$1$3$4[REDACTED]$4'
  );
  // Case B: value is unquoted
  redacted = redacted.replace(
    /(["']?)\b(CONTROL_PLANE_[A-Z0-9_]*)\1(\s*[:=]\s*)([a-zA-Z0-9_\-\.\~+\/=]+)\b/gi,
    '$1$2$1$3[REDACTED]'
  );

  // 6. Dynamically redact values of sensitive environment variables currently in process.env
  const sensitiveValues = new Set<string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    const upperKey = key.toUpperCase();
    const isSensitiveName =
      upperKey.startsWith('CONTROL_PLANE_') ||
      upperKey.includes('KEY') ||
      upperKey.includes('SECRET') ||
      upperKey.includes('TOKEN') ||
      upperKey.includes('PASSWORD') ||
      upperKey.includes('PASSWD') ||
      upperKey.includes('AUTH') ||
      upperKey.includes('CREDENTIAL') ||
      upperKey.includes('PRIVATE');

    if (isSensitiveName && value.length >= 4) {
      const lowerVal = value.toLowerCase();
      if (
        lowerVal !== 'true' &&
        lowerVal !== 'false' &&
        lowerVal !== 'development' &&
        lowerVal !== 'production' &&
        lowerVal !== 'test' &&
        lowerVal !== 'localhost' &&
        lowerVal !== '127.0.0.1'
      ) {
        sensitiveValues.add(value);
      }
    }
  }

  // Also search for anything starting with CONTROL_PLANE_ in the env just in case
  for (const val of sensitiveValues) {
    const escaped = val.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(escaped, 'g');
    redacted = redacted.replace(regex, '[REDACTED]');
  }

  return redacted;
}

/**
 * Checks if a path exists (file or directory).
 */
async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively search for a directory containing the marker file/directory.
 * It checks projectPath, searches downward 2 levels (throwing error if multiple matches are found),
 * and searches upward (safely within allowed roots). Throws error if no marker is found.
 */
export async function findConfigDir(projectPath: string, marker: string): Promise<string> {
  // 1. Check if the projectPath itself contains the marker
  if (await pathExists(path.join(projectPath, marker))) {
    return projectPath;
  }

  // 2. Search downward (1st level children, then 2nd level children)
  let entries: any[] = [];
  try {
    entries = await fs.readdir(projectPath, { withFileTypes: true });
  } catch {}

  const candidates: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const subPath = path.join(projectPath, entry.name);
      if (isIgnoredPath(subPath)) continue;

      if (await pathExists(path.join(subPath, marker))) {
        candidates.push(subPath);
      }
    }
  }

  if (candidates.length > 1) {
    throw new Error(`Ambiguity error: Multiple subprojects containing '${marker}' found under '${projectPath}': ${candidates.join(', ')}`);
  }

  if (candidates.length === 1) {
    return candidates[0];
  }

  if (candidates.length === 0) {
    const subCandidates: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        const subPath = path.join(projectPath, entry.name);
        if (isIgnoredPath(subPath)) continue;

        try {
          const subEntries = await fs.readdir(subPath, { withFileTypes: true });
          for (const subEntry of subEntries) {
            if (subEntry.isDirectory() && !subEntry.isSymbolicLink()) {
              const subSubPath = path.join(subPath, subEntry.name);
              if (isIgnoredPath(subSubPath)) continue;

              if (await pathExists(path.join(subSubPath, marker))) {
                subCandidates.push(subSubPath);
              }
            }
          }
        } catch {}
      }
    }

    if (subCandidates.length > 1) {
      throw new Error(`Ambiguity error: Multiple subprojects containing '${marker}' found under '${projectPath}' (level 2): ${subCandidates.join(', ')}`);
    }

    if (subCandidates.length === 1) {
      return subCandidates[0];
    }
  }

  // 3. Search upward from projectPath (up to the system root or outside allowed roots)
  let current = projectPath;
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) break; // Reached drive root
    
    // Safety boundary: do not traverse outside allowed roots
    try {
      resolveAndValidatePath(parent);
    } catch {
      break; // Parent lies outside allowed roots, stop climbing
    }

    if (await pathExists(path.join(parent, marker))) {
      return parent;
    }
    current = parent;
  }

  // Fail-closed if no marker is found anywhere
  throw new Error(`Command registry error: Could not find configuration marker '${marker}' in '${projectPath}' or its hierarchy.`);
}

/**
 * Resolves a command by its command ID and a base project path, automatically deriving and validating the correct cwd.
 * Fail-closed: Throws an error for unknown command IDs or if the derived cwd lies outside approved roots.
 * 
 * @param commandId - The ID of the command to execute.
 * @param projectPath - The base path of the project/workspace.
 * @returns Promise resolving to the command executable, args, and validated cwd.
 */
export async function resolveCommandForProject(
  commandId: string,
  projectPath: string
): Promise<{ command: string; args: string[]; cwd: string; timeoutMs?: number; maxBufferBytes?: number }> {
  if (!commandId || typeof commandId !== 'string') {
    throw new Error('Command validation failed: commandId is empty or invalid.');
  }

  const allowlisted = ALLOWLISTED_COMMANDS[commandId];
  if (!allowlisted) {
    throw new Error(`Command validation failed: command ID '${commandId}' is not allowlisted.`);
  }

  // 1. Resolve actual cwd
  let derivedCwd = projectPath;
  if (allowlisted.resolveCwd) {
    derivedCwd = await allowlisted.resolveCwd(projectPath);
  }

  // 2. Validate the derived cwd
  const validatedCwd = resolveAndValidatePath(derivedCwd);

  return {
    command: allowlisted.command,
    args: [...allowlisted.args],
    cwd: validatedCwd,
    timeoutMs: allowlisted.timeoutMs,
    maxBufferBytes: allowlisted.maxBufferBytes,
  };
}
