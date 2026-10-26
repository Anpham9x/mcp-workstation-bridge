import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getToolContext } from './policy.js';
import { withOwnerAccess, auditOwnerCall } from '../security/ownerAccess.js';
/** Coding mutations without an exact scoped transaction adapter fail closed.
 * Desktop/UI tools retain their separate per-action security model.
 */
export function installCodingBoundary(server:McpServer,ownerPolicyPath?:string):void{
 const denied=new Set(['git_stage','git_unstage','git_commit','git_switch','git_create_branch',
 'git_merge','git_push','git_pull_ff_only','git_delete_branch','install_package_safe',
 'run_package_script','dev_server_start','dev_server_stop','create_project_task_report',
 'bridge_temp_cleanup','bridge_temp_prepare','run_powershell','run_powershell_safe','run_verification']);
 const original=server.registerTool.bind(server) as unknown as
  (name:string,config:unknown,handler:unknown)=>ReturnType<McpServer['registerTool']>;
 server.registerTool=((name:string,config:unknown,handler:unknown)=>{
  const callback=handler as (args:Record<string,unknown>,extra:unknown)=>Promise<unknown>;
  return original(name,config,async(args:Record<string,unknown>,extra:unknown)=>withOwnerAccess(getToolContext(server)?.principal??'legacy-unverified',async()=>{
   auditOwnerCall(name);
   const readOnlyPreview=name==='git_commit'&&args.dryRun===true&&args.confirm!==true;
   const boundedGate=name==='run_verification'&&['repository_preflight','git_status'].includes(String(args.commandId));
   if(denied.has(name)&&getToolContext(server)?.requireScopes&&!readOnlyPreview&&!boundedGate){
    return {isError:true,content:[{type:'text',text:JSON.stringify({success:false,
     error:'SCOPED_ADAPTER_REQUIRED',tool:name,commitKnown:true,committed:false,retryable:false,
     nextAction:'Use scoped direct mutation/preflight; coordinator performs unsupported lifecycle outside this executor.'})}]};
   }
   return callback(args,extra);
  },ownerPolicyPath));
 }) as typeof server.registerTool;
}

