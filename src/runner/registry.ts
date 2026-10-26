import { randomUUID } from 'node:crypto';

export interface Job {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'timeout' | 'stale' | 'cancelled';
  model: string;
  prompt: string;
  timeout: number;
  logPath: string;
  workspacePath: string;
  createdAt: string;
  completedAt?: string;
  exitCode?: number | null;
  error?: string;
  pid?: number;
  lastSeenAt?: string;
}

// In-memory job store
const jobs = new Map<string, Job>();

/**
 * Creates a new job record in the registry.
 */
export function createJob(model: string, prompt: string, timeout: number, logPath: string, workspacePath: string): Job {
  const id = randomUUID();
  const now = new Date().toISOString();
  const job: Job = {
    id,
    status: 'running',
    model,
    prompt,
    timeout,
    logPath,
    workspacePath,
    createdAt: now,
    lastSeenAt: now,
  };
  jobs.set(id, job);
  return job;
}

/**
 * Updates an existing job record.
 */
export function updateJob(id: string, updates: Partial<Omit<Job, 'id'>>): Job | undefined {
  const job = jobs.get(id);
  if (!job) return undefined;
  const updatedJob = { ...job, ...updates };
  jobs.set(id, updatedJob);
  return updatedJob;
}

/**
 * Retrieves a job record by ID.
 */
export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

/**
 * Lists all registered jobs.
 */
export function listJobs(): Job[] {
  return Array.from(jobs.values());
}
