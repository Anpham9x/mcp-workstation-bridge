import { createStableProfileId } from './tools/profile.js';
import { startupBuild } from './reliability/provenance.js';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { registerHealthTool } from "./tools/health.js";
import { instrumentMcpServerToolActivity } from "./tools/desktopControlIndicator.js";
import { assertSecureRuntimeConfiguration, isAuthorizedRequest, hasVerifiedBearer } from "./security/httpAuth.js";
import {
  assertNextOAuthConfiguration,
  authenticateNextRequest,
  getNextOAuthConfig,
  getOAuthChallenge,
  getProtectedResourceMetadata,
  getProtectedResourceMetadataPath,
  isNextPluginEnabled
} from "./security/oauth.js";

type EndpointMode = "legacy" | "next";

interface McpSession {
  mcpServer: McpServer;
  transport: StreamableHTTPServerTransport;
  endpointMode: EndpointMode;
  subject?: string;
  legacyBearerVerified: boolean;
  lastActivityAt: number;
}

const activeSessions = new Map<string, McpSession>();
const LEGACY_MCP_ENDPOINT_PATHS = new Set(["/", "/mcp", "/mcp-control", "/mcp-v2"]);
const NEXT_MCP_ENDPOINT_PATH = "/mcp-next";
const IDENTITY_PORT=readPositiveInteger("PORT",3001);
if(IDENTITY_PORT>65535)throw new Error("PORT out of range");
const RUNTIME_IDENTITY_PATH = path.join(process.cwd(), "logs", "autostart", IDENTITY_PORT===3001?"runtime-identity.json":"runtime-identity-"+IDENTITY_PORT+".json");

