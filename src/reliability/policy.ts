import { startupBuild } from './provenance.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolveAndValidatePath, validatePathForTextWrite, redactSensitiveData } from '../security/index.js';
import { assertNoLinks, sha256 } from '../tools/atomicFile.js';
import { validateBootstrapGrant } from '../tools/projectBootstrap.js';
import { hasOwnerAccess, ownerPrincipal } from '../security/ownerAccess.js';

const exec = promisify(execFile);
export const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const policyFile = path.join(bridgeRoot, '.ai/bridge-reliability-policy.json');
export const contextFields = {
  authorizationId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).optional(),
  expectedHash: z.string().regex(/^[a-fA-F0-9]{64}$|^ABSENT$/).optional(),
  operationId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional(),
};
export interface GateSpec {
  kind?: 'bootstrap';
  script: string; scriptHash: string; mode: 'start' | 'continue';
  taskId: string; writeScope: string[]; executor?: string; laneId?: string; leaseId?: string; coordinatorRoot?: string; manifestPath?: string; generation?: number; safeGitRoots?: string[];
}
export interface Grant {
  id: string; principal: string; workspacePath: string; parentTaskId: string;
  role: 'worker' | 'coordinator'; expiresAt: string; revision: number;
  branch: string; head: string; writeScope: string[]; protectedFiles: string[];
  gate: GateSpec; laneGeneration?: number;
}
export interface ToolContext { principal: string; requireScopes: boolean; policyPath?: string; storePath?: string }
const contexts = new WeakMap<McpServer, ToolContext>();
export function setToolContext(server: McpServer, context: ToolContext): void { contexts.set(server, context); }
export function getToolContext(server: McpServer): ToolContext | undefined { const context=contexts.get(server);return context&&hasOwnerAccess()&&ownerPrincipal()===context.principal?{...context,requireScopes:false}:context; }
const attestations = new Map<string, { fingerprint: string; until: number }>();
const within = (root: string, file: string) => {
  const rel = path.relative(root, file); return !rel.startsWith('..') && !path.isAbsolute(rel);
};
export function relativeExact(root: string, value: string): string {
  if (path.isAbsolute(value) || value.includes('*') || value.includes('?') || value.includes(',') || value.includes('\0')) throw new Error('EXACT_SCOPE_REQUIRED');
  const resolved = path.resolve(root, value);
  if (!within(root, resolved) || resolved === root) throw new Error('SCOPE_ESCAPE');
  return path.relative(root, resolved).replace(/\\/g, '/').toLowerCase();
}
export async function workspaceIdentity(workspacePath: string): Promise<Record<string, unknown>> {
  const root = resolveAndValidatePath(workspacePath);
  await assertNoLinks(root);
  const real = await fs.realpath(root);
  const git = async (args: string[]) => (await exec('git',
    ['-c', 'safe.directory=' + real, '-c', 'core.fsmonitor=false', ...args],
    {cwd: real, shell:false, timeout:10000, maxBuffer:2*1024*1024})).stdout.trim();
  const gitRoot = await git(['rev-parse','--show-toplevel']);
  if (path.resolve(gitRoot).toLowerCase() !== path.resolve(real).toLowerCase()) throw new Error('EXACT_REPO_ROOT_REQUIRED');
  return { workspacePath:real, gitRoot, branch:await git(['symbolic-ref','--short','HEAD']),
    head:await git(['rev-parse','HEAD']), dirtyPaths:(await git(['status','--porcelain'])).split(/\r?\n/).filter(Boolean),
    runtime:{pid:process.pid,cwd:process.cwd(),node:process.version,build:startupBuild},
    capabilities:{singleFilePatch:true, scopedMutation:true, repositoryPreflight:true, operationStatus:true, perFileRanges:true} };
}
export async function loadGrant(context: ToolContext, id: string | undefined, workspace?: string): Promise<Grant> {
  if (!id) throw new Error('AUTHORIZATION_REQUIRED');
  if (context.principal === 'legacy-unverified') throw new Error('AUTHENTICATED_PRINCIPAL_REQUIRED');
  const p = context.policyPath ?? policyFile;
  await assertNoLinks(p);
  const raw = JSON.parse(await fs.readFile(p,'utf8')) as {schemaVersion:number; grants:Grant[]};
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.grants)) throw new Error('INVALID_OPERATOR_POLICY');
  const grant = raw.grants.find(g => g.id === id && g.principal === context.principal);
  if (!grant || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= Date.now()) throw new Error('STALE_OR_FOREIGN_AUTHORIZATION');
  if (!Number.isSafeInteger(grant.revision) || grant.revision < 1 || !['worker','coordinator'].includes(grant.role) ||
      !/^[a-f0-9]{40}$/.test(grant.head) || !grant.branch || !grant.parentTaskId ||
      !Array.isArray(grant.writeScope) || !Array.isArray(grant.protectedFiles) || !grant.gate) throw new Error('INVALID_OPERATOR_POLICY');
  const root = resolveAndValidatePath(grant.workspacePath);
  await assertNoLinks(root);
  if (workspace && path.resolve(workspace).toLowerCase() !== root.toLowerCase()) throw new Error('FOREIGN_WORKSPACE');
  for (const file of [...grant.writeScope,...grant.protectedFiles]) relativeExact(root,file);
  const identity = await workspaceIdentity(root);
  if (identity.branch !== grant.branch || identity.head !== grant.head) throw new Error('STALE_REPO_IDENTITY');
  if (grant.gate.laneId || grant.laneGeneration !== undefined) {
    const manifestPath=grant.gate.manifestPath ?? path.join(grant.gate.coordinatorRoot ?? root,'.ai/coordination/parallel-lanes.json');
    resolveAndValidatePath(manifestPath);await assertNoLinks(manifestPath);
    const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8')) as {generation:number;lanes:Array<{laneId:string;taskId:string;executorId:string;worktree:string;branch:string;leaseId:string;expiresAt:string;writeScope:string[]}>};
    if(manifest.generation!==(grant.laneGeneration ?? grant.gate.generation))throw new Error('STALE_LANE_GENERATION');
    if(grant.gate.laneId){
      const lane=manifest.lanes.find(l=>l.laneId===grant.gate.laneId);
      if(!lane||lane.taskId!==grant.parentTaskId||lane.executorId!==grant.gate.executor||lane.leaseId!==grant.gate.leaseId||
        path.resolve(lane.worktree).toLowerCase()!==root.toLowerCase()||lane.branch!==grant.branch||
        Date.parse(lane.expiresAt)<=Date.now()||!Number.isFinite(Date.parse(lane.expiresAt))||
        JSON.stringify([...lane.writeScope].sort())!==JSON.stringify([...grant.writeScope].sort()))throw new Error('STALE_LANE_LEASE_OR_SCOPE');
    }
  }
  return grant;
}
export function grantFingerprint(grant: Grant): string { return sha256(Buffer.from(JSON.stringify(grant))); }
export async function authorizationStatus(context:ToolContext,workspace:string):Promise<Record<string,unknown>>{
  const root=resolveAndValidatePath(workspace);await assertNoLinks(root);
  if(hasOwnerAccess()&&ownerPrincipal()===context.principal)return {success:true,workspacePath:root,accessMode:'owner',authorizationRequired:false,expiresAt:null,grants:[],nextAction:'Standing owner access is active. Use filesystem/text/Git/package/PowerShell tools directly; do not request workspace grants or bootstrap approval.'};
  if(context.principal==='legacy-unverified')throw new Error('AUTHENTICATED_PRINCIPAL_REQUIRED');
  const p=context.policyPath??policyFile;await assertNoLinks(p);
  const b=await fs.readFile(p,'utf8').catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return '{"schemaVersion":1,"grants":[]}';throw e;});
  const data=JSON.parse(b) as {schemaVersion:number;grants:Grant[]};
  if(data.schemaVersion!==1||!Array.isArray(data.grants))throw new Error('INVALID_OPERATOR_POLICY');
  const matches=data.grants.filter(g=>g.principal===context.principal&&path.resolve(g.workspacePath).toLowerCase()===root.toLowerCase());
  const grants=[];
  for(const grant of matches){let usable=true,error:string|undefined;try{await loadGrant(context,grant.id,root);if(grant.gate.kind==='bootstrap')await validateBootstrapGrant(context,grant);}catch(e){usable=false;error=e instanceof Error?e.message:String(e);}grants.push({authorizationId:grant.id,expiresAt:grant.expiresAt,writeScope:grant.writeScope,protectedFiles:grant.protectedFiles,usable,error});}
  return {success:true,workspacePath:root,grants,nextAction:grants.some(g=>g.usable)?'Use usable authorizationId, run repository_preflight, then scoped text mutations.':'Absent project: use project_bootstrap plan/initialize with physical local approval. Existing project: request exact operator authorization; never self-grant or bypass.'};
}
export async function authorizeFile(context: ToolContext, id: string | undefined, file: string, requireGate=true): Promise<Grant> {
  const grant = await loadGrant(context,id);
  const root = path.resolve(grant.workspacePath);
  const target = validatePathForTextWrite(file);
  if(path.resolve(target).toLowerCase()===path.resolve(context.policyPath??policyFile).toLowerCase()||within(path.resolve(context.storePath??path.join(bridgeRoot,".ai/reliability-operations")),target))throw new Error("BRIDGE_CONTROL_PATH_DENIED");
  await assertNoLinks(target);
  if (!within(root,target)) throw new Error('FOREIGN_WORKSPACE');
  const rel = path.relative(root,target).replace(/\\/g,'/').toLowerCase();
  const allowed = grant.writeScope.map(f => relativeExact(root,f));
  const protectedPaths = grant.protectedFiles.map(f => relativeExact(root,f));
  if (!allowed.includes(rel) || protectedPaths.includes(rel)) throw new Error('FILE_OUTSIDE_AUTHORIZED_SCOPE');
  const control = path.relative(bridgeRoot,target).replace(/\\/g,'/').toLowerCase();
  if (within(bridgeRoot,target) && /^(\.ai\/|logs\/|dist\/|src\/reliability\/|src\/security\/|src\/server\.ts$)/.test(control)) throw new Error('BRIDGE_CONTROL_PATH_DENIED');
  if (within(path.dirname(path.resolve(grant.gate.script)),target)&&/\.ps1$/i.test(target)) throw new Error('GATE_SOURCE_PROTECTED');
  if (requireGate) {
    const att = attestations.get(grant.principal+'|'+grant.id);
    if (!att || att.until <= Date.now() || att.fingerprint !== grantFingerprint(grant)) throw new Error('FRESH_PREFLIGHT_REQUIRED');
  }
  return grant;
}
export async function validateScopedGate(context: ToolContext, id: string | undefined, workspace: string) {
  const grant = await loadGrant(context,id,workspace);
  const gate = grant.gate;
  if (!['start','continue'].includes(gate.mode) || gate.taskId !== grant.parentTaskId ||
      !Array.isArray(gate.writeScope) || JSON.stringify(gate.writeScope) !== JSON.stringify(grant.writeScope) ||
      !/^[a-f0-9]{64}$/i.test(gate.scriptHash)) throw new Error('INVALID_GATE_CONTRACT');
  const script = path.resolve(gate.script);
  if(gate.kind==='bootstrap'){await validateBootstrapGrant(context,grant);return grant;}
  await assertNoLinks(script);
  if (path.basename(script).toLowerCase() !== 'repository-preflight.ps1' ||
      sha256(await fs.readFile(script)) !== gate.scriptHash.toLowerCase()) throw new Error('UNTRUSTED_GATE_SOURCE');
  return grant;
}
export async function runRepositoryPreflight(context: ToolContext, id: string | undefined, workspace: string) {
  const requestId = randomUUID(), start = performance.now();
  const grant = await validateScopedGate(context,id,workspace);
  const gate = grant.gate, script = path.resolve(gate.script);
  if(gate.kind==='bootstrap'){
    const fresh=await loadGrant(context,id,workspace);
    if(grantFingerprint(fresh)!==grantFingerprint(grant))throw new Error('AUTHORIZATION_CHANGED_DURING_GATE');
    attestations.set(grant.principal+'|'+grant.id,{fingerprint:grantFingerprint(grant),until:Date.now()+2*60*1000});
    return {success:true,requestId,commandId:'repository_preflight',exitCode:0,stdout:'Approved new-project baseline identity/scope verified.',stderr:'',durationMs:performance.now()-start,authorizationId:grant.id,revision:grant.revision,commitKnown:'not-applicable',retryable:false};
  }
  const args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,
    '-RepositoryRoot',grant.workspacePath,'-Mode',gate.mode,'-ExpectedTaskId',gate.taskId,'-WriteScope',gate.writeScope.join(',')];
  for (const [key,value] of [['ExecutorId',gate.executor],['LaneId',gate.laneId],['LeaseId',gate.leaseId],['CoordinatorRoot',gate.coordinatorRoot],['ManifestPath',gate.manifestPath],['Generation',gate.generation === undefined ? undefined : String(gate.generation)]]) {
    if (value) args.push('-'+key,value);
  }
  if (args.some(a => a.includes('\0') || a.includes('\r') || a.includes('\n'))) throw new Error('INVALID_GATE_ARGUMENT');
  const roots=gate.safeGitRoots ?? [grant.workspacePath];
  if(roots.length>5)throw new Error('GIT_ROOT_LIMIT');
  const env:NodeJS.ProcessEnv={...process.env,GIT_CONFIG_COUNT:String(roots.length+1)};
  for(let i=0;i<roots.length;i++){const root=resolveAndValidatePath(roots[i]);await assertNoLinks(root);env['GIT_CONFIG_KEY_'+i]='safe.directory';env['GIT_CONFIG_VALUE_'+i]=root;}
  env['GIT_CONFIG_KEY_'+roots.length]='core.fsmonitor';env['GIT_CONFIG_VALUE_'+roots.length]='false';
  let stdout='',stderr='',exitCode:number|null=0;
  try {
    const r=await exec('powershell.exe',args,{cwd:grant.workspacePath,shell:false,timeout:60000,maxBuffer:256*1024,env});
    stdout=r.stdout;stderr=r.stderr;
  } catch(e) {
    const failure=e as Error & {code?:number;stdout?:string;stderr?:string};
    exitCode=typeof failure.code === 'number' ? failure.code : null;stdout=failure.stdout??'';stderr=failure.stderr??failure.message;
  }
  // Recheck operator revision, expiry, HEAD/generation after execution.
  const fresh=await loadGrant(context,id,workspace);
  if(grantFingerprint(fresh)!==grantFingerprint(grant)) throw new Error('AUTHORIZATION_CHANGED_DURING_GATE');
  const success=exitCode===0;
  if(success)attestations.set(grant.principal+'|'+grant.id,{fingerprint:grantFingerprint(grant),until:Date.now()+2*60*1000});
  else attestations.delete(grant.principal+'|'+grant.id);
  return {success,requestId,commandId:'repository_preflight',exitCode,
    stdout:redactSensitiveData(stdout),stderr:redactSensitiveData(stderr),durationMs:performance.now()-start,
    authorizationId:grant.id,revision:grant.revision,commitKnown:'not-applicable',retryable:false};
}

