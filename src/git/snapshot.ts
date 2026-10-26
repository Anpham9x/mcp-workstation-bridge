import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { resolveAndValidatePath, checkForbiddenFile } from '../security/index.js';

const execFilePromise = promisify(execFile);

// Thừa hành chính sách giới hạn thời gian chạy và bộ nhớ đệm
const GIT_TIMEOUT_MS = 10000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024; // 10MB

/**
 * Thực thi lệnh git an toàn, không sử dụng shell để tránh shell injection,
 * giới hạn thời gian chạy và dung lượng bộ đệm, xác thực đường dẫn trước khi chạy.
 */
async function runGit(repoPath: string, args: string[]): Promise<string> {
  const validatedPath = resolveAndValidatePath(repoPath);

  try {
    const { stdout } = await execFilePromise('git', args, {
      cwd: validatedPath,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      env: {
        ...process.env,
        PAGER: 'cat',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'C',
      }
    });
    return stdout;
  } catch (error: any) {
    // Chế độ fail-closed: trả về lỗi rõ ràng và đóng luồng xử lý
    throw new Error(`Git command execution failed: ${error.message || error}`);
  }
}

export interface GitSnapshot {
  status: string;
  diffStat: string;
  changedFiles: string[];
  writeScopeViolations?: string[];
  hasWriteScopeViolations?: boolean;
}

/**
 * Chuẩn hóa đường dẫn về định dạng POSIX tương đối với repo.
 */
export function normalizePath(p: string): string {
  let normalized = p.replace(/\\/g, '/');
  if (normalized.startsWith('./')) {
    normalized = normalized.substring(2);
  }
  if (normalized.startsWith('/')) {
    normalized = normalized.substring(1);
  }
  if (normalized.endsWith('/') && normalized !== '/') {
    normalized = normalized.substring(0, normalized.length - 1);
  }
  return normalized.trim();
}

/**
 * Kiểm tra xem một file path có nằm trong phạm vi ghi cho phép hay không.
 */
