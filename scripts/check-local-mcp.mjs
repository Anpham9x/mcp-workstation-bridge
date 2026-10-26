const baseUrl = process.env.MCP_LOCAL_URL || "http://127.0.0.1:3011/mcp";
const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

async function request(body, sessionId) {
  const response = await fetch(baseUrl, {
    method: "POST",
    headers: sessionId ? { ...headers, "mcp-session-id": sessionId } : headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 400)}`);
  const match = text.match(/(?:^|\n)data: (\{.*\})/);
  return { response, data: match ? JSON.parse(match[1]) : null };
}

const init = await request({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-local-check", version: "1.0.0" } } });
const sessionId = init.response.headers.get("mcp-session-id");
if (!sessionId) throw new Error("Local MCP server did not return mcp-session-id.");
await request({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, sessionId);
const listed = await request({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sessionId);
const tools = (listed.data?.result?.tools || []).map((tool) => tool.name);
if (tools.length !== 50) throw new Error(`Local MCP compact catalog must contain 50 tools (got ${tools.length}).`);
for (const expected of ["run_powershell", "desktop_action", "browser_screenshot", "filesystem_manage", "agy_health"]) {
  if (!tools.includes(expected)) throw new Error(`Local MCP is missing ${expected}.`);
}
console.log(`Local MCP OK: ${tools.length} tools at ${baseUrl}`);
