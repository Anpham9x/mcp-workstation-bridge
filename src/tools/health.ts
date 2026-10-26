import { startupBuild } from '../reliability/provenance.js';
import { installCodingBoundary } from '../reliability/boundary.js';
import { getToolContext, setToolContext } from "../reliability/policy.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { discoverEnvironmentHealth } from "../runner/health.js";
import { registerStartTaskTool } from "./startTask.js";
import { registerContinueTaskTool } from "./continueTask.js";
import { registerGitReviewSnapshotTool } from "./gitReviewSnapshot.js";
import { registerRunVerificationTool } from "./runVerification.js";
import {
  registerGetResultTool,
  registerTailLogTool,
  registerWaitForCompletionTool,
  registerCancelJobTool,
  registerIsStaleTool,
  registerGetLastErrorTool
} from "./jobResults.js";
import { registerGitStatusTool } from "./gitStatus.js";
import { registerGitDiffTool } from "./gitDiff.js";
import { registerGitFileDiffTool } from "./gitFileDiff.js";
import { registerListProjectsTool, registerReadTreeTool, registerReadFileTool } from "./discoveryAndRead.js";
import { registerApplyPatchTool } from "./applyPatch.js";
import {
  registerAppendToFileTool,
  registerReplaceTextOnceTool,
  registerReadFileRangeTool,
  registerWriteTextFileTool
} from "./directTextEdits.js";
import { registerDesktopControlTools } from "./desktopControl.js";
import { registerCodingContextTools } from "./codingContext.js";
import { registerDevServerTools } from "./devServer.js";
import { registerBrowserDomSnapshotTool } from "./browserDom.js";
import { registerProjectSafetyTools } from "./projectSafety.js";
import { registerPowerShellTool } from "./powerShell.js";
import { registerSafePowerShellTool } from "./safePowerShell.js";
import { registerGitWriteTools } from "./gitWrite.js";
import { registerBridgeTempTools } from "./bridgeTemp.js";
import { registerProcessInspectionTools } from "./processInspection.js";
import { registerWindowsDesktopTools } from "./windowsDesktop.js";
import { registerFilesystemManageTool } from "./filesystemManage.js";
import { hasOwnerAccess } from '../security/ownerAccess.js';
import { exposeTopLevelSecuritySchemes, registerProfileTool } from "./profile.js";
import { getDesktopControlIndicatorDiagnostics } from "./desktopControlIndicator.js";

function areAntigravityTaskToolsEnabled(): boolean {
  return process.env.DISABLE_ANTIGRAVITY_TASK_TOOLS !== "1";
}

/** Registers the MCP bridge tool catalog for one MCP session. */
export function registerHealthTool(server: McpServer, options: { includePowerShell?: boolean; includeSafePowerShell?: boolean; powerShellTrustOAuthGate?: boolean; compactCatalog?: boolean; profileSubject?: string; reliabilityPrincipal?: string; reliabilityPolicyPath?: string; reliabilityStorePath?: string; ownerPolicyPath?:string } = {}): void {
  setToolContext(server, {principal: options.reliabilityPrincipal ?? "legacy-unverified", requireScopes:true,policyPath:options.reliabilityPolicyPath,storePath:options.reliabilityStorePath});
  installCodingBoundary(server,options.ownerPolicyPath);
  if (options.profileSubject) registerProfileTool(server, options.profileSubject);

  // Raw PowerShell remains OAuth-successor/local-only. Public legacy may expose only the server-defined safe operation registry.
  if (options.includePowerShell) registerPowerShellTool(server, { trustOAuthGate: options.powerShellTrustOAuthGate !== false });
  if (options.includeSafePowerShell) registerSafePowerShellTool(server);

  // Register local desktop/browser review helpers first because some clients cap visible tools.
  registerDesktopControlTools(server, {
    includeLegacyAliases: !options.compactCatalog,
    includeDirectBrowserInput: !options.compactCatalog,
    // open_url already creates a tab; omit the duplicate shortcut to keep the successor at 50 tools.
    includeOpenBrowser: !options.compactCatalog,
  });
  registerWindowsDesktopTools(server);
  // This structured, workspace-scoped tool is safe to expose on both connectors.
  // Only the OAuth successor adds the authenticated profile and PowerShell tools.
  registerFilesystemManageTool(server);

  // Automatically register discovery and read tools
  registerListProjectsTool(server);
  registerReadTreeTool(server);
  registerReadFileTool(server);
  registerApplyPatchTool(server);

  // Automatically register direct guarded text tools
  registerAppendToFileTool(server);
  registerReplaceTextOnceTool(server);
  registerReadFileRangeTool(server);
  registerWriteTextFileTool(server);
  registerCodingContextTools(server);
  registerDevServerTools(server);
  if (!options.compactCatalog) {
    registerBrowserDomSnapshotTool(server);
  }
  registerProjectSafetyTools(server);

  if (areAntigravityTaskToolsEnabled() && !options.compactCatalog) {
    registerStartTaskTool(server);
    registerContinueTaskTool(server);
    registerGetResultTool(server);
    registerTailLogTool(server);
    registerWaitForCompletionTool(server);
    registerCancelJobTool(server);
    registerIsStaleTool(server);
    registerGetLastErrorTool(server);
  }

  // Automatically register git review snapshot tool to avoid editing src/server.ts
  registerGitReviewSnapshotTool(server);

  // Automatically register new git status, diff and file_diff tools
  registerGitStatusTool(server);
  registerGitDiffTool(server);
  registerGitFileDiffTool(server);
  registerGitWriteTools(server);
  registerBridgeTempTools(server);
  // list_workspace_processes already supports PID discovery; omit its narrow alias
  // from the compact successor catalog so the identity tool fits under 50 tools.
  registerProcessInspectionTools(server, { includeCheckProcessHealth: !options.compactCatalog });

  // Automatically register verification runner tool to avoid editing src/server.ts
  registerRunVerificationTool(server);

  const oauthSchemes: Record<string, Array<Record<string, unknown>>> = {};
  if (options.profileSubject) oauthSchemes.get_profile = [{ type: "oauth2", scopes: ["mcp:access"] }];
  if (options.includePowerShell) oauthSchemes.run_powershell = [{ type: "oauth2", scopes: ["mcp:access", "powershell:execute"] }];
  if (Object.keys(oauthSchemes).length > 0) exposeTopLevelSecuritySchemes(server, oauthSchemes);

  server.registerTool(
    "agy_health",
    {
      description: "Get bridge health status, workspace roots, and tool discovery metadata",
    },
    async () => {
      const healthData = await discoverEnvironmentHealth();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "ok",
                project: "mcp-antigravity-bridge",
                timestamp: new Date().toISOString(),
                tools: {
                  agy: healthData.agy,
                  git: healthData.git,
                  node: healthData.node,
                  npm: healthData.npm,
                },
                workspaceRoots: hasOwnerAccess()?['all accessible absolute paths']:healthData.workspaceRoots,
                reliability: { principalId: getToolContext(server)?.principal, ...startupBuild, accessMode:hasOwnerAccess()?'owner':'scoped', allAccessiblePaths:hasOwnerAccess(), scopedCodingWrites: !hasOwnerAccess(), authorizationRequired: !hasOwnerAccess(), unscopedCodingRunners: hasOwnerAccess()?"owner-allowed":"denied", tokenUsage: "UNKNOWN" },
                runtime: {
                  node: process.version,
                  platform: process.platform,
                  arch: process.arch,
                },
                desktopIndicator: getDesktopControlIndicatorDiagnostics(),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
