import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveAndValidatePath } from "../security/index.js";
import { startAntigravityTask } from "../runner/task.js";

/**
 * Registers the agy_start_task tool with the MCP server.
 * This tool starts a fresh Antigravity print run session with model and timeout configurations.
 */
export function registerStartTaskTool(server: McpServer): void {
  server.registerTool(
    "agy_start_task",
    {
      description: "Start a fresh Antigravity print run session with model and timeout configurations",
      inputSchema: z.object({
        workspacePath: z.string().describe("Absolute path to the workspace directory"),
        prompt: z.string().describe("The instruction or prompt to execute"),
        model: z.enum(["Gemini 3.5 Flash (Medium)", "Gemini 3.1 Pro High"])
          .optional()
          .describe("Model for the current CLI session"),
        timeout: z.number()
          .min(1)
          .max(900)
          .optional()
          .describe("Execution timeout in seconds (1 to 300, default is 60)"),
      }),
    },
    async ({ workspacePath, prompt, model, timeout }) => {
      try {
        // Validate workspace path strictly against security policies
        const validatedWorkspacePath = resolveAndValidatePath(workspacePath);

        // Start the Antigravity task process asynchronously
        const job = await startAntigravityTask({
          model,
          prompt,
          timeout,
          workspacePath: validatedWorkspacePath,
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
                  message: `Job ${job.id} started successfully under PID ${job.pid || 'unknown'}. stdout/stderr is being logged to ${job.logPath}.`
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
                  error: error.message || "An unexpected error occurred while starting the task."
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
