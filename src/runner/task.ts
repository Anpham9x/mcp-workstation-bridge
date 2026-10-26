import { spawn, exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { discoverTool } from './health.js';
import { createJob, updateJob, getJob, listJobs, Job } from './registry.js';
import { resolveAndValidatePath, redactSensitiveData } from '../security/index.js';
import { getChangedFiles } from '../git/snapshot.js';

const execAsync = promisify(exec);

// Configuration
export const DEFAULT_TIMEOUT_SEC = 300;
export const MAX_TIMEOUT_SEC = 900;
export const ALLOWED_MODELS = [
  'Gemini 3.5 Flash (Medium)',
  'Gemini 3.1 Pro High',
];

export interface StartTaskInput {
  model?: string;
  prompt: string;
  timeout?: number;
  workspacePath: string;
}

/**
 * Validates the model input against the allowlist.
 */
function validateModel(model?: string): string {
  const selectedModel = model || 'Gemini 3.5 Flash (Medium)';
  if (!ALLOWED_MODELS.includes(selectedModel)) {
    throw new Error(`Model validation failed: '${selectedModel}' is not in the allowlist [${ALLOWED_MODELS.join(', ')}].`);
  }
  return selectedModel;
}

/**
 * Validates the timeout input against safe bounds.
 */
function validateTimeout(timeout?: number): number {
  if (timeout === undefined) {
    return DEFAULT_TIMEOUT_SEC;
  }
  if (typeof timeout !== 'number' || Number.isNaN(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_SEC) {
    throw new Error(`Timeout validation failed: must be a number between 1 and ${MAX_TIMEOUT_SEC} seconds.`);
  }
  return timeout;
}

/**
 * Starts a fresh Antigravity print run process asynchronously.
 * Stream-logs stdout/stderr to a dedicated job log file and updates the in-memory registry.
 */
export async function startAntigravityTask(input: StartTaskInput): Promise<Job> {
  const model = validateModel(input.model);
  const timeout = validateTimeout(input.timeout);

  if (!input.prompt || typeof input.prompt !== 'string' || input.prompt.trim() === '') {
    throw new Error('Prompt validation failed: prompt is empty or invalid.');
  }

  // Discover agy executable path
  const agyFallback = path.join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe');
  const agyStatus = await discoverTool('agy', agyFallback);
  if (!agyStatus.available || !agyStatus.path) {
    throw new Error('Antigravity CLI (agy) is not available or could not be found.');
  }
  const agyPath = agyStatus.path;

  // Create logs directory
  const logDir = path.join(process.cwd(), 'logs', 'agy_jobs');
  await fs.mkdir(logDir, { recursive: true });

  // Create log path
  // Since we don't have the job ID yet, we'll create the job record first.
  // The logPath will contain the job ID.
  const tempId = 'temp';
  const dummyLogPath = path.join(logDir, `${tempId}.log`);
  const job = createJob(model, input.prompt, timeout, dummyLogPath, input.workspacePath);
  
  const finalLogPath = path.join(logDir, `${job.id}.log`);
  updateJob(job.id, { logPath: finalLogPath });
  job.logPath = finalLogPath; // Local reference sync

  // Create log write stream
  const logStream = createWriteStream(finalLogPath, { flags: 'a' });

  // Write header to log file
  logStream.write(`=== Job Started ===\n`);
  logStream.write(`Job ID: ${job.id}\n`);
  logStream.write(`Timestamp: ${job.createdAt}\n`);
  logStream.write(`Model: ${job.model}\n`);
  logStream.write(`Timeout: ${job.timeout}s\n`);
  logStream.write(`Workspace: ${input.workspacePath}\n`);
  logStream.write(`Prompt: [redacted]\n`);
  logStream.write(`===================\n\n`);

  // Build argv array
  // Format: agy --model <model> --dangerously-skip-permissions --print <prompt> --print-timeout <timeout>
  const argv = [
    '--model',
    model,
    '--dangerously-skip-permissions',
    '--print',
    input.prompt,
    '--print-timeout',
    `${timeout}s`,
  ];

  // If the workspace directory is provided, add it
  if (input.workspacePath) {
    argv.push('--add-dir', input.workspacePath);
  }

  // Spawn the child process without using a shell to prevent shell injection
  const child = spawn(agyPath, argv, {
    shell: false,
    cwd: input.workspacePath,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CI: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      PAGER: 'cat',
    },
  });

  // Track the PID
  updateJob(job.id, { pid: child.pid });

  // Pipe stdout and stderr to the log write stream
  child.stdout.pipe(logStream, { end: false });
  child.stderr.pipe(logStream, { end: false });

  // Update lastSeenAt and log heartbeat evidence on stdout/stderr activity
  let lastHeartbeatLoggedAt = 0;
  const logHeartbeat = () => {
    const now = Date.now();
    if (now - lastHeartbeatLoggedAt >= 10000) {
      lastHeartbeatLoggedAt = now;
      try {
        logStream.write(`[Heartbeat] Job activity detected at ${new Date().toISOString()}\n`);
      } catch (err) {}
    }
  };

  child.stdout.on('data', () => {
    const nowStr = new Date().toISOString();
    updateJob(job.id, { lastSeenAt: nowStr });
    logHeartbeat();
  });

  child.stderr.on('data', () => {
    const nowStr = new Date().toISOString();
    updateJob(job.id, { lastSeenAt: nowStr });
    logHeartbeat();
  });

  let isTimeout = false;
  let cleanupPromise: Promise<void> | null = null;

  const timer = setTimeout(() => {
    isTimeout = true;
    if (child.pid) {
      try {
        logStream.write(`[Timeout] Job timed out after ${timeout} seconds. Initiating process tree cleanup...\n`);
      } catch (err) {}
      cleanupPromise = killProcessTree(child.pid, logStream);
    }
  }, timeout * 1000);

  child.on('close', async (code, signal) => {
    clearTimeout(timer);
    if (cleanupPromise) {
      await cleanupPromise;
    }

    const currentJob = getJob(job.id);
    if (currentJob && (currentJob.status === 'cancelled' || currentJob.status === 'stale')) {
      try {
        logStream.end();
      } catch (err) {}
      return;
    }

    const completedAt = new Date().toISOString();

    let status: 'completed' | 'failed' | 'timeout' | 'stale' | 'cancelled' = 'completed';
    let errorMsg: string | undefined;

    if (isTimeout) {
      status = 'timeout';
      errorMsg = `Task timed out after ${timeout} seconds.`;
    } else if (code !== 0) {
      status = 'failed';
      errorMsg = `Process exited with code ${code} and signal ${signal}.`;
    }

    // Write footer to log file
    try {
      logStream.write(`\n=== Job Finished ===\n`);
      logStream.write(`Timestamp: ${completedAt}\n`);
      logStream.write(`Status: ${status}\n`);
      if (errorMsg) {
        logStream.write(`Error: ${errorMsg}\n`);
      }
      logStream.write(`Exit Code: ${code !== null ? code : 'null'}\n`);
      logStream.write(`Signal: ${signal !== null ? signal : 'null'}\n`);
      logStream.write(`====================\n`);
      logStream.end();
    } catch (err) {}

    // Update in-memory registry
    updateJob(job.id, {
      status,
      completedAt,
      exitCode: code,
      error: errorMsg,
    });
  });

  // Return the job info immediately
  return job;
}

export interface ContinueTaskInput {
  jobId: string;
  prompt: string;
  workspacePath?: string;
  model?: string;
  timeout?: number;
}

/**
 * Continues an existing Antigravity task session (refactor loop).
 * Stream-logs stdout/stderr to the existing job log file and updates the in-memory registry.
 */
export async function continueAntigravityTask(input: ContinueTaskInput): Promise<Job> {
  if (!input.jobId || typeof input.jobId !== 'string' || input.jobId.trim() === '') {
    throw new Error('Job ID validation failed: jobId is empty or invalid.');
  }

  const job = getJob(input.jobId);
  if (!job) {
    throw new Error(`Job validation failed: unknown job ID '${input.jobId}'.`);
  }

  if (!input.prompt || typeof input.prompt !== 'string' || input.prompt.trim() === '') {
    throw new Error('Prompt validation failed: prompt is empty or invalid.');
  }

  // Determine and validate model
  const model = validateModel(input.model || job.model);

  // Determine and validate timeout
  const timeout = validateTimeout(input.timeout !== undefined ? input.timeout : job.timeout);

  // Determine and validate workspacePath
  const rawWorkspacePath = input.workspacePath || job.workspacePath;
  const workspacePath = resolveAndValidatePath(rawWorkspacePath);

  // Discover agy executable path
  const agyFallback = path.join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe');
  const agyStatus = await discoverTool('agy', agyFallback);
  if (!agyStatus.available || !agyStatus.path) {
    throw new Error('Antigravity CLI (agy) is not available or could not be found.');
  }
  const agyPath = agyStatus.path;

  // Verify that the log path exists or we can write to it
  // Since flags are 'a', it will append to the existing file
  const logStream = createWriteStream(job.logPath, { flags: 'a' });

  const timestamp = new Date().toISOString();

  // Write header for the continued run to log file
  logStream.write(`\n=== Job Continued ===\n`);
  logStream.write(`Timestamp: ${timestamp}\n`);
  logStream.write(`Model: ${model}\n`);
  logStream.write(`Timeout: ${timeout}s\n`);
  logStream.write(`Workspace: ${workspacePath}\n`);
  logStream.write(`Prompt: [redacted]\n`);
  logStream.write(`======================\n\n`);

  // Build argv array for continuation:
  // agy --continue --dangerously-skip-permissions --print <prompt> --print-timeout <timeout>
  const argv = [
    '--continue',
    '--dangerously-skip-permissions',
    '--print',
    input.prompt,
    '--print-timeout',
    `${timeout}s`,
  ];

  if (workspacePath) {
    argv.push('--add-dir', workspacePath);
  }

  // Update job in registry before spawning to reflect running status and updated params
  const nowStr = new Date().toISOString();
  updateJob(job.id, {
    status: 'running',
    model,
    prompt: input.prompt, // update current active prompt
    timeout,
    workspacePath,
    lastSeenAt: nowStr,
  });

  // Spawn the child process without using a shell to prevent shell injection
  const child = spawn(agyPath, argv, {
    shell: false,
    cwd: workspacePath,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CI: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      PAGER: 'cat',
    },
  });

  // Track the PID
  updateJob(job.id, { pid: child.pid });

  // Pipe stdout and stderr to the log write stream
  child.stdout.pipe(logStream, { end: false });
  child.stderr.pipe(logStream, { end: false });

  // Update lastSeenAt and log heartbeat evidence on stdout/stderr activity
  let lastHeartbeatLoggedAt = 0;
  const logHeartbeat = () => {
    const now = Date.now();
    if (now - lastHeartbeatLoggedAt >= 10000) {
      lastHeartbeatLoggedAt = now;
      try {
        logStream.write(`[Heartbeat] Job activity detected at ${new Date().toISOString()}\n`);
      } catch (err) {}
    }
  };

  child.stdout.on('data', () => {
    const currentStr = new Date().toISOString();
    updateJob(job.id, { lastSeenAt: currentStr });
    logHeartbeat();
  });

  child.stderr.on('data', () => {
    const currentStr = new Date().toISOString();
    updateJob(job.id, { lastSeenAt: currentStr });
    logHeartbeat();
  });

  let isTimeout = false;
  let cleanupPromise: Promise<void> | null = null;

  const timer = setTimeout(() => {
    isTimeout = true;
    if (child.pid) {
      try {
        logStream.write(`[Timeout] Job timed out after ${timeout} seconds. Initiating process tree cleanup...\n`);
      } catch (err) {}
      cleanupPromise = killProcessTree(child.pid, logStream);
    }
  }, timeout * 1000);

  child.on('close', async (code, signal) => {
    clearTimeout(timer);
    if (cleanupPromise) {
      await cleanupPromise;
    }

    const currentJob = getJob(job.id);
    if (currentJob && (currentJob.status === 'cancelled' || currentJob.status === 'stale')) {
      try {
        logStream.end();
      } catch (err) {}
      return;
    }

    const completedAt = new Date().toISOString();

    let status: 'completed' | 'failed' | 'timeout' | 'stale' | 'cancelled' = 'completed';
    let errorMsg: string | undefined;

    if (isTimeout) {
      status = 'timeout';
      errorMsg = `Task timed out after ${timeout} seconds.`;
    } else if (code !== 0) {
      status = 'failed';
      errorMsg = `Process exited with code ${code} and signal ${signal}.`;
    }

    // Write footer to log file
    try {
      logStream.write(`\n=== Job Finished ===\n`);
      logStream.write(`Timestamp: ${completedAt}\n`);
      logStream.write(`Status: ${status}\n`);
      if (errorMsg) {
        logStream.write(`Error: ${errorMsg}\n`);
      }
      logStream.write(`Exit Code: ${code !== null ? code : 'null'}\n`);
      logStream.write(`Signal: ${signal !== null ? signal : 'null'}\n`);
      logStream.write(`====================\n`);
      logStream.end();
    } catch (err) {}

    // Update in-memory registry
    updateJob(job.id, {
      status,
      completedAt,
      exitCode: code,
      error: errorMsg,
    });
  });

  // Sync local object properties to return immediately
  const updatedJob = getJob(job.id) || job;
  return updatedJob;
}