function readPositiveInteger(name: string, fallback: number): number {
  const rawValue = process.env[name];
  if (!rawValue) {
    return fallback;
  }

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

const MAX_ACTIVE_SESSIONS = readPositiveInteger("MCP_MAX_ACTIVE_SESSIONS", 128);
const SESSION_IDLE_TIMEOUT_MS = readPositiveInteger("MCP_SESSION_IDLE_TIMEOUT_MS", 30 * 60 * 1000);
const SESSION_SWEEP_INTERVAL_MS = readPositiveInteger("MCP_SESSION_SWEEP_INTERVAL_MS", 60 * 1000);

async function closeSession(sessionId: string, reason: string): Promise<void> {
  const session = activeSessions.get(sessionId);
  if (!session) {
    return;
  }

  // Delete first because transport.close() may invoke onsessionclosed synchronously.
  activeSessions.delete(sessionId);
  try {
    await session.transport.close();
  } catch (error) {
    console.error(`Error closing transport for session ${sessionId}:`, error);
  }
  try {
    await session.mcpServer.close();
  } catch (error) {
    console.error(`Error closing MCP server for session ${sessionId}:`, error);
  }
  console.log(`Session evicted (${reason}): ${sessionId}. Total active: ${activeSessions.size}`);
}

async function pruneExpiredSessions(now = Date.now()): Promise<void> {
  const expiredSessionIds = [...activeSessions.entries()]
    .filter(([, session]) => now - session.lastActivityAt >= SESSION_IDLE_TIMEOUT_MS)
    .map(([sessionId]) => sessionId);

  for (const sessionId of expiredSessionIds) {
    await closeSession(sessionId, "idle timeout");
  }
}

async function ensureSessionCapacity(): Promise<void> {
  await pruneExpiredSessions();
  while (activeSessions.size >= MAX_ACTIVE_SESSIONS) {
    const oldestSession = [...activeSessions.entries()]
      .sort((left, right) => left[1].lastActivityAt - right[1].lastActivityAt)[0];
    if (!oldestSession) {
      return;
    }
    await closeSession(oldestSession[0], "capacity limit");
  }
}

async function trimSessionsToLimit(): Promise<void> {
  while (activeSessions.size > MAX_ACTIVE_SESSIONS) {
    const oldestSession = [...activeSessions.entries()]
      .sort((left, right) => left[1].lastActivityAt - right[1].lastActivityAt)[0];
    if (!oldestSession) {
      return;
    }
    await closeSession(oldestSession[0], "capacity limit");
  }
}

const sessionSweepTimer = setInterval(() => {
  void pruneExpiredSessions().catch((error) => {
    console.error("Error pruning expired MCP sessions:", error);
  });
}, SESSION_SWEEP_INTERVAL_MS);
sessionSweepTimer.unref();

// Helper function to create, register tools, and connect a new session
async function createNewSession(endpointMode: EndpointMode, subject?: string, legacyBearerVerified=false): Promise<McpSession> {
  await ensureSessionCapacity();

  const mcpServer = new McpServer({
    name: endpointMode === "next" ? "mcp-workstation-power" : "mcp-antigravity-bridge",
    version: "0.1.0",
  });

  instrumentMcpServerToolActivity(mcpServer);

  // Register all tools automatically (health wiring)
  const localPowerShellEnabled = endpointMode === "legacy"
    && process.env.MCP_LOCAL_MODE === "1"
    && process.env.MCP_POWERSHELL_ENABLED === "1";

  // ChatGPT caps visible tools at 50. Both endpoints therefore use the same
  // compact Workstation Power core catalog; only authenticated/local opt-ins
  // add their guarded PowerShell and profile tools.
  registerHealthTool(mcpServer, {
    includePowerShell: endpointMode === "next" || localPowerShellEnabled,
    includeSafePowerShell: endpointMode === "legacy",
    powerShellTrustOAuthGate: endpointMode === "next",
    compactCatalog: true,
    profileSubject: endpointMode === "next" ? subject : undefined,
    reliabilityPolicyPath: process.env.MCP_RELIABILITY_POLICY_PATH,
    reliabilityStorePath: process.env.MCP_RELIABILITY_STORE_PATH,
    ownerPolicyPath: process.env.MCP_OWNER_ACCESS_POLICY_PATH,
    reliabilityPrincipal: subject ? "oauth:" + createStableProfileId(subject) : legacyBearerVerified ? "legacy-owner" : "legacy-unverified",
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      activeSessions.set(sessionId, { mcpServer, transport, endpointMode, subject, legacyBearerVerified, lastActivityAt: Date.now() });
      console.log(`Session initialized: ${sessionId}. Total active: ${activeSessions.size}`);
      void trimSessionsToLimit().catch((error) => {
        console.error("Error enforcing MCP session capacity:", error);
      });
    },
    onsessionclosed: (sessionId) => {
      const session = activeSessions.get(sessionId);
      activeSessions.delete(sessionId);
      if (session) {
        void session.mcpServer.close().catch((error) => {
          console.error(`Error closing MCP server for session ${sessionId}:`, error);
        });
      }
      console.log(`Session closed: ${sessionId}. Total active: ${activeSessions.size}`);
    }
  });

  await mcpServer.connect(transport);

  return { mcpServer, transport, endpointMode, subject, legacyBearerVerified, lastActivityAt: Date.now() };
}

