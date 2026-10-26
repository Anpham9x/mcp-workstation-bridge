import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveAndValidatePath } from "../security/index.js";
import { withDesktopControlIndicator } from "./desktopControlIndicator.js";
import { isCdpUnavailableError, navigateExistingChromeWithWindowsUi } from "./windowsChromeUi.js";

const execFilePromise = promisify(execFile);

const DEFAULT_CDP_HOST = "127.0.0.1";
const DEFAULT_CDP_PORT = 9222;
const BROWSER_START_TIMEOUT_MS = 10000;
const CDP_COMMAND_TIMEOUT_MS = 10000;
const KEY_CODES: Record<string, { code: string; windowsVirtualKeyCode: number }> = {
  Enter: { code: "Enter", windowsVirtualKeyCode: 13 },
  Escape: { code: "Escape", windowsVirtualKeyCode: 27 },
  Tab: { code: "Tab", windowsVirtualKeyCode: 9 },
  Backspace: { code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { code: "Delete", windowsVirtualKeyCode: 46 },
  ArrowUp: { code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39 },
};

type JsonRecord = Record<string, unknown>;

interface ChromeTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

interface CdpResponse {
  id?: number;
  result?: JsonRecord;
  error?: { message?: string; data?: string };
}

function artifactDirectory(): string {
  return path.resolve(process.env.DESKTOP_CONTROL_ARTIFACT_DIR || path.join(process.cwd(), ".mcp-artifacts"));
}

function cdpPort(): number {
  const parsed = Number.parseInt(process.env.DESKTOP_CONTROL_CDP_PORT || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_CDP_PORT;
}

function cdpBaseUrl(): string {
  return `http://${DEFAULT_CDP_HOST}:${cdpPort()}`;
}

function keyModifierMask(modifiers: string[] = []): number {
  const normalized = new Set(modifiers.map((modifier) => modifier.toLowerCase()));
  return (normalized.has("alt") ? 1 : 0)
    + (normalized.has("ctrl") || normalized.has("control") ? 2 : 0)
    + (normalized.has("meta") || normalized.has("cmd") ? 4 : 0)
    + (normalized.has("shift") ? 8 : 0);
}

function resolveKey(key: string): { key: string; code: string; windowsVirtualKeyCode: number } {
  if (KEY_CODES[key]) {
    return { key, ...KEY_CODES[key] };
  }

  if (/^[a-zA-Z0-9]$/.test(key)) {
    const upper = key.toUpperCase();
    return {
      key,
      code: /^[a-zA-Z]$/.test(key) ? `Key${upper}` : `Digit${key}`,
      windowsVirtualKeyCode: upper.charCodeAt(0),
    };
  }

  throw new Error(`Unsupported key '${key}'.`);
}

async function writeBase64Artifact(prefix: string, base64: string): Promise<string> {
  const dir = artifactDirectory();
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.png`);
  await fs.writeFile(filePath, Buffer.from(base64, "base64"));
  return filePath;
}

function validateBrowserUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL.");
  }

  if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "about:") {
    return parsed.toString();
  }

  if (parsed.protocol === "file:") {
    resolveAndValidatePath(fileURLToPath(parsed));
    return parsed.toString();
  }

  throw new Error(`Unsupported URL protocol '${parsed.protocol}'.`);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from Chrome DevTools endpoint.`);
  }
  return (await response.json()) as T;
}

async function chromeIsReady(): Promise<boolean> {
  try {
    await fetchJson<JsonRecord>(`${cdpBaseUrl()}/json/version`);
    return true;
  } catch {
    return false;
  }
}

