import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const PROFILE_NAMESPACE = "mcp-workstation-power";

export function createStableProfileId(subject: string): string {
  const normalizedSubject = subject.trim();
  if (!normalizedSubject) {
    throw new Error("Authenticated profile subject must not be empty.");
  }

  const digest = createHash("sha256")
    .update(`${PROFILE_NAMESPACE}\0${normalizedSubject}`, "utf8")
    .digest("hex");
  return `prf_${digest}`;
}

export function registerProfileTool(server: McpServer, subject: string): void {
  const profile = { id: createStableProfileId(subject) };

  server.registerTool(
    "get_profile",
    {
      title: "Get authenticated profile",
      description:
        "Return the stable opaque profile represented by this request's authenticated OAuth credentials.",
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({
        id: z.string().min(1).regex(/\S/),
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      securitySchemes: [{ type: "oauth2", scopes: ["mcp:access"] }],
      _meta: {
        "openai/profile": true,
        securitySchemes: [{ type: "oauth2", scopes: ["mcp:access"] }],
      },
    } as any,
    async () => ({
      content: [{ type: "text", text: JSON.stringify(profile) }],
      structuredContent: profile,
      isError: false,
    })
  );
}

/**
 * The bundled MCP SDK version predates top-level `securitySchemes` in
 * registerTool() and drops unknown descriptor fields. Re-expose the field in
 * tools/list while retaining `_meta.securitySchemes` for older clients.
 */
export function exposeTopLevelSecuritySchemes(
  server: McpServer,
  schemes: Record<string, Array<Record<string, unknown>>>
): void {
  const protocol = (server as any).server;
  const handlers = protocol?._requestHandlers as Map<string, Function> | undefined;
  const previousHandler = handlers?.get("tools/list");
  if (!protocol || typeof previousHandler !== "function") {
    throw new Error("MCP tools/list handler is not initialized.");
  }

  protocol.removeRequestHandler("tools/list");
  protocol.setRequestHandler(ListToolsRequestSchema, async (request: unknown, extra: unknown) => {
    const result = await previousHandler(request, extra);
    return {
      ...result,
      tools: result.tools.map((tool: any) =>
        schemes[tool.name] ? { ...tool, securitySchemes: schemes[tool.name] } : tool
      ),
    };
  });
}
