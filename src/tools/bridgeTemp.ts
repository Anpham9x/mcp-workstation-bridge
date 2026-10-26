import fs from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { redactSensitiveData, resolveAndValidatePath } from '../security/index.js';

const TEMP_DIR = '.bridge_tmp';
const AUDIT_FILE = 'audit.jsonl';

function safeId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw new Error('sessionId must contain only letters, numbers, _ or -.');
  return value;
}

function tempRoot(workspacePath: string): string {
  return path.join(resolveAndValidatePath(workspacePath), TEMP_DIR);
}

export async function appendAuditEvent(workspacePath: string, event: Record<string, unknown>): Promise<void> {
  const root = tempRoot(workspacePath);
  await fs.mkdir(root, { recursive: true });
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...event });
  await fs.appendFile(path.join(root, AUDIT_FILE), `${redactSensitiveData(line)}\n`, 'utf8');
}

export async function prepareSessionTemp(workspacePath: string, sessionId: string): Promise<string> {
  const dir = path.join(tempRoot(workspacePath), safeId(sessionId));
  await fs.mkdir(dir, { recursive: true });
  await appendAuditEvent(workspacePath, { action: 'temp_session_create', sessionId: safeId(sessionId) });
  return dir;
}

export async function cleanupSessionTemp(workspacePath: string, sessionId: string): Promise<void> {
  const id = safeId(sessionId);
  await fs.rm(path.join(tempRoot(workspacePath), id), { recursive: true, force: true });
  await appendAuditEvent(workspacePath, { action: 'temp_session_cleanup', sessionId: id });
}

export function registerBridgeTempTools(server: McpServer): void {
  server.registerTool('bridge_temp_prepare', { description: 'Create a session-scoped temporary workspace', inputSchema: z.object({ workspacePath: z.string(), sessionId: z.string() }) }, async ({ workspacePath, sessionId }) => {
    try { return { content: [{ type: 'text', text: JSON.stringify({ success: true, tempPath: await prepareSessionTemp(workspacePath, sessionId) }, null, 2) }] }; }
    catch (error: any) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ success: false, error: redactSensitiveData(error.message) }) }] }; }
  });
  server.registerTool('bridge_temp_cleanup', { description: 'Delete one session-scoped temporary workspace', inputSchema: z.object({ workspacePath: z.string(), sessionId: z.string() }) }, async ({ workspacePath, sessionId }) => {
    try { await cleanupSessionTemp(workspacePath, sessionId); return { content: [{ type: 'text', text: JSON.stringify({ success: true, sessionId }) }] }; }
    catch (error: any) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ success: false, error: redactSensitiveData(error.message) }) }] }; }
  });
}
