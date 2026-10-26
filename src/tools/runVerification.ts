import { getToolContext, runRepositoryPreflight } from "../reliability/policy.js";
import { hasOwnerAccess } from '../security/ownerAccess.js';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { redactSensitiveData, resolveAndValidatePath, resolveCommandForProject } from "../security/index.js";

const execFilePromise = promisify(execFile);

// Bounds execution time and buffer size for verification commands
const DEFAULT_VERIFICATION_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_VERIFICATION_MAX_BUFFER = 10 * 1024 * 1024;

export interface VerificationResult {
  success: boolean;
  commandId: string;
  command: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
}

/**
 * Executes an allowlisted verification command.
 */
export async function executeVerification(
  workspacePath: string,
  commandId: string,
  project?: string
): Promise<VerificationResult> {
  const startTime = performance.now();
  let projectPath: string;
  
  // 1. Validate workspace path and project path
  try {
    const validatedWorkspace = resolveAndValidatePath(workspacePath);
    if (project) {
      if (path.isAbsolute(project)) {
        projectPath = project;
      } else {
        projectPath = path.join(validatedWorkspace, project);
      }
    } else {
      projectPath = validatedWorkspace;
    }
    
    // Ensure projectPath is fully resolved and validated before proceeding
    projectPath = resolveAndValidatePath(projectPath);
  } catch (err: any) {
    const durationMs = performance.now() - startTime;
    return {
      success: false,
      commandId,
      command: "",
      args: [],
      exitCode: null,
      stdout: "",
      stderr: "",
      durationMs,
      error: `Path validation failed: ${err.message}`,
    };
  }

  // 2. Validate commandId and automatically resolve cwd from registry
  let cmdConfig;
  try {
    cmdConfig = await resolveCommandForProject(commandId, projectPath);
  } catch (err: any) {
    const durationMs = performance.now() - startTime;
    return {
      success: false,
      commandId,
      command: "",
      args: [],
      exitCode: null,
      stdout: "",
      stderr: "",
      durationMs,
      error: `Command validation failed: ${err.message}`,
    };
  }

  // 3. Execute the command
  try {
    let execCommand = cmdConfig.command;
    let execArgs = cmdConfig.args;

    if (process.platform === 'win32' && execCommand === 'npm') {
      execCommand = 'cmd.exe';
      execArgs = ['/c', 'npm', ...cmdConfig.args];
    }

    const { stdout, stderr } = await execFilePromise(execCommand, execArgs, {
      cwd: cmdConfig.cwd, // Use cwd obtained from command registry
      timeout: cmdConfig.timeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS,
      maxBuffer: cmdConfig.maxBufferBytes ?? DEFAULT_VERIFICATION_MAX_BUFFER,
      shell: false,
      env: {
        ...process.env,
        PAGER: 'cat',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'C',
      }
    });

    const durationMs = performance.now() - startTime;
    return {
      success: true,
      commandId,
      command: cmdConfig.command,
      args: cmdConfig.args,
      exitCode: 0,
      stdout: redactSensitiveData(stdout),
      stderr: redactSensitiveData(stderr),
      durationMs,
    };
  } catch (error: any) {
    const durationMs = performance.now() - startTime;
    // execFile throws an error containing code (exit code) and stdout/stderr when exit code is non-zero
    const exitCode = typeof error.code === 'number' ? error.code : null;
    return {
      success: false,
      commandId,
      command: cmdConfig.command,
      args: cmdConfig.args,
      exitCode,
      stdout: redactSensitiveData(error.stdout || ""),
      stderr: redactSensitiveData(error.stderr || error.message || ""),
      durationMs,
      error: error.message || "Command execution failed",
    };
  }
}

/**
 * Registers the run_verification tool with the MCP server.
 */
export function registerRunVerificationTool(server: McpServer): void {
  server.registerTool(
    "run_verification",
    {
      description: "Run an allowlisted verification command (e.g. npm_typecheck, npm_build) within an approved workspace",
      inputSchema: z.object({
        workspacePath: z.string().describe("Absolute path to the validated workspace root"),
        authorizationId: z.string().optional(),
        commandId: z.string().describe("The allowlisted command ID to execute"),
        project: z.string().optional().describe("Optional subproject directory name or path relative to workspacePath"),
      }),
    },
    async ({ workspacePath, commandId, project, authorizationId }) => {
      if (commandId === "repository_preflight") {
        if(hasOwnerAccess()){const root=resolveAndValidatePath(workspacePath);return {content:[{type:'text',text:JSON.stringify({success:true,accessMode:'owner',workspacePath:root,authorizationRequired:false,grantPreflightRequired:false,message:'Standing owner access; scoped grant preflight is not required. Run relevant project verification commands directly.'})}]};}
        try {
          const context = getToolContext(server);
          if (!context) throw new Error("MANAGED_CONTEXT_REQUIRED");
          if (project) throw new Error("EXACT_WORKSPACE_REQUIRED");
          const result = await runRepositoryPreflight(context, authorizationId, workspacePath);
          return {isError:!result.success,content:[{type:"text",text:JSON.stringify(result)}]};
        } catch(error) {return {isError:true,content:[{type:"text",text:JSON.stringify({success:false,error:redactSensitiveData(error instanceof Error ? error.message : String(error)),retryable:false,commitKnown:"not-applicable"})}]};}
      }
      const result = await executeVerification(workspacePath, commandId, project);
      
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );
}
