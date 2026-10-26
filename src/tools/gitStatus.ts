import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getGitStatusExtended } from "../git/snapshot.js";

/**
 * Đăng ký công cụ git_status với máy chủ MCP.
 * Trả về git status --short, danh sách changedFiles và clean boolean.
 */
export function registerGitStatusTool(server: McpServer): void {
  server.registerTool(
    "git_status",
    {
      description: "Get a concise git status, list of changed files, and clean status for a target repository",
      inputSchema: z.object({
        repoPath: z.string().describe("Absolute path to the target git repository"),
      }),
    },
    async ({ repoPath }) => {
      try {
        const result = await getGitStatusExtended(repoPath);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  repoPath,
                  ...result,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error: any) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  error: error.message || "An unexpected error occurred while running git status."
                },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );
}
