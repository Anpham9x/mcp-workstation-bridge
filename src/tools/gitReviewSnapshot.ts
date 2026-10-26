import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getGitReviewSnapshot } from "../git/snapshot.js";

/**
 * Đăng ký công cụ git_review_snapshot với máy chủ MCP.
 * Công cụ này trả về trạng thái git ngắn gọn, danh sách các file thay đổi, và thống kê diff.
 */
export function registerGitReviewSnapshotTool(server: McpServer): void {
  server.registerTool(
    "git_review_snapshot",
    {
      description: "Get a concise git status, list of changed files, and diff statistics for a target repository",
      inputSchema: z.object({
        repoPath: z.string().describe("Absolute path to the target git repository"),
        writeScope: z.array(z.string()).optional().describe("Optional list of allowed write scope glob patterns"),
      }),
    },
    async ({ repoPath, writeScope }) => {
      try {
        const snapshot = await getGitReviewSnapshot(repoPath, writeScope);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  repoPath,
                  snapshot,
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
                  error: error.message || "An unexpected error occurred while generating the git snapshot."
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