// Setup Node.js HTTP Server to route to MCP transport
const PORT = IDENTITY_PORT;
const server = http.createServer(async (req, res) => {
  try {
    // Set CORS headers for local connections
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version, mcp-session-id");

    if (req.method === "OPTIONS") {
      res.statusCode = 200;
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);

    if (isNextPluginEnabled()) {
      const nextConfig = getNextOAuthConfig();
      if (parsedUrl.pathname === getProtectedResourceMetadataPath(nextConfig)) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "public, max-age=300");
        res.end(JSON.stringify(getProtectedResourceMetadata(nextConfig)));
        return;
      }
      if (parsedUrl.pathname === "/mcp-next/docs") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          name: "MCP Workstation Power",
          resource: nextConfig.resource,
          authentication: "OAuth 2.1",
          scopes: nextConfig.requiredScopes
        }));
        return;
      }
    }

    const endpointMode: EndpointMode | undefined = LEGACY_MCP_ENDPOINT_PATHS.has(parsedUrl.pathname)
      ? "legacy"
      : parsedUrl.pathname === NEXT_MCP_ENDPOINT_PATH && isNextPluginEnabled()
        ? "next"
        : undefined;

    if (!endpointMode) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32004, message: "Not Found: Invalid endpoint path" },
        id: null
      }));
      return;
    }

    let authenticatedSubject: string | undefined;
    if (endpointMode === "legacy" && !isAuthorizedRequest(req.headers.authorization)) {
      res.statusCode = 401;
      res.setHeader("WWW-Authenticate", 'Bearer realm="mcp-antigravity-bridge"');
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32003, message: "Unauthorized" },
        id: null
      }));
      return;
    }

    if (endpointMode === "next") {
      const nextConfig = getNextOAuthConfig();
      try {
        authenticatedSubject = (await authenticateNextRequest(req.headers, nextConfig)).subject;
      } catch (error) {
        const insufficientScope = /missing scopes/i.test(error instanceof Error ? error.message : "");
        res.statusCode = 401;
        res.setHeader("WWW-Authenticate", getOAuthChallenge(nextConfig, insufficientScope ? "insufficient_scope" : "invalid_token"));
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32003, message: "OAuth authorization required" },
          id: null
        }));
        return;
      }
    }

    if (parsedUrl.pathname !== "/") {
      parsedUrl.pathname = "/";
      req.url = parsedUrl.pathname + parsedUrl.search;
    }

    const sessionIdHeader = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

    if (sessionId) {
      const session = activeSessions.get(sessionId);
      if (!session || session.endpointMode !== endpointMode || session.subject !== authenticatedSubject || session.legacyBearerVerified !== (endpointMode === "legacy" && hasVerifiedBearer(req.headers.authorization))) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Session not found" },
          id: null
        }));
        return;
      }
      session.lastActivityAt = Date.now();
      await session.transport.handleRequest(req, res);
    } else {
      // No session ID provided
      if (req.method === "GET") {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: Mcp-Session-Id header is required"
          },
          id: null
        }));
        return;
      }

      // POST request without session ID is assumed to be an initialize request
      const tempSession = await createNewSession(endpointMode, authenticatedSubject, endpointMode === "legacy" && hasVerifiedBearer(req.headers.authorization));
      await tempSession.transport.handleRequest(req, res);
    }
  } catch (error) {
    console.error("Error handling request:", error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Internal Server Error" }));
    }
  }
});

async function writeRuntimeIdentity(): Promise<void> {
  await fs.mkdir(path.dirname(RUNTIME_IDENTITY_PATH), { recursive: true });
  await fs.writeFile(RUNTIME_IDENTITY_PATH, JSON.stringify({
    pid: process.pid,
    cwd: process.cwd(),
    port: PORT,
    startedAt: new Date().toISOString(),
  }, null, 2), "utf8");
}

async function clearRuntimeIdentity(): Promise<void> {
  try {
    const raw = await fs.readFile(RUNTIME_IDENTITY_PATH, "utf8");
    const current = JSON.parse(raw) as { pid?: number };
    if (current.pid === process.pid) await fs.rm(RUNTIME_IDENTITY_PATH, { force: true });
  } catch {}
}

async function start(): Promise<void> {
  if (import.meta.url.includes("/dist/") && !startupBuild.verified) throw new Error("UNVERIFIED_BUILD_PROVENANCE");
  assertSecureRuntimeConfiguration();
  assertNextOAuthConfiguration();
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`MCP Antigravity Bridge server running on 127.0.0.1:${PORT}`);
    void writeRuntimeIdentity().catch((error) => {
      console.error("Failed to write runtime identity:", error);
    });
  });
}

// Handle shutdown events cleanly
let shutdownStarted = false;

function shutdown(exitCode = 0): void {
  if (shutdownStarted) {
    return;
  }
  shutdownStarted = true;
  clearInterval(sessionSweepTimer);
  console.log("Shutting down MCP server...");
  server.close();
  const forcedExitTimer = setTimeout(() => process.exit(exitCode), 10_000);
  forcedExitTimer.unref();
  void (async () => {
    try {
      for (const sessionId of [...activeSessions.keys()]) {
        await closeSession(sessionId, "server shutdown");
      }
    } catch (e) {
      console.error("Error during close:", e);
    } finally {
      clearTimeout(forcedExitTimer);
      await clearRuntimeIdentity();
      process.exit(exitCode);
    }
  })();
}


process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  shutdown(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  shutdown(1);
});

start().catch((error) => {
  console.error("Fatal server start error:", error);
  process.exit(1);
});
