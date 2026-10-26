import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getAntigravityJobResult,
  tailAntigravityJobLog,
  waitForJobCompletion,
  cancelAntigravityJob,
  isAntigravityJobStale,
  getAntigravityLastError
} from "../runner/task.js";
import { redactSensitiveData } from "../security/index.js";

/**
 * Registers the agy_get_result tool with the MCP server.
 * This tool retrieves job metadata (status, model, workspacePath, createdAt, completedAt, exitCode, error, logPath)
 * and recent log evidence for a specific jobId.
 */
export function registerGetResultTool(server: McpServer): void {
  server.registerTool(
    "agy_get_result",
    {
      description: "Get metadata, completion state, exit status, and recent log evidence for an Antigravity job",
      inputSchema: z.object({
        jobId: z.string().describe("The UUID of the job to inspect"),
        tailLines: z.number()
          .min(1)
          .max(500)
          .optional()
          .describe("Number of recent log lines to include as evidence (1 to 500, default is 50)"),
      }),
    },
    async ({ jobId, tailLines }) => {
      try {
        const result = await getAntigravityJobResult(jobId, tailLines);
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  job: result.job,
                  logTail: result.logTail,
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
                  error: redactSensitiveData(error.message || "An unexpected error occurred while fetching the job result.")
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

/**
 * Registers the agy_tail_log tool with the MCP server.
 * This tool retrieves the tail of the log file and basic metadata by jobId.
 */
export function registerTailLogTool(server: McpServer): void {
  server.registerTool(
    "agy_tail_log",
    {
      description: "Get the latest stdout/stderr tail and status of an Antigravity job",
      inputSchema: z.object({
        jobId: z.string().describe("The UUID of the job to inspect"),
        lines: z.number()
          .min(1)
          .max(1000)
          .optional()
          .describe("Number of tail lines to retrieve (1 to 1000, default is 100)"),
      }),
    },
    async ({ jobId, lines }) => {
      try {
        const result = await tailAntigravityJobLog(jobId, lines);
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  jobId: result.jobId,
                  status: result.status,
                  logPath: result.logPath,
                  logTail: result.logTail,
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
                  error: redactSensitiveData(error.message || "An unexpected error occurred while tailing the job log.")
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

/**
 * Registers the agy_wait_for_completion tool with the MCP server.
 */
export function registerWaitForCompletionTool(server: McpServer): void {
  server.registerTool(
    "agy_wait_for_completion",
    {
      description: "Wait for an Antigravity job to complete, return detailed job summary",
      inputSchema: z.object({
        jobId: z.string().describe("The UUID of the job to wait for"),
        timeoutMs: z.number()
          .min(1000)
          .max(120000)
          .optional()
          .describe("Max wait time in milliseconds (1000 to 120000, default is 30000)"),
        pollIntervalMs: z.number()
          .min(500)
          .max(10000)
          .optional()
          .describe("Polling interval in milliseconds (500 to 10000, default is 1000)"),
      }),
    },
    async ({ jobId, timeoutMs, pollIntervalMs }) => {
      try {
        const result = await waitForJobCompletion(jobId, timeoutMs, pollIntervalMs);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  job: result.job,
                  waitStatus: result.waitStatus,
                  timedOut: result.timedOut,
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
                  error: redactSensitiveData(error.message || "An unexpected error occurred while waiting for job completion.")
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

/**
 * Registers the agy_cancel_job tool with the MCP server.
 */
export function registerCancelJobTool(server: McpServer): void {
  server.registerTool(
    "agy_cancel_job",
    {
      description: "Cancel a running Antigravity job process",
      inputSchema: z.object({
        jobId: z.string().describe("The UUID of the job to cancel"),
      }),
    },
    async ({ jobId }) => {
      try {
        const jobSummary = await cancelAntigravityJob(jobId);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  job: jobSummary,
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
                  error: redactSensitiveData(error.message || "An unexpected error occurred while cancelling the job.")
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

/**
 * Registers the agy_is_stale tool with the MCP server.
 */
export function registerIsStaleTool(server: McpServer): void {
  server.registerTool(
    "agy_is_stale",
    {
      description: "Check if an Antigravity job is stale (inactive or process missing)",
      inputSchema: z.object({
        jobId: z.string().describe("The UUID of the job to check"),
        staleAfterMs: z.number()
          .min(1000)
          .optional()
          .describe("Stale threshold in milliseconds"),
      }),
    },
    async ({ jobId, staleAfterMs }) => {
      try {
        const isStale = await isAntigravityJobStale(jobId, staleAfterMs);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  jobId,
                  stale: isStale,
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
                  error: redactSensitiveData(error.message || "An unexpected error occurred while checking if the job is stale.")
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

/**
 * Registers the agy_get_last_error tool with the MCP server.
 */
export function registerGetLastErrorTool(server: McpServer): void {
  server.registerTool(
    "agy_get_last_error",
    {
      description: "Get the last error message of a specific job, or the most recent failed job if no ID is specified",
      inputSchema: z.object({
        jobId: z.string().optional().describe("Optional UUID of the job to get the last error for"),
      }),
    },
    async ({ jobId }) => {
      try {
        const result = getAntigravityLastError(jobId);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  ...result
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
                  error: redactSensitiveData(error.message || "An unexpected error occurred while retrieving the last error.")
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