/**
 * Safely reads the tail of a log file up to a specified number of lines.
 */
export async function tailLogFile(logPath: string, maxLines: number = 100): Promise<string> {
  // Validate line bounds in the runner helper too
  if (typeof maxLines !== 'number' || Number.isNaN(maxLines) || maxLines < 1 || maxLines > 1000) {
    throw new Error('Line count validation failed: must be a number between 1 and 1000.');
  }

  let fileHandle: fs.FileHandle | undefined;
  try {
    const stat = await fs.stat(logPath);
    const size = stat.size;
    if (size === 0) {
      return '';
    }

    // Limit read size to at most 1MB to prevent memory issues
    const maxReadBytes = 1024 * 1024; // 1MB
    const bytesToRead = Math.min(size, maxReadBytes);
    const position = size - bytesToRead;

    fileHandle = await fs.open(logPath, 'r');
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, position);
    
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const lines = text.split(/\r?\n/);
    
    // If we didn't read from the very beginning, the first line might be partial,
    // so we discard it unless it's the only line.
    if (position > 0 && lines.length > 1) {
      lines.shift();
    }

    // Take the last maxLines lines
    const tailLines = lines.slice(-maxLines);
    const redactedLines: string[] = [];
    let insidePromptBlock = false;

    for (const line of tailLines) {
      const trimmed = line.trim();
      
      // Check if we hit a separator or a new section marker
      const isSeparator = /^\s*=+\s*$/.test(trimmed);
      const isSectionMarker = /^\s*===\s+Job\s+/i.test(trimmed);

      if (isSeparator || isSectionMarker) {
        insidePromptBlock = false;
        redactedLines.push(line);
        continue;
      }

      if (insidePromptBlock) {
        // Suppress subsequent prompt lines in multi-line prompt blocks
        continue;
      }

      // Check if this line starts a prompt block
      const promptMatch = line.match(/^(\s*)(Prompt:|Prompt|USER_REQUEST:|USER_REQUEST)(.*)$/i);
      if (promptMatch) {
        insidePromptBlock = true;
        redactedLines.push(`${promptMatch[1]}${promptMatch[2]} [redacted]`);
      } else {
        redactedLines.push(line);
      }
    }
    return redactSensitiveData(redactedLines.join('\n'));
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return `[Log file not found at ${logPath}]`;
    }
    throw error;
  } finally {
    if (fileHandle) {
      await fileHandle.close();
    }
  }
}

