import { registerProjectSafetyTools } from '../tools/projectSafety.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerApplyPatchTool } from '../tools/applyPatch.js';
import { registerAppendToFileTool,registerReplaceTextOnceTool,registerWriteTextFileTool } from '../tools/directTextEdits.js';
import { registerCodingContextTools } from '../tools/codingContext.js';
import { registerRunVerificationTool } from '../tools/runVerification.js';
import { setToolContext,workspaceIdentity,type Grant } from './policy.js';
import { installCodingBoundary } from './boundary.js';
import { sha256 } from '../tools/atomicFile.js';
await fs.mkdir('scratch',{recursive:true});
const root=await fs.mkdtemp(path.resolve('scratch/reliability-integration-'));
const git=(args:string[])=>execFileSync('git',['-c','safe.directory='+root,...args],{cwd:root,encoding:'utf8'}).trim();
git(['init','--quiet']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','--quiet','-m','fixture']);
const identity=await workspaceIdentity(root), file=path.join(root,'a.txt'), script=path.join(root,'repository-preflight.ps1');
await fs.writeFile(script,"param($RepositoryRoot,$Mode,$ExpectedTaskId,$WriteScope)\nexit 0\n");
const grant:Grant={id:'fixture',principal:'fixture-owner',workspacePath:root,parentTaskId:'FIXTURE',role:'worker',
expiresAt:new Date(Date.now()+600000).toISOString(),revision:1,branch:String(identity.branch),head:String(identity.head),
writeScope:['a.txt'],protectedFiles:[],gate:{script,scriptHash:sha256(await fs.readFile(script)),mode:'continue',taskId:'FIXTURE',writeScope:['a.txt']}};
const policyPath=path.join(root,'policy.json');await fs.writeFile(policyPath,JSON.stringify({schemaVersion:1,grants:[grant]}));
const server=new McpServer({name:'integration',version:'1'});
setToolContext(server,{principal:'fixture-owner',requireScopes:true,policyPath,storePath:path.join(root,'operations')});
installCodingBoundary(server);
registerApplyPatchTool(server);registerAppendToFileTool(server);registerReplaceTextOnceTool(server);
registerWriteTextFileTool(server);registerCodingContextTools(server);registerRunVerificationTool(server);registerProjectSafetyTools(server);
type Tools=Record<string,{handler:(args:Record<string,unknown>)=>Promise<{isError?:boolean;content:Array<{text?:string}>}>}>;
const tools=(server as unknown as {_registeredTools:Tools})._registeredTools;
async function call(name:string,args:Record<string,unknown>){
 const r=await tools[name].handler(args);return {error:r.isError,data:JSON.parse(r.content[0].text!) as Record<string,unknown>};
}
assert.equal((await call('write_text_file',{filePath:file,content:'x'})).error,true);
assert.equal((await call('run_package_script',{workspacePath:root,scriptName:'build',dryRun:true})).error,true);
assert.equal((await call('run_verification',{workspacePath:root,commandId:'npm_build'})).error,true);
assert.equal((await call('validate_workspace_policy',{workspacePath:root,action:'execute',command:'repository_preflight'})).error,true);
assert.equal(((await call('validate_workspace_policy',{workspacePath:root,action:'execute',command:'repository_preflight',authorizationId:'fixture'})).data.decision as {allowed:boolean}).allowed,true);
assert.equal((await call('run_verification',{workspacePath:root,commandId:'repository_preflight',authorizationId:'fixture'})).error,false);
const request={filePath:file,authorizationId:'fixture',operationId:'write',expectedHash:'ABSENT',content:'one\n',overwrite:false,createParents:true,dryRun:false};
assert.equal((await call('write_text_file',request)).error,false);
assert.equal((await call('write_text_file',request)).data.replayed,true);
assert.equal((await call('project_profile',{workspacePath:root,action:'operation_status',authorizationId:'fixture',operationId:'write'})).data.state,'committed');
assert.equal((await call('replace_text_once',{filePath:file,authorizationId:'fixture',operationId:'replace',expectedHash:sha256(await fs.readFile(file)),findText:'one',replaceText:'two',dryRun:false})).error,false);
const patch='--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-two\n+three\n';
assert.equal((await call('apply_patch',{workspacePath:root,patch,authorizationId:'fixture',operationId:'patch',expectedHash:sha256(await fs.readFile(file)),dryRun:false})).error,false);
assert.equal(await fs.readFile(file,'utf8'),'three\n');
assert.equal((await call('append_to_file',{filePath:file,text:'four\n',createIfMissing:false,dryRun:false,authorizationId:'fixture',operationId:'append',expectedHash:sha256(await fs.readFile(file))})).error,false);
assert.equal(await fs.readFile(file,'utf8'),'three\nfour\n');
const outside=path.join(root,'other.txt');
assert.equal((await call('write_text_file',{...request,filePath:outside,operationId:'outside'})).error,true);
console.log('integration: managed write/append/replace/patch/status + unauthorized/alternate-runner guards PASS');

