import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertLocalBrowserUrl, redactSensitiveData } from "../security/index.js";

interface DomSnapshotNode {
  tag: string;
  id?: string;
  classes?: string[];
  text?: string;
  attributes?: Record<string, string>;
}

const SENSITIVE_ATTRS = new Set([
  'value',
  'cookie',
  'authorization',
  'token',
  'access-token',
  'refresh-token',
  'password',
  'secret',
  'api-key',
  'apikey'
]);

function decodeHtml(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeText(text: string, maxTextLength: number): string {
  const normalized = decodeHtml(text).replace(/\s+/g, ' ').trim();
  return normalized.length > maxTextLength ? `${normalized.slice(0, maxTextLength)}...` : normalized;
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(raw)) !== null) {
    const name = match[1].toLowerCase();
    const value = match[3] ?? match[4] ?? match[5] ?? '';
    attrs[name] = decodeHtml(value);
  }
  return attrs;
}

function sanitizeAttributes(tag: string, attrs: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  const isPasswordInput = tag === 'input' && (attrs.type || '').toLowerCase() === 'password';
  for (const [name, value] of Object.entries(attrs)) {
    const lowerName = name.toLowerCase();
    if (lowerName.startsWith('on')) {
      continue;
    }
    if (SENSITIVE_ATTRS.has(lowerName) || lowerName.includes('token') || lowerName.includes('secret')) {
      sanitized[name] = '[REDACTED]';
      continue;
    }
    if (isPasswordInput && lowerName === 'value') {
      sanitized[name] = '[REDACTED]';
      continue;
    }
    if (['id', 'class', 'type', 'role', 'name', 'aria-label', 'href', 'src', 'placeholder', 'alt', 'title'].includes(lowerName)) {
      sanitized[name] = redactSensitiveData(value).slice(0, 200);
    }
  }
  return sanitized;
}

function selectorMatches(node: DomSnapshotNode, selector?: string): boolean {
  if (!selector) {
    return true;
  }
  const trimmed = selector.trim();
  if (!trimmed) {
    return true;
  }
  if (trimmed.startsWith('#')) {
    return node.id === trimmed.slice(1);
  }
  if (trimmed.startsWith('.')) {
    return Boolean(node.classes?.includes(trimmed.slice(1)));
  }
  return node.tag.toLowerCase() === trimmed.toLowerCase();
}

export function snapshotHtml(input: {
  html: string;
  selector?: string;
  maxNodes?: number;
  maxTextLength?: number;
}): { nodes: DomSnapshotNode[]; nodeCount: number; truncated: boolean } {
  const maxNodes = Math.min(Math.max(input.maxNodes ?? 100, 1), 1000);
  const maxTextLength = Math.min(Math.max(input.maxTextLength ?? 200, 1), 2000);
  const scrubbedHtml = input.html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '');

  const nodes: DomSnapshotNode[] = [];
  let nodeCount = 0;
  let truncated = false;
  const tagRegex = /<([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*)?>([^<]{0,4000})/g;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(scrubbedHtml)) !== null) {
    const tag = match[1].toLowerCase();
    if (tag.startsWith('/')) continue;
    const attrs = parseAttributes(match[2] || '');
    const sanitizedAttrs = sanitizeAttributes(tag, attrs);
    const node: DomSnapshotNode = {
      tag,
      id: sanitizedAttrs.id,
      classes: sanitizedAttrs.class ? sanitizedAttrs.class.split(/\s+/).filter(Boolean) : undefined,
      text: normalizeText(match[3] || '', maxTextLength) || undefined,
      attributes: sanitizedAttrs
    };
    if (selectorMatches(node, input.selector)) {
      nodeCount++;
      if (nodes.length >= maxNodes) {
        truncated = true;
        continue;
      }
      nodes.push(node);
    }
  }
  return { nodes, nodeCount, truncated };
}

export async function browserDomSnapshot(input: {
  url: string;
  selector?: string;
  maxNodes?: number;
  maxTextLength?: number;
  timeoutMs?: number;
}): Promise<{ url: string; nodes: DomSnapshotNode[]; nodeCount: number; truncated: boolean }> {
  const parsed = assertLocalBrowserUrl(input.url);
  const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 10000, 1000), 30000);
  const response = await fetch(parsed.toString(), { signal: AbortSignal.timeout(timeoutMs) });
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
    throw new Error(`DOM snapshot failed: expected HTML response, received '${contentType || 'unknown'}'.`);
  }
  const html = await response.text();
  return {
    url: parsed.toString(),
    ...snapshotHtml({
      html,
      selector: input.selector,
      maxNodes: input.maxNodes,
      maxTextLength: input.maxTextLength
    })
  };
}

export function registerBrowserDomSnapshotTool(server: McpServer): void {
  server.registerTool(
    "browser_dom_snapshot",
    {
      description: "Fetch a bounded localhost HTML DOM snapshot with selector filtering and secret/password blocking",
      inputSchema: z.object({
        url: z.string(),
        selector: z.string().optional(),
        maxNodes: z.number().min(1).max(1000).optional().default(100),
        maxTextLength: z.number().min(1).max(2000).optional().default(200),
        timeoutMs: z.number().min(1000).max(30000).optional().default(10000)
      }),
    },
    async (args) => {
      try {
        return { content: [{ type: "text", text: JSON.stringify({ success: true, snapshot: await browserDomSnapshot(args) }, null, 2) }] };
      } catch (error: any) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ success: false, error: redactSensitiveData(error.message || 'DOM snapshot failed.') }, null, 2) }]
        };
      }
    }
  );
}