export interface SanitizedJob {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'timeout' | 'stale' | 'cancelled';
  model: string;
  timeout: number;
  logPath: string;
  workspacePath: string;
  createdAt: string;
  completedAt?: string;
  exitCode?: number | null;
  error?: string;
  pid?: number;
  lastSeenAt?: string;
  durationMs?: number;
  duration?: string;
  changedFiles?: string[];
  lastLogLines?: string;
}

/**
 * Transforms a Job into a SanitizedJob by removing sensitive fields (like prompt).
 */
export function sanitizeJob(
  job: Job,
  extra?: { durationMs?: number; duration?: string; changedFiles?: string[]; lastLogLines?: string }
): SanitizedJob {
  return {
    id: job.id,
    status: job.status,
    model: job.model,
    timeout: job.timeout,
    logPath: job.logPath,
    workspacePath: job.workspacePath,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    exitCode: job.exitCode,
    error: job.error ? redactSensitiveData(job.error) : undefined,
    pid: job.pid,
    lastSeenAt: job.lastSeenAt,
    durationMs: extra?.durationMs,
    duration: extra?.duration,
    changedFiles: extra?.changedFiles,
    lastLogLines: extra?.lastLogLines,
  };
}

/**
 * Normalizes and validates the tail lines count.
 * Throws a validation error if the count is outside the [1, 1000] range.
 */
