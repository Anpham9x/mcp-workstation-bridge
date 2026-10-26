import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getGitDiff } from "../git/snapshot.js";

/**
 * Đăng ký công cụ git_diff với máy chủ MCP.
 * Trả về git diff chi tiết và diff stat giới hạn kích thước output.
 */
export function registerGitDiffTool(server: McpServer): void {
  server.registerTool(
    "git_diff",
    {
      description: "Get a bounded git diff and diff statistics for a target repository",
      inputSchema: z.object({
        repoPath: z.string().describe("Absolute path to the target git repository"),
        staged: z.boolean().optional().describe("Show diff for staged changes (git diff --cached)"),
        maxLines: z.number().min(1).max(2000).optional().describe("Maximum number of diff lines to return (default 500, min 1, max 2000)"),
      }),
    },
    async ({ repoPath, staged, maxLines }) => {
      try {
        const result = await getGitDiff(repoPath, { staged, maxLines });

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
                  error: error.message || "An unexpected error occurred while running git diff."
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
