import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getGitFileDiff } from "../git/snapshot.js";
import { exportGitCheckpoint } from './gitCheckpoint.js';
import { redactSensitiveData } from '../security/index.js';

/**
 * Đăng ký công cụ git_file_diff với máy chủ MCP.
 * Trả về git diff giới hạn kích thước cho một tệp tin cụ thể.
 */
export function registerGitFileDiffTool(server: McpServer): void {
  server.registerTool(
    "git_file_diff",
    {
      description: "action=diff (default): bounded single-file diff. action=export_checkpoint: export up to 40 exact commit SHA/file pairs as byte-preserved artifacts plus SHA256 manifest under bridge-managed .mcp-artifacts/checkpoints; no checkout, reset, merge or source repo write. Use this typed adapter instead of asking the user to run PowerShell. No caller-selected output path; secret, ignored, binary and symlink blobs are denied.",
      annotations: { destructiveHint: false, openWorldHint: false },
      inputSchema: z.object({
        action: z.enum(['diff', 'export_checkpoint']).optional(),
        repoPath: z.string().describe("Absolute path to the target git repository"),
        filePath: z.string().optional().describe("Relative path required for action=diff"),
        entries: z.array(z.object({ commit: z.string().regex(/^[a-fA-F0-9]{40}$/), filePath: z.string().min(1).max(240) }).strict()).min(1).max(40).optional(),
        staged: z.boolean().optional().describe("Show diff for staged changes (git diff --cached)"),
        maxLines: z.number().min(1).max(2000).optional().describe("Maximum number of diff lines to return (default 500, min 1, max 2000)"),
      }).strict(),
    },
    async ({ action, repoPath, filePath, entries, staged, maxLines }) => {
      try {
        if (action === 'export_checkpoint') {
          const result = await exportGitCheckpoint(repoPath, entries ?? []);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        if (!filePath) throw new Error('FILE_PATH_REQUIRED');
        const result = await getGitFileDiff(repoPath, filePath, { staged, maxLines });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  repoPath,
                  filePath,
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
                  error: redactSensitiveData(error.message || "An unexpected error occurred while running git file diff.")
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