function validateTailLines(lines: number | undefined, defaultVal: number): number {
  if (lines === undefined || lines === null) {
    return defaultVal;
  }
  if (typeof lines !== 'number' || Number.isNaN(lines) || lines < 1 || lines > 1000) {
    throw new Error('Line count validation failed: must be a number between 1 and 1000.');
  }
  return lines;
}

export const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes; agy can be quiet while still working

/**
 * Checks if a process is still running.
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code !== 'ESRCH';
  }
}

/**
 * Cleans up a process tree gracefully on Windows/Unix, with force kill fallback.
 */
export async function killProcessTree(pid: number, logStream?: any): Promise<void> {
  const isWindows = process.platform === 'win32';
  if (isWindows) {
    try {
      if (logStream) logStream.write(`[Process Cleanup] Attempting graceful taskkill for PID ${pid}...\n`);
      await execAsync(`taskkill /pid ${pid} /T`);
      
      // Wait a moment for graceful termination
      await new Promise((resolve) => setTimeout(resolve, 1500));
      
      if (isProcessRunning(pid)) {
        if (logStream) logStream.write(`[Process Cleanup] PID ${pid} still running. Force killing...\n`);
        await execAsync(`taskkill /pid ${pid} /T /F`);
      } else {
        if (logStream) logStream.write(`[Process Cleanup] PID ${pid} gracefully terminated.\n`);
      }
    } catch (e: any) {
      if (isProcessRunning(pid)) {
        try {
          if (logStream) logStream.write(`[Process Cleanup] Graceful taskkill failed, attempting force taskkill for PID ${pid}...\n`);
          await execAsync(`taskkill /pid ${pid} /T /F`);
        } catch (fe: any) {
          if (logStream) logStream.write(`[Process Cleanup] Force taskkill failed: ${fe.message}\n`);
        }
      }
    }
  } else {
    try {
      if (logStream) logStream.write(`[Process Cleanup] Attempting graceful SIGTERM for PID ${pid}...\n`);
      process.kill(pid, 'SIGTERM');
      
      await new Promise((resolve) => setTimeout(resolve, 1500));
      
      if (isProcessRunning(pid)) {
        if (logStream) logStream.write(`[Process Cleanup] PID ${pid} still running. Sending SIGKILL...\n`);
        process.kill(pid, 'SIGKILL');
      }
    } catch (e: any) {
      if (isProcessRunning(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (ke: any) {
          if (logStream) logStream.write(`[Process Cleanup] SIGKILL failed: ${ke.message}\n`);
        }
      }
    }
  }
}

/**
 * Checks if a running job is stale and updates its status.
 */
export async function checkAndUpdateStaleJob(job: Job, staleThresholdMs?: number): Promise<boolean> {
  if (job.status !== 'running') return false;

  const now = Date.now();
  const lastSeenTime = job.lastSeenAt ? new Date(job.lastSeenAt).getTime() : new Date(job.createdAt).getTime();
  const timeSinceLastSeen = now - lastSeenTime;

  let processGone = false;
  if (job.pid) {
    processGone = !isProcessRunning(job.pid);
  }

  const threshold = staleThresholdMs !== undefined ? staleThresholdMs : STALE_THRESHOLD_MS;
  const heartbeatStale = timeSinceLastSeen > threshold;

  if (processGone || heartbeatStale) {
    const completedAt = new Date().toISOString();
    let errorMsg = '';
    if (processGone) {
      errorMsg = `Job marked stale: process PID ${job.pid} is no longer running.`;
    } else {
      errorMsg = `Job marked stale: no progress/heartbeat for ${Math.round(timeSinceLastSeen / 1000)}s (threshold: ${threshold / 1000}s).`;
    }

    // Update log file if possible
    try {
      const logStream = createWriteStream(job.logPath, { flags: 'a' });
      logStream.write(`\n=== Job Marked Stale ===\n`);
      logStream.write(`Timestamp: ${completedAt}\n`);
      logStream.write(`Reason: ${errorMsg}\n`);
      if (!processGone && job.pid) {
        logStream.write(`[Stale Cleanup] Initiating process tree cleanup for PID ${job.pid}...\n`);
        await killProcessTree(job.pid, logStream);
      }
      logStream.write(`========================\n`);
      logStream.end();
    } catch (logErr) {
      console.error(`Failed to write stale log for job ${job.id}:`, logErr);
    }

    // Update registry
    updateJob(job.id, {
      status: 'stale',
      completedAt,
      error: errorMsg,
    });

    return true;
  }

  return false;
}

export interface JobResultOutput {
  job: SanitizedJob;
  logTail: string;
}

/**
 * Retrieves the status and recent log evidence of a job by ID.
 */
export async function getAntigravityJobResult(jobId: string, tailLines?: number): Promise<JobResultOutput> {
  if (!jobId || typeof jobId !== 'string' || jobId.trim() === '') {
    throw new Error('Job ID validation failed: jobId is empty or invalid.');
  }

  const job = getJob(jobId);
  if (!job) {
    throw new Error(`Job validation failed: unknown job ID '${jobId}'.`);
  }

  // Check if running job is stale before reading status
  if (job.status === 'running') {
    await checkAndUpdateStaleJob(job);
  }

  const validatedLines = validateTailLines(tailLines, 50);
  const logTail = await tailLogFile(job.logPath, validatedLines);

  const updatedJob = getJob(jobId) || job;

  // Calculate duration and changes
  const now = Date.now();
  const createdAtTime = new Date(updatedJob.createdAt).getTime();
  const completedAtTime = updatedJob.completedAt ? new Date(updatedJob.completedAt).getTime() : now;
  const durationMs = completedAtTime - createdAtTime;
  const duration = `${(durationMs / 1000).toFixed(2)}s`;

  const changedFiles = await safeGetChangedFiles(updatedJob.workspacePath);

  return {
    job: sanitizeJob(updatedJob, {
      durationMs,
      duration,
      changedFiles,
      lastLogLines: logTail,
    }),
    logTail,
  };
}

export interface JobLogTailOutput {
  jobId: string;
  status: Job['status'];
  logPath: string;
  logTail: string;
}

/**
 * Retrieves the tail of the log file and basic metadata of a job by ID.
 */
export async function tailAntigravityJobLog(jobId: string, lines?: number): Promise<JobLogTailOutput> {
  if (!jobId || typeof jobId !== 'string' || jobId.trim() === '') {
    throw new Error('Job ID validation failed: jobId is empty or invalid.');
  }

  const job = getJob(jobId);
  if (!job) {
    throw new Error(`Job validation failed: unknown job ID '${jobId}'.`);
  }

  // Check if running job is stale before reading status
  if (job.status === 'running') {
    await checkAndUpdateStaleJob(job);
  }

  const validatedLines = validateTailLines(lines, 100);
  const logTail = await tailLogFile(job.logPath, validatedLines);

  const updatedJob = getJob(jobId) || job;

  return {
    jobId: updatedJob.id,
    status: updatedJob.status,
    logPath: updatedJob.logPath,
    logTail,
  };
}

/**
 * Safe wrapper around getChangedFiles.
 */
async function safeGetChangedFiles(workspacePath: string): Promise<string[]> {
  try {
    return await getChangedFiles(workspacePath);
  } catch (err) {
    return [];
  }
}

/**
 * Builds a complete SanitizedJob representing the job's summary.
 */
export async function buildJobSummary(job: Job, lastLogLinesCount: number = 50): Promise<SanitizedJob> {
  const now = Date.now();
  const createdAtTime = new Date(job.createdAt).getTime();
  const completedAtTime = job.completedAt ? new Date(job.completedAt).getTime() : now;
  const durationMs = completedAtTime - createdAtTime;
  const duration = `${(durationMs / 1000).toFixed(2)}s`;

  const changedFiles = await safeGetChangedFiles(job.workspacePath);
  const lastLogLines = await tailLogFile(job.logPath, lastLogLinesCount);

  return sanitizeJob(job, {
    durationMs,
    duration,
    changedFiles,
    lastLogLines,
  });
}

export interface WaitCompletionResult {
  job: SanitizedJob;
  waitStatus: 'completed' | 'timeout';
  timedOut: boolean;
}

/**
 * Waits for a tracked job to finish up to a bounded timeout.
 */
export async function waitForJobCompletion(
  jobId: string,
  timeoutMs?: number,
  pollIntervalMs?: number
): Promise<WaitCompletionResult> {
  const job = getJob(jobId);
  if (!job) {
    throw new Error(`Job validation failed: unknown job ID '${jobId}'.`);
  }

  const waitTimeout = timeoutMs !== undefined ? timeoutMs : 30000;
  const pollInterval = pollIntervalMs !== undefined ? pollIntervalMs : 1000;

  const boundedTimeout = Math.min(Math.max(waitTimeout, 1000), 120000); // 1s to 120s
  const boundedInterval = Math.min(Math.max(pollInterval, 500), 10000); // 0.5s to 10s

  const startTime = Date.now();

  while (Date.now() - startTime < boundedTimeout) {
    // Refresh job status and check staleness
    const currentJob = getJob(jobId) || job;
    if (currentJob.status === 'running') {
      await checkAndUpdateStaleJob(currentJob);
    }

    const updatedJob = getJob(jobId) || job;
    if (updatedJob.status !== 'running') {
      const summary = await buildJobSummary(updatedJob);
      return {
        job: summary,
        waitStatus: 'completed',
        timedOut: false,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, boundedInterval));
  }

  const finalJob = getJob(jobId) || job;
  const summary = await buildJobSummary(finalJob);
  const timedOut = finalJob.status === 'running';

  return {
    job: summary,
    waitStatus: timedOut ? 'timeout' : 'completed',
    timedOut,
  };
}

/**
 * Cancels/stops the tracked process if still running.
 */
export async function cancelAntigravityJob(jobId: string): Promise<SanitizedJob> {
  const job = getJob(jobId);
  if (!job) {
    throw new Error(`Job validation failed: unknown job ID '${jobId}'.`);
  }

  if (job.status === 'running') {
    const completedAt = new Date().toISOString();
    const errorMsg = 'Job was cancelled by the user.';

    try {
      const logStream = createWriteStream(job.logPath, { flags: 'a' });
      logStream.write(`\n=== Job Cancelled ===\n`);
      logStream.write(`Timestamp: ${completedAt}\n`);
      logStream.write(`Reason: ${errorMsg}\n`);
      if (job.pid) {
        logStream.write(`[Cancellation] Initiating process tree cleanup for PID ${job.pid}...\n`);
        await killProcessTree(job.pid, logStream);
      }
      logStream.write(`======================\n`);
      logStream.end();
    } catch (logErr) {
      console.error(`Failed to write cancellation log for job ${job.id}:`, logErr);
    }

    updateJob(job.id, {
      status: 'cancelled',
      completedAt,
      error: errorMsg,
      exitCode: null,
    });
  }

  const finalJob = getJob(jobId) || job;
  return buildJobSummary(finalJob);
}

/**
 * Reports stale true/false using heartbeat/last-seen logic.
 */
export async function isAntigravityJobStale(jobId: string, staleAfterMs?: number): Promise<boolean> {
  const job = getJob(jobId);
  if (!job) {
    throw new Error(`Job validation failed: unknown job ID '${jobId}'.`);
  }

  if (job.status === 'stale') {
    return true;
  }

  if (job.status !== 'running') {
    return false;
  }

  return checkAndUpdateStaleJob(job, staleAfterMs);
}

/**
 * Returns last error for a job or most recent job error, redacted and bounded.
 */
export function getAntigravityLastError(jobId?: string): { jobId?: string; error?: string } {
  if (jobId) {
    const job = getJob(jobId);
    if (!job) {
      throw new Error(`Job validation failed: unknown job ID '${jobId}'.`);
    }
    
    let redactedError: string | undefined;
    if (job.error) {
      const redacted = redactSensitiveData(job.error);
      redactedError = redacted.length > 1000 ? redacted.substring(0, 1000) + '... [truncated]' : redacted;
    }
    
    return {
      jobId: job.id,
      error: redactedError,
    };
  }

  const allJobs = listJobs();
  const sortedJobs = [...allJobs].sort((a, b) => {
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  const jobWithError = sortedJobs.find((j) => j.error !== undefined);
  if (jobWithError) {
    let redactedError = redactSensitiveData(jobWithError.error!);
    if (redactedError.length > 1000) {
      redactedError = redactedError.substring(0, 1000) + '... [truncated]';
    }
    return {
      jobId: jobWithError.id,
      error: redactedError,
    };
  }

  return {};
}



