// Local-only launcher: no OAuth, no public resource metadata, loopback MCP only.
process.env.MCP_LOCAL_MODE = "1";
process.env.MCP_NEXT_ENABLED = "0";
process.env.MCP_POWERSHELL_ENABLED = "1";
process.env.MCP_BRIDGE_REQUIRE_BEARER = "0";
// Use a separate loopback port by default so this can coexist with the public-tunnel runtime.
process.env.PORT ||= "3011";

await import("../dist/server.js");
