import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { projectBootstrap } from './projectBootstrap.js';
import { authorizationStatus, runRepositoryPreflight, type ToolContext } from '../reliability/policy.js';
import { performMutation } from '../reliability/mutations.js';
import { sha256 } from './atomicFile.js';

// Explicit disposable sibling fixture, outside the bridge Git repository. Never touches a product project.
const parent=path.resolve('C:/Users/ExampleUser/Documents/mcp-bootstrap-test-'+randomUUID());
assert.equal(path.dirname(parent).toLowerCase(),path.resolve('C:/Users/ExampleUser/Documents').toLowerCase());
await fs.mkdir(parent);
const context:ToolContext={principal:'fixture-owner',requireScopes:true,policyPath:path.join(parent,'operator.json'),storePath:path.join(parent,'operations')};
let approvals=0;
const approve=async(message:string)=>{approvals++;assert.ok(message.includes('Editable files:'));assert.ok(message.includes('Plan SHA256:'));return true;};
const project=path.join(parent,'new-project');
const files=[{filePath:'README.md',content:'\ufeffFoundation\r\nTiếng Việt\r\n'}];
const input={action:'plan' as const,workspacePath:project,operationId:'fixture-new',files,writeScope:['README.md','src/app.ts']};
try{
  const plan=await projectBootstrap(input,context,approve);
  assert.equal(approvals,0);assert.equal(await fs.stat(project).catch(()=>null),null);
  const execute={...input,action:'initialize' as const,planHash:plan.planHash as string,confirmExecution:true as const};
  await assert.rejects(projectBootstrap({...execute,planHash:'0'.repeat(64)},context,approve),/PLAN_CONFIRMATION/);
  await assert.rejects(projectBootstrap(execute,context,async()=>false),/LOCAL_APPROVAL_DENIED/);
  assert.equal(await fs.stat(project).catch(()=>null),null);
  const created=await projectBootstrap(execute,context,approve);
  assert.equal(created.success,true);assert.equal(approvals,1);
  assert.equal((await fs.readFile(path.join(project,'README.md'),'utf8')),files[0].content);
  const git=(args:string[])=>execFileSync('git',['-c','safe.directory='+project,...args],{cwd:project,encoding:'utf8'}).trim();
  assert.equal(git(['status','--porcelain']),'');assert.equal(git(['rev-parse','HEAD']),created.head);
  const grant=created.authorizationId as string;
  assert.equal((await projectBootstrap(execute,context,approve)).replayed,true);assert.equal(approvals,1);
  assert.equal((await projectBootstrap({action:'status',workspacePath:project,operationId:input.operationId},context)).state,'committed');
  await assert.rejects(projectBootstrap({...execute,files:[{filePath:'README.md',content:'changed'}]},context,approve),/PAYLOAD_MISMATCH|PLAN_CONFIRMATION/);
  assert.equal(((await authorizationStatus(context,project)).grants as {usable:boolean}[])[0].usable,true);
  assert.equal(((await authorizationStatus({...context,principal:'foreign'},project)).grants as unknown[]).length,0);
  const file=path.join(project,'README.md');
  await assert.rejects(performMutation(context,{file,action:'test',payload:'fixture',authorizationId:grant,operationId:'before-gate',expectedHash:sha256(await fs.readFile(file))},()=>Buffer.from('changed')),/FRESH_PREFLIGHT/);
  assert.equal((await runRepositoryPreflight(context,grant,project)).success,true);
  const written=await performMutation(context,{file,action:'test',payload:'fixture',authorizationId:grant,operationId:'after-gate',expectedHash:sha256(await fs.readFile(file))},()=>Buffer.from('approved edit\n'));
  assert.equal(written.success,true);
  assert.equal(await fs.readFile(file,'utf8'),'approved edit\n');
  await assert.rejects(performMutation(context,{file:path.join(project,'not-authorized.md'),action:'test',payload:'fixture',authorizationId:grant,operationId:'outside-scope',expectedHash:'ABSENT'},()=>Buffer.from('no')),/OUTSIDE_AUTHORIZED_SCOPE/);
  await assert.rejects(performMutation({...context,principal:'foreign'},{file,action:'test',payload:'fixture',authorizationId:grant,operationId:'foreign',expectedHash:'ABSENT'},()=>Buffer.from('no')),/FOREIGN_AUTHORIZATION/);
  await assert.rejects(projectBootstrap({...input,action:'initialize',operationId:'another',planHash:'0'.repeat(64),confirmExecution:true},context,approve),/PLAN_CONFIRMATION/);
  const existingPlan=await projectBootstrap({...input,operationId:'another'},context,approve);
  await assert.rejects(projectBootstrap({...input,action:'initialize',operationId:'another',planHash:existingPlan.planHash as string,confirmExecution:true},context,approve),/PROJECT_ALREADY_EXISTS/);
  for(const filePath of ['../outside.md','.ai/operator.json','.git/config','.env','file:stream','CON.md','README.md.'])await assert.rejects(projectBootstrap({...input,files:[{filePath,content:'no'}],writeScope:[filePath]},context,approve));
  await assert.rejects(projectBootstrap({...input,files:[{filePath:'README.md',content:'\0binary'}]},context,approve),/BINARY/);
  await assert.rejects(projectBootstrap({...input,workspacePath:'C:/Windows/new-project'},context,approve));
  await assert.rejects(projectBootstrap(input,{...context,principal:'legacy-unverified'},approve),/AUTHENTICATED_PRINCIPAL/);
  await assert.rejects(projectBootstrap({...input,workspacePath:path.resolve('scratch/bootstrap-nested')},context,approve),/NESTED_REPOSITORY/);
  const policy=JSON.parse(await fs.readFile(context.policyPath!,'utf8'));policy.grants[0].expiresAt='2000-01-01T00:00:00Z';await fs.writeFile(context.policyPath!,JSON.stringify(policy));
  assert.equal(((await authorizationStatus(context,project)).grants as {usable:boolean}[])[0].usable,false);
  await assert.rejects(runRepositoryPreflight(context,grant,project),/STALE_OR_FOREIGN_AUTHORIZATION/);
  console.log('projectBootstrap PASS: physical approval boundary, exact plan, Git/bytes, replay, scoped edit/preflight, isolation, invalid paths/expiry.');
}finally{
  // Delete only the exact disposable fixture verified above, never a computed product directory.
  if(path.dirname(parent).toLowerCase()!==path.resolve('C:/Users/ExampleUser/Documents').toLowerCase()||!path.basename(parent).startsWith('mcp-bootstrap-test-'))throw new Error('Unexpected cleanup root');
  await fs.rm(parent,{recursive:true,force:true});
}