function findChromeExecutable(): string {
  if (process.env.CHROME_PATH) {
    return process.env.CHROME_PATH;
  }

  if (process.platform === "win32") {
    const candidates = [
      path.join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env.PROGRAMFILES || "", "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    ];
    const found = candidates.find((candidate) => candidate && requireExists(candidate));
    if (found) return found;
  }

  return process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome";
}

function requireExists(candidate: string): boolean {
  return Boolean(candidate) && existsSync(candidate);
}

async function ensureChrome(): Promise<void> {
  if (await chromeIsReady()) return;

  // Reuse the visible Chrome session by default. A second managed Chrome profile
  // is opt-in only because it has a different window and login state.
  if (process.env.DESKTOP_CONTROL_ALLOW_MANAGED_BROWSER !== "1") {
    throw new Error(`Chrome DevTools endpoint is unavailable at ${cdpBaseUrl()}. Managed browser launch is disabled by default.`);
  }

  const userDataDir = path.join(os.tmpdir(), "mcp-antigravity-bridge-chrome-profile");
  await fs.mkdir(userDataDir, { recursive: true });
  const chrome = findChromeExecutable();

  const child = spawn(chrome, [
    `--remote-debugging-address=${DEFAULT_CDP_HOST}`,
    `--remote-debugging-port=${cdpPort()}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  const startedAt = Date.now();
  while (Date.now() - startedAt < BROWSER_START_TIMEOUT_MS) {
    if (await chromeIsReady()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error("Chrome DevTools endpoint did not become ready in time.");
}

async function listTargets(): Promise<ChromeTarget[]> {
  await ensureChrome();
  return fetchJson<ChromeTarget[]>(`${cdpBaseUrl()}/json/list`);
}

async function createTargetWithoutIndicator(url: string): Promise<ChromeTarget> {
  await ensureChrome();
  const encodedUrl = encodeURIComponent(validateBrowserUrl(url));
  return fetchJson<ChromeTarget>(`${cdpBaseUrl()}/json/new?${encodedUrl}`, { method: "PUT" });
}

function createTarget(url: string): Promise<ChromeTarget> {
  return withDesktopControlIndicator(() => createTargetWithoutIndicator(url));
}

async function getTarget(tabId?: string): Promise<ChromeTarget> {
  const targets = (await listTargets()).filter((target) => target.type === "page");
  const target = tabId ? targets.find((candidate) => candidate.id === tabId) : targets[0];
  if (target?.webSocketDebuggerUrl) {
    return target;
  }
  return createTarget("about:blank");
}

class CdpClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: JsonRecord) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }>();

  private constructor(private readonly socket: WebSocket) {}

  static async connect(webSocketUrl: string): Promise<CdpClient> {
    const socket = new WebSocket(webSocketUrl);
    const client = new CdpClient(socket);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out connecting to Chrome DevTools websocket.")), CDP_COMMAND_TIMEOUT_MS);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("Chrome DevTools websocket connection failed."));
      }, { once: true });
    });

    socket.addEventListener("message", (event) => client.handleMessage(String(event.data)));
    socket.addEventListener("close", () => client.rejectAll(new Error("Chrome DevTools websocket closed.")));
    socket.addEventListener("error", () => client.rejectAll(new Error("Chrome DevTools websocket errored.")));

    return client;
  }

  send(method: string, params: JsonRecord = {}): Promise<JsonRecord> {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, CDP_COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(payload);
    });
  }

  close(): void {
    this.socket.close();
  }

  private handleMessage(message: string): void {
    let parsed: CdpResponse;
    try {
      parsed = JSON.parse(message) as CdpResponse;
    } catch {
      return;
    }

    if (!parsed.id) return;
    const pending = this.pending.get(parsed.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(parsed.id);
    if (parsed.error) {
      pending.reject(new Error(parsed.error.message || parsed.error.data || "Chrome DevTools command failed."));
      return;
    }
    pending.resolve(parsed.result || {});
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}

async function withCdpWithoutIndicator<T>(tabId: string | undefined, callback: (client: CdpClient, target: ChromeTarget) => Promise<T>): Promise<T> {
  const target = await getTarget(tabId);
  if (!target.webSocketDebuggerUrl) {
    throw new Error("Target has no DevTools websocket URL.");
  }

  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  try {
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    return await callback(client, target);
  } finally {
    client.close();
  }
}

function withCdp<T>(tabId: string | undefined, callback: (client: CdpClient, target: ChromeTarget) => Promise<T>): Promise<T> {
  return withDesktopControlIndicator(() => withCdpWithoutIndicator(tabId, callback));
}

async function captureWindowsScreenWithoutIndicator(): Promise<string> {
  if (process.platform !== "win32") {
    throw new Error("desktop_capture_screen currently supports Windows only.");
  }

  const dir = artifactDirectory();
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `screen-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.png`);
  const escapedPath = filePath.replace(/'/g, "''");
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen",
    "$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height",
    "$graphics = [System.Drawing.Graphics]::FromImage($bitmap)",
    "$graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)",
    `$bitmap.Save('${escapedPath}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    "$graphics.Dispose()",
    "$bitmap.Dispose()",
  ].join("; ");

  await execFilePromise("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ], {
    timeout: 15000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });

  return filePath;
}

export function captureWindowsScreen(): Promise<string> {
  return withDesktopControlIndicator(captureWindowsScreenWithoutIndicator);
}

export function registerDesktopControlTools(server: McpServer, options: { includeLegacyAliases?: boolean; includeDirectBrowserInput?: boolean; includeOpenBrowser?: boolean } = {}): void {
  server.registerTool(
    "screen_capture",
    {
      description: "Capture the current Windows desktop/virtual screen as a PNG artifact.",
      inputSchema: z.object({}),
    },
    async () => {
      const filePath = await captureWindowsScreen();
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, filePath }, null, 2) }],
      };
    }
  );

  server.registerTool(
    "open_url",
    {
      description: "Open or navigate Chrome. Uses DevTools when available and otherwise falls back to the visible Chrome window in the current Windows session.",
      inputSchema: z.object({
        url: z.string().describe("URL to open. Supports http, https, about, and safe file URLs."),
        newTab: z.boolean().optional().default(true),
        tabId: z.string().optional(),
      }),
    },
    async ({ url, newTab, tabId }) => {
      const safeUrl = validateBrowserUrl(url);
      try {
        const target = newTab ? await createTarget(safeUrl) : await getTarget(tabId);
        const result = await withCdp(target.id, async (client) => {
          await client.send("Page.navigate", { url: safeUrl });
          return { ok: true, mode: "cdp", tabId: target.id, url: safeUrl };
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        if (tabId || !isCdpUnavailableError(error)) throw error;
        const result = await withDesktopControlIndicator(() => navigateExistingChromeWithWindowsUi(safeUrl, newTab));
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
    }
  );

  if (options.includeOpenBrowser !== false) server.registerTool(
    "open_browser",
    {
      description: "Open a local Chrome/Edge browser tab. Optionally navigate it to a URL.",
      inputSchema: z.object({
        url: z.string().optional().default("about:blank"),
      }),
    },
    async ({ url }) => {
      const safeUrl = validateBrowserUrl(url);
      try {
        const target = await createTarget(safeUrl);
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, mode: "cdp", tabId: target.id, url: safeUrl }, null, 2) }] };
      } catch (error) {
        if (!isCdpUnavailableError(error)) throw error;
        const result = await withDesktopControlIndicator(() => navigateExistingChromeWithWindowsUi(safeUrl, true));
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
    }
  );

  if (options.includeDirectBrowserInput !== false) server.registerTool(
    "browser_click",
    {
      description: "Click a coordinate in the active browser viewport.",
      inputSchema: z.object({
        x: z.number().min(0),
        y: z.number().min(0),
        tabId: z.string().optional(),
      }),
    },
    async ({ x, y, tabId }) => {
      const result = await withCdp(tabId, async (client, target) => {
        await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
        await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
        return { ok: true, tabId: target.id, x, y };
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  if (options.includeDirectBrowserInput !== false) server.registerTool(
    "browser_type",
    {
      description: "Insert text into the focused field in the browser.",
      inputSchema: z.object({
        text: z.string().max(4000),
        tabId: z.string().optional(),
      }),
    },
    async ({ text, tabId }) => {
      const result = await withCdp(tabId, async (client, target) => {
        await client.send("Input.insertText", { text });
        return { ok: true, tabId: target.id, insertedChars: text.length };
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  if (options.includeDirectBrowserInput !== false) server.registerTool(
    "browser_press_key",
    {
      description: "Press a browser key, optionally with Ctrl/Alt/Shift/Meta modifiers.",
      inputSchema: z.object({
        key: z.string(),
        modifiers: z.array(z.enum(["Alt", "Ctrl", "Control", "Meta", "Cmd", "Shift"])).optional().default([]),
        tabId: z.string().optional(),
      }),
    },
    async ({ key, modifiers, tabId }) => {
      const result = await withCdp(tabId, async (client, target) => {
        const resolved = resolveKey(key);
        const modifierMask = keyModifierMask(modifiers);
        const params = {
          key: resolved.key,
          code: resolved.code,
          windowsVirtualKeyCode: resolved.windowsVirtualKeyCode,
          nativeVirtualKeyCode: resolved.windowsVirtualKeyCode,
          modifiers: modifierMask,
        };
        await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...params });
        await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
        return { ok: true, tabId: target.id, key, modifiers };
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.registerTool(
    "browser_evaluate",
    {
      description: "Evaluate a small JavaScript expression in the browser page.",
      inputSchema: z.object({
        expression: z.string().max(4000),
        tabId: z.string().optional(),
      }),
    },
    async ({ expression, tabId }) => {
      const result = await withCdp(tabId, async (client, target) => {
        const response = await client.send("Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise: true,
        });
        return { ok: true, tabId: target.id, result: response.result };
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.registerTool(
    "browser_screenshot",
    {
      description: "Capture the current browser page as a PNG artifact and embedded MCP image.",
      inputSchema: z.object({
        tabId: z.string().optional(),
        fullPage: z.boolean().optional().default(false),
      }),
    },
    async ({ tabId, fullPage }) => {
      try {
        const result = await withCdp(tabId, async (client, target) => {
          const response = await client.send("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: fullPage,
            fromSurface: true,
          });
          const data = String(response.data || "");
          const filePath = await writeBase64Artifact("browser", data);
          return { tabId: target.id, url: target.url, data, filePath };
        });

        return {
          content: [
            { type: "text", text: JSON.stringify({ ok: true, mode: "cdp", tabId: result.tabId, url: result.url, filePath: result.filePath }, null, 2) },
            { type: "image", data: result.data, mimeType: "image/png" },
          ],
        };
      } catch (error) {
        if (tabId || !isCdpUnavailableError(error)) throw error;
        const filePath = await captureWindowsScreen();
        const data = (await fs.readFile(filePath)).toString("base64");
        return {
          content: [
            { type: "text", text: JSON.stringify({ ok: true, mode: "desktop-fallback", fullPage: false, filePath }, null, 2) },
            { type: "image", data, mimeType: "image/png" },
          ],
        };
      }
    }
  );

  if (options.includeLegacyAliases === false) {
    return;
  }

  server.registerTool(
    "desktop_capture_screen",
    {
      description: "Alias of screen_capture. Capture the current Windows desktop/virtual screen as a PNG artifact for visual review.",
      inputSchema: z.object({}),
    },
    async () => {
      const filePath = await captureWindowsScreen();
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, filePath }, null, 2) }],
      };
    }
  );

  server.registerTool(
    "desktop_browser_navigate",
    {
      description: "Alias of open_url. Open or navigate a local Chrome/Edge DevTools tab to a URL.",
      inputSchema: z.object({
        url: z.string().describe("URL to open. Supports http, https, about, and safe file URLs."),
        newTab: z.boolean().optional().default(false).describe("Create a fresh browser tab instead of reusing the first page tab."),
        tabId: z.string().optional().describe("Existing DevTools target id to reuse."),
      }),
    },
    async ({ url, newTab, tabId }) => {
      const safeUrl = validateBrowserUrl(url);
      try {
        const target = newTab ? await createTarget(safeUrl) : await getTarget(tabId);
        const result = await withCdp(target.id, async (client) => {
          await client.send("Page.navigate", { url: safeUrl });
          return { ok: true, mode: "cdp", tabId: target.id, url: safeUrl };
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        if (tabId || !isCdpUnavailableError(error)) throw error;
        const result = await withDesktopControlIndicator(() => navigateExistingChromeWithWindowsUi(safeUrl, newTab));
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
    }
  );

  server.registerTool(
    "desktop_browser_click",
    {
      description: "Alias of desktop_browser_click. Click a coordinate in the active browser viewport.",
      inputSchema: z.object({
        x: z.number().min(0),
        y: z.number().min(0),
        tabId: z.string().optional(),
      }),
    },
    async ({ x, y, tabId }) => {
      const result = await withCdp(tabId, async (client, target) => {
        await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
        await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
        return { ok: true, tabId: target.id, x, y };
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.registerTool(
    "desktop_browser_type",
    {
      description: "Alias of desktop_browser_type. Insert text into the focused field in the browser.",
      inputSchema: z.object({
        text: z.string().max(4000),
        tabId: z.string().optional(),
      }),
    },
    async ({ text, tabId }) => {
      const result = await withCdp(tabId, async (client, target) => {
        await client.send("Input.insertText", { text });
        return { ok: true, tabId: target.id, insertedChars: text.length };
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.registerTool(
    "desktop_browser_press_key",
    {
      description: "Alias of desktop_browser_press_key. Press a browser key, optionally with Ctrl/Alt/Shift/Meta modifiers.",
      inputSchema: z.object({
        key: z.string(),
        modifiers: z.array(z.enum(["Alt", "Ctrl", "Control", "Meta", "Cmd", "Shift"])).optional().default([]),
        tabId: z.string().optional(),
      }),
    },
    async ({ key, modifiers, tabId }) => {
      const result = await withCdp(tabId, async (client, target) => {
        const resolved = resolveKey(key);
        const modifierMask = keyModifierMask(modifiers);
        const params = {
          key: resolved.key,
          code: resolved.code,
          windowsVirtualKeyCode: resolved.windowsVirtualKeyCode,
          nativeVirtualKeyCode: resolved.windowsVirtualKeyCode,
          modifiers: modifierMask,
        };
        await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...params });
        await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
        return { ok: true, tabId: target.id, key, modifiers };
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.registerTool(
    "desktop_browser_evaluate",
    {
      description: "Alias of desktop_browser_evaluate. Evaluate a small JavaScript expression in the browser page.",
      inputSchema: z.object({
        expression: z.string().max(4000),
        tabId: z.string().optional(),
      }),
    },
    async ({ expression, tabId }) => {
      const result = await withCdp(tabId, async (client, target) => {
        const response = await client.send("Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise: true,
        });
        return { ok: true, tabId: target.id, result: response.result };
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.registerTool(
    "desktop_browser_screenshot",
    {
      description: "Alias of desktop_browser_screenshot. Capture the current browser page as a PNG artifact and embedded MCP image.",
      inputSchema: z.object({
        tabId: z.string().optional(),
        fullPage: z.boolean().optional().default(false),
      }),
    },
    async ({ tabId, fullPage }) => {
      try {
        const result = await withCdp(tabId, async (client, target) => {
          const response = await client.send("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: fullPage,
            fromSurface: true,
          });
          const data = String(response.data || "");
          const filePath = await writeBase64Artifact("browser", data);
          return { tabId: target.id, url: target.url, data, filePath };
        });
        return {
          content: [
            { type: "text", text: JSON.stringify({ ok: true, mode: "cdp", tabId: result.tabId, url: result.url, filePath: result.filePath }, null, 2) },
            { type: "image", data: result.data, mimeType: "image/png" },
          ],
        };
      } catch (error) {
        if (tabId || !isCdpUnavailableError(error)) throw error;
        const filePath = await captureWindowsScreen();
        const data = (await fs.readFile(filePath)).toString("base64");
        return {
          content: [
            { type: "text", text: JSON.stringify({ ok: true, mode: "desktop-fallback", fullPage: false, filePath }, null, 2) },
            { type: "image", data, mimeType: "image/png" },
          ],
        };
      }
    }
  );
}
