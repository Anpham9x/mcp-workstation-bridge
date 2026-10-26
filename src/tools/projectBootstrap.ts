import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { assertNoLinks, atomicFile, readOptional, sha256 } from './atomicFile.js';
import { requestLocalPowerShellApproval, type PowerShellApprovalProvider } from './powerShell.js';
import { resolveAndValidatePath, validatePathForTextWrite, redactSensitiveData } from '../security/index.js';
import { bridgeRoot, getToolContext, policyFile, type ToolContext, type Grant } from '../reliability/policy.js';

const exec = promisify(execFile);
export const bootstrapGateSource = fileURLToPath(import.meta.url);
const fileSpec = z.object({ filePath:z.string().min(1).max(200), content:z.string().max(131072) }).strict();
export const bootstrapSchema = z.object({
  action:z.enum(['plan','initialize','status']), workspacePath:z.string().min(1),
  operationId:z.string().regex(/^[a-zA-Z0-9_-]{1,70}$/),
  files:z.array(fileSpec).min(1).max(40).optional(),
  writeScope:z.array(z.string().min(1).max(200)).min(1).max(80).optional(),
  planHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  confirmExecution:z.literal(true).optional(),
}).strict();
type Input = z.infer<typeof bootstrapSchema>;
type RecordData = {principal:string; workspacePath:string; planHash:string; state:'prepared'|'committed'|'partial'; authorizationId:string; result?:Record<string,unknown>};
function safeRelative(root:string, value:string):string {
  if(path.isAbsolute(value)||value.includes('\\')||value.includes(':')||value.split('/').some(p=>!p||p==='.'||p==='..'||p.endsWith('.')||p.endsWith(' ')||/[\x00-\x1f*?<>|]/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))throw new Error('INVALID_BOOTSTRAP_PATH');
  if (/^(\.git|\.ai|node_modules|dist|build|logs)(\/|$)/i.test(value))throw new Error('BOOTSTRAP_CONTROL_PATH_DENIED');
  validatePathForTextWrite(path.join(root,value));
  return value;
}
function recordPath(context:ToolContext, principal:string, op:string):string {
  return path.join(context.storePath??path.join(bridgeRoot,'.ai/reliability-operations'),'bootstrap',sha256(Buffer.from(principal+'|'+op))+'.json');
}
async function save(file:string,data:RecordData):Promise<void>{await assertNoLinks(file);await fs.mkdir(path.dirname(file),{recursive:true});await atomicFile(file,Buffer.from(JSON.stringify(data)),await readOptional(file));}
async function readRecord(file:string):Promise<RecordData|null>{await assertNoLinks(file);const b=await readOptional(file);return b?JSON.parse(b.toString('utf8')):null;}
export async function validateBootstrapGrant(context:ToolContext, grant:Grant):Promise<void>{
  const op=grant.id.replace(/^bootstrap-/,'');
  const record=await readRecord(recordPath(context,grant.principal,op));
  if(!record||record.state!=='committed'||record.authorizationId!==grant.id||path.resolve(record.workspacePath).toLowerCase()!==path.resolve(grant.workspacePath).toLowerCase())throw new Error('UNTRUSTED_BOOTSTRAP_GRANT');
  if(path.resolve(grant.gate.script)!==path.resolve(bootstrapGateSource)||grant.gate.scriptHash!==sha256(await fs.readFile(bootstrapGateSource)))throw new Error('UNTRUSTED_BOOTSTRAP_GATE');
}
export async function projectBootstrap(raw:Input,context:ToolContext,approve:PowerShellApprovalProvider=(action,directory)=>requestLocalPowerShellApproval(action,directory,'project bootstrap')):Promise<Record<string,unknown>>{
  const input=bootstrapSchema.parse(raw);
  if(!context.requireScopes||context.principal==='legacy-unverified')throw new Error('AUTHENTICATED_PRINCIPAL_REQUIRED');
  const root=resolveAndValidatePath(input.workspacePath);
  await assertNoLinks(root);
  // A new immediate child of an existing directory only; never initialize inside an existing Git repository.
  const parent=path.dirname(root);
  if(root===parent||!(await fs.stat(parent)).isDirectory())throw new Error('EXISTING_PARENT_REQUIRED');
  let ancestor=parent;
  for(;;){let hasGit=false;try{await fs.lstat(path.join(ancestor,'.git'));hasGit=true;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}if(hasGit)throw new Error('NESTED_REPOSITORY_DENIED');const next=path.dirname(ancestor);if(next===ancestor)break;ancestor=next;}
  const ledger=recordPath(context,context.principal,input.operationId);
  const old=await readRecord(ledger);
  if(old&&path.resolve(old.workspacePath).toLowerCase()!==root.toLowerCase())throw new Error('OPERATION_PAYLOAD_MISMATCH');
  if(input.action==='status')return old?{success:old.state==='committed',state:old.state,...old.result}:{success:false,state:'not_found'};
  if(!input.files||!input.writeScope)throw new Error('FILES_AND_WRITE_SCOPE_REQUIRED');
  const files=input.files.map(f=>({filePath:safeRelative(root,f.filePath),content:f.content}));
  const scope=input.writeScope.map(f=>safeRelative(root,f));
  const lower=scope.map(p=>p.toLowerCase());
  if(new Set(lower).size!==scope.length||new Set(files.map(f=>f.filePath.toLowerCase())).size!==files.length)throw new Error('DUPLICATE_BOOTSTRAP_PATH');
  const names=files.map(f=>f.filePath.toLowerCase());
  if(names.some(a=>names.some(b=>b!==a&&b.startsWith(a+'/'))))throw new Error('BOOTSTRAP_FILE_DIRECTORY_CONFLICT');
  if(files.some(f=>!lower.includes(f.filePath.toLowerCase())))throw new Error('FILE_OUTSIDE_AUTHORIZED_SCOPE');
  if(files.some(f=>f.content.includes('\0')||redactSensitiveData(f.content)!==f.content))throw new Error('SENSITIVE_OR_BINARY_BOOTSTRAP_CONTENT');
  if(files.reduce((n,f)=>n+Buffer.byteLength(f.content),0)>1024*1024)throw new Error('BOOTSTRAP_SIZE_LIMIT');
  // Fixed secret/generated exclusions are always part of the baseline; no supplied ignore file can weaken them.
  if(files.some(f=>f.filePath.toLowerCase()==='.gitignore')||lower.includes('.gitignore'))throw new Error('BOOTSTRAP_GITIGNORE_MANAGED');
  const ignore='.env\n.env.*\n*.pem\n*.key\n.npmrc\n.git-credentials\nnode_modules/\n.venv/\n__pycache__/\nlogs/\ndist/\nbuild/\n';
  const all=[...files,{filePath:'.gitignore',content:ignore}];
  const planHash=sha256(Buffer.from(JSON.stringify({principal:context.principal,root,operationId:input.operationId,files:all,writeScope:scope})));
  const plan={workspacePath:root,operationId:input.operationId,planHash,files:all.map(f=>({filePath:f.filePath,bytes:Buffer.byteLength(f.content),sha256:sha256(Buffer.from(f.content))})),writeScope:scope,grantDurationMinutes:120,requiresLocalApproval:true};
  if(input.action==='plan')return {success:true,...plan};
  if(input.confirmExecution!==true||input.planHash!==planHash)throw new Error('BOOTSTRAP_PLAN_CONFIRMATION_REQUIRED');
  if(old){if(old.planHash!==planHash)throw new Error('OPERATION_PAYLOAD_MISMATCH');if(old.state!=='committed')throw new Error('BOOTSTRAP_PARTIAL_REVIEW_REQUIRED');return {success:true,replayed:true,...old.result};}
  try{await fs.lstat(root);throw new Error('PROJECT_ALREADY_EXISTS');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const prompt='Create NEW project and grant 120 minutes of scoped file edits. No execution/install/network.\nProject: '+root+'\nOperation: '+input.operationId+'\nPlan SHA256: '+planHash+'\nCreate files: '+all.map(f=>f.filePath).join(', ')+'\nEditable files: '+scope.join(', ');
  if(prompt.length>2800)throw new Error('APPROVAL_SCOPE_TOO_LARGE');
  if(!(await approve(prompt,parent)))throw new Error('LOCAL_APPROVAL_DENIED');
  // Serialize policy provisioning, and exclusively reserve operation and target after physical approval.
  const p=context.policyPath??policyFile;await assertNoLinks(p);await fs.mkdir(path.dirname(p),{recursive:true});
  const lock=p+'.bootstrap-lock';await fs.mkdir(lock);
  const id='bootstrap-'+input.operationId;
  const record:RecordData={principal:context.principal,workspacePath:root,planHash,state:'prepared',authorizationId:id};
  let reserved=false;
  try{
    if(await readRecord(ledger))throw new Error('BOOTSTRAP_OPERATION_BUSY');
    const before=await readOptional(p);
    const policy=before?JSON.parse(before.toString('utf8')):{schemaVersion:1,grants:[]};
    if(policy.schemaVersion!==1||!Array.isArray(policy.grants))throw new Error('INVALID_OPERATOR_POLICY');
    if(policy.grants.some((g:Grant)=>g.id===id))throw new Error('BOOTSTRAP_GRANT_ID_CONFLICT');
    await assertNoLinks(root);await save(ledger,record);reserved=true;await fs.mkdir(root);await assertNoLinks(root);
    // Ignore inherited Git overrides and global/system config; empty templates/hooks, local identity only.
    const env={...process.env};for(const k of Object.keys(env))if(k.startsWith('GIT_'))delete env[k];
    env.GIT_CONFIG_NOSYSTEM='1';env.GIT_CONFIG_GLOBAL=process.platform==='win32'?'NUL':'/dev/null';
    const empty=path.join(path.dirname(ledger),'empty-git-template');await fs.mkdir(empty,{recursive:true});await assertNoLinks(empty);
    const git=async(args:string[])=>(await exec('git',['-c','safe.directory='+root,'-c','core.hooksPath='+empty,'-c','core.fsmonitor=false',...args],{cwd:root,env,shell:false,timeout:20000,maxBuffer:1024*1024})).stdout.trim();
    await git(['init','--initial-branch=main','--template='+empty]);
    await git(['config','--local','core.autocrlf','false']);
    for(const f of all){const dest=path.join(root,f.filePath);await assertNoLinks(dest);await fs.mkdir(path.dirname(dest),{recursive:true});await atomicFile(dest,Buffer.from(f.content),null);}
    await git(['add','--',...all.map(f=>f.filePath)]);
    await git(['-c','user.name=MCP Project Bootstrap','-c','user.email=bootstrap@localhost','-c','commit.gpgSign=false','commit','-m','Initialize approved project foundation']);
    const head=await git(['rev-parse','HEAD']);
    const grant:Grant={id,principal:context.principal,workspacePath:root,parentTaskId:input.operationId,role:'worker',expiresAt:new Date(Date.now()+120*60000).toISOString(),revision:1,branch:'main',head,writeScope:scope,protectedFiles:['.gitignore'],gate:{kind:'bootstrap',script:bootstrapGateSource,scriptHash:sha256(await fs.readFile(bootstrapGateSource)),mode:'start',taskId:input.operationId,writeScope:scope}};
    policy.grants.push(grant);await atomicFile(p,Buffer.from(JSON.stringify(policy,null,2)),before);
    for(const f of all)if(sha256(await fs.readFile(path.join(root,f.filePath)))!==sha256(Buffer.from(f.content)))throw new Error('BOOTSTRAP_READBACK_FAILED');
    if(await git(['status','--porcelain']))throw new Error('BOOTSTRAP_BASELINE_NOT_CLEAN');
    record.state='committed';record.result={workspacePath:root,authorizationId:id,expiresAt:grant.expiresAt,branch:'main',head,files:plan.files,writeScope:scope,nextAction:'Run run_verification commandId=repository_preflight with authorizationId, then existing scoped text tools with expectedHash and unique operationId. No raw PowerShell needed.'};
    await save(ledger,record);return {success:true,state:'committed',...record.result};
  }catch(e){if(reserved){record.state='partial';await save(ledger,record);}throw e;}
  finally{await fs.rmdir(lock);}
}
export function registerProjectBootstrapTool(server:McpServer):void{
  server.registerTool('project_bootstrap',{description:'Plan and initialize a NEW absent project directory with exact approved text foundation, Git baseline and a 120-minute scoped editing authorization. action=plan returns planHash; initialize requires same files/writeScope, planHash and confirmExecution=true plus a physical local Windows approval (cannot be bypassed by model). status recovers outcome. Never overwrites existing projects, executes supplied code or grants arbitrary access. Then use existing repository_preflight and scoped file tools; do not ask owner to run PowerShell.',inputSchema:bootstrapSchema},async args=>{
    try{const context=getToolContext(server);if(!context)throw new Error('MANAGED_CONTEXT_REQUIRED');return {content:[{type:'text',text:JSON.stringify(await projectBootstrap(args,context))}]};}
    catch(e){return {isError:true,content:[{type:'text',text:JSON.stringify({success:false,error:redactSensitiveData(e instanceof Error?e.message:String(e)),nextAction:'Review plan/scope, obtain local approval for initialize; existing projects require their own operator authorization. Never bypass with raw shell.'})}]};}
  });
}
