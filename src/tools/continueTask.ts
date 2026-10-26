import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveAndValidatePath } from "../security/index.js";
import { continueAntigravityTask } from "../runner/task.js";

/**
 * Registers the agy_continue_task tool with the MCP server.
 * This tool continues an existing Antigravity print run session (refactor loop).
 */
export function registerContinueTaskTool(server: McpServer): void {
  server.registerTool(
    "agy_continue_task",
    {
      description: "Continue an existing Antigravity task session for refactor/review loops",
      inputSchema: z.object({
        jobId: z.string().describe("The ID of the existing job to continue"),
        prompt: z.string().describe("The follow-up prompt or instruction for the refactor loop"),
        workspacePath: z.string().optional().describe("Absolute path to the workspace directory (defaults to the workspace of the original job)"),
        model: z.enum(["Gemini 3.5 Flash (Medium)", "Gemini 3.1 Pro High"])
          .optional()
          .describe("Model for the current CLI session (defaults to the model of the original job)"),
        timeout: z.number()
          .min(1)
          .max(900)
          .optional()
          .describe("Execution timeout in seconds (1 to 300, default is the timeout of the original job)"),
      }),
    },
    async ({ jobId, prompt, workspacePath, model, timeout }) => {
      try {
        // Validate workspace path strictly against security policies if provided
        const validatedWorkspacePath = workspacePath ? resolveAndValidatePath(workspacePath) : undefined;

        // Continue the Antigravity task process asynchronously
        const job = await continueAntigravityTask({
          jobId,
          prompt,
          workspacePath: validatedWorkspacePath,
          model,
          timeout,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  jobId: job.id,
                  status: job.status,
                  model: job.model,
                  timeout: job.timeout,
                  logPath: job.logPath,
                  createdAt: job.createdAt,
                  message: `Job ${job.id} continued successfully under PID ${job.pid || 'unknown'}. stdout/stderr is being logged to ${job.logPath}.`
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
                  error: error.message || "An unexpected error occurred while continuing the task."
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