export function isPathInWriteScope(filePath: string, writeScope: string[]): boolean {
  const normalizedFile = normalizePath(filePath);

  for (const pattern of writeScope) {
    if (!pattern || typeof pattern !== 'string') continue;
    const normalizedPattern = normalizePath(pattern);

    if (normalizedPattern.endsWith('/**')) {
      const dirPrefix = normalizedPattern.slice(0, -3);
      if (dirPrefix === '') {
        return true;
      }
      if (normalizedFile === dirPrefix || normalizedFile.startsWith(dirPrefix + '/')) {
        return true;
      }
    } else {
      if (normalizedFile === normalizedPattern) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Lấy trạng thái git ngắn gọn (git status --short)
 */
export async function getGitStatus(repoPath: string): Promise<string> {
  return runGit(repoPath, ['status', '--short']);
}

/**
 * Lấy thông tin thống kê diff (git diff --stat)
 */
export async function getGitDiffStat(repoPath: string): Promise<string> {
  return runGit(repoPath, ['diff', '--stat']);
}

/**
 * Lấy danh sách các tệp tin đã thay đổi (bao gồm cả file chưa track)
 */
export async function getChangedFiles(repoPath: string): Promise<string[]> {
  const statusOutput = await getGitStatus(repoPath);
  if (!statusOutput.trim()) {
    return [];
  }

  const files: string[] = [];
  const lines = statusOutput.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;

    // Định dạng của `git status -s`: XY path hoặc XY "path" hoặc R  "old -> new"
    const statusPart = line.substring(0, 2);
    let pathPart = line.substring(3).trim();
    if (!pathPart) continue;

    // Loại bỏ dấu nháy kép nếu git tự động bọc tên file chứa ký tự đặc biệt
    if (pathPart.startsWith('"') && pathPart.endsWith('"')) {
      pathPart = pathPart.substring(1, pathPart.length - 1);
    }

    if (statusPart.startsWith('R')) {
      // Trường hợp đổi tên tệp tin: "old_path -> new_path"
      const parts = pathPart.split(' -> ');
      if (parts.length === 2) {
        let newPath = parts[1].trim();
        if (newPath.startsWith('"') && newPath.endsWith('"')) {
          newPath = newPath.substring(1, newPath.length - 1);
        }
        files.push(newPath);
      } else {
        files.push(pathPart);
      }
    } else {
      files.push(pathPart);
    }
  }

  return files;
}

/**
 * Lấy toàn bộ thông tin Git status, diff stat và danh sách các tệp thay đổi,
 * tùy chọn kiểm tra vi phạm phạm vi ghi (write scope violations).
 */
export async function getGitReviewSnapshot(repoPath: string, writeScope?: string[]): Promise<GitSnapshot> {
  const [status, diffStat, changedFiles] = await Promise.all([
    getGitStatus(repoPath),
    getGitDiffStat(repoPath),
    getChangedFiles(repoPath),
  ]);

  const snapshot: GitSnapshot = {
    status: status.trim(),
    diffStat: diffStat.trim(),
    changedFiles,
  };

  if (writeScope !== undefined) {
    const isValidWriteScope = Array.isArray(writeScope) &&
      writeScope.length > 0 &&
      writeScope.every(p => typeof p === 'string' && p.trim() !== '');

    if (!isValidWriteScope) {
      throw new Error("Invalid or empty write scope provided for violation checking.");
    }

    snapshot.writeScopeViolations = changedFiles.filter(
      file => !isPathInWriteScope(file, writeScope)
    );
    snapshot.hasWriteScopeViolations = snapshot.writeScopeViolations.length > 0;
  }

  return snapshot;
}

export interface GitStatusResult {
  status: string;
  changedFiles: string[];
  clean: boolean;
}

/**
 * Lấy trạng thái git mở rộng bao gồm status --short, danh sách file thay đổi và cờ clean.
 */
export async function getGitStatusExtended(repoPath: string): Promise<GitStatusResult> {
  const [status, changedFiles] = await Promise.all([
    getGitStatus(repoPath),
    getChangedFiles(repoPath)
  ]);
  
  return {
    status: status.trim(),
    changedFiles,
    clean: changedFiles.length === 0
  };
}

/**
 * Xác thực giá trị maxLines. Trả về giá trị hợp lệ hoặc ném lỗi.
 * Mặc định: 500, Min: 1, Max: 2000.
 */
export function validateMaxLines(maxLines?: number): number {
  if (maxLines === undefined) {
    return 500;
  }
  if (typeof maxLines !== 'number' || Number.isNaN(maxLines)) {
    throw new Error('Validation failed: maxLines must be a valid number.');
  }
  if (maxLines < 1 || maxLines > 2000) {
    throw new Error('Validation failed: maxLines must be between 1 and 2000.');
  }
  return Math.floor(maxLines);
}

/**
 * Lấy git diff (nội dung chi tiết hoặc stat) có giới hạn đầu ra.
 */
export async function getGitDiff(
  repoPath: string,
  options: { staged?: boolean; maxLines?: number } = {}
): Promise<{ diff: string; truncated: boolean; diffStat: string }> {
  // Xác thực maxLines trước
  const maxLines = validateMaxLines(options.maxLines);

  // Kiểm tra an toàn cho toàn bộ kho lưu trữ xem có thay đổi tệp nhạy cảm nào không
  const changedFiles = await getChangedFiles(repoPath);
  const resolvedRepo = resolveAndValidatePath(repoPath);
  for (const file of changedFiles) {
    const resolvedFile = path.resolve(resolvedRepo, file);
    if (checkForbiddenFile(resolvedFile)) {
      throw new Error(`Security violation: Diff generation blocked because a forbidden secret or credential file has changes.`);
    }
  }

  const args = ['diff'];
  if (options.staged) {
    args.push('--cached');
  }
  
  const diffStatArgs = [...args, '--stat'];
  const [diffText, diffStat] = await Promise.all([
    runGit(repoPath, args),
    runGit(repoPath, diffStatArgs)
  ]);
  
  const lines = diffText.split(/\r?\n/);
  let truncated = false;
  let resultDiff = diffText;
  if (lines.length > maxLines) {
    resultDiff = lines.slice(0, maxLines).join('\n') + `\n\n[... Diff truncated: showing first ${maxLines} lines ...]`;
    truncated = true;
  }
  
  return {
    diff: resultDiff,
    truncated,
    diffStat: diffStat.trim()
  };
}

/**
 * Lấy diff cho một file cụ thể trong repo, giới hạn đầu ra.
 */
export async function getGitFileDiff(
  repoPath: string,
  filePath: string,
  options: { staged?: boolean; maxLines?: number } = {}
): Promise<{ diff: string; truncated: boolean }> {
  // Xác thực maxLines trước
  const maxLines = validateMaxLines(options.maxLines);

  const resolvedRepo = resolveAndValidatePath(repoPath);
  
  // Đảm bảo filePath là an toàn và không bị path traversal ra ngoài repo
  const resolvedFile = path.resolve(resolvedRepo, filePath);
  const relative = path.relative(resolvedRepo, resolvedFile);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`File path validation failed: path '${filePath}' lies outside target repository.`);
  }
  
  // Kiểm tra file nhạy cảm
  if (checkForbiddenFile(resolvedFile)) {
    throw new Error(`Security violation: File '${path.basename(resolvedFile)}' is forbidden.`);
  }
  
  const args = ['diff'];
  if (options.staged) {
    args.push('--cached');
  }
  args.push('--', relative);
  
  const diffText = await runGit(repoPath, args);
  
  const lines = diffText.split(/\r?\n/);
  let truncated = false;
  let resultDiff = diffText;
  if (lines.length > maxLines) {
    resultDiff = lines.slice(0, maxLines).join('\n') + `\n\n[... Diff truncated: showing first ${maxLines} lines ...]`;
    truncated = true;
  }
  
  return {
    diff: resultDiff,
    truncated
  };
}
