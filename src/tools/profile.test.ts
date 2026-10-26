import assert from "node:assert/strict";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createStableProfileId, registerProfileTool } from "./profile.js";

async function main(): Promise<void> {
  assert.equal(createStableProfileId("auth0|user-123"), createStableProfileId("auth0|user-123"));
  assert.notEqual(createStableProfileId("auth0|user-123"), createStableProfileId("auth0|user-456"));
  assert.match(createStableProfileId("auth0|user-123"), /^prf_[a-f0-9]{64}$/);
  assert.throws(() => createStableProfileId("   "), /must not be empty/i);

  let registeredName = "";
  let registeredConfig: Record<string, unknown> | undefined;
  let registeredCallback: (() => Promise<Record<string, unknown>>) | undefined;
  const fakeServer = {
    registerTool(name: string, config: Record<string, unknown>, callback: () => Promise<Record<string, unknown>>) {
      registeredName = name;
      registeredConfig = config;
      registeredCallback = callback;
    },
  } as unknown as McpServer;

  registerProfileTool(fakeServer, "auth0|user-123");

  assert.equal(registeredName, "get_profile");
  assert.deepEqual((registeredConfig?._meta as Record<string, unknown>)["openai/profile"], true);
  assert.deepEqual(registeredConfig?.securitySchemes, [{ type: "oauth2", scopes: ["mcp:access"] }]);
  assert.ok(registeredConfig?.outputSchema);

  const result = await registeredCallback?.();
  assert.ok(result);
  assert.equal(result?.isError, false);
  assert.deepEqual(result?.structuredContent, {
    id: createStableProfileId("auth0|user-123"),
  });
  assert.equal(
    (result?.content as Array<{ type: string; text: string }>)[0].text,
    JSON.stringify(result?.structuredContent)
  );

  console.log("profile tool tests passed");
}

void main();
