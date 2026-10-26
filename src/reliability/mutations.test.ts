import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { workspaceIdentity, runRepositoryPreflight, type Grant, type ToolContext } from './policy.js';
import { performMutation, operationStatus } from './mutations.js';
import { sha256 } from '../tools/atomicFile.js';
await fs.mkdir('scratch',{recursive:true});
const root=await fs.mkdtemp(path.resolve('scratch/reliability-operations-'));
const git=(args:string[])=>execFileSync('git',['-c','safe.directory='+root,...args],{cwd:root,encoding:'utf8'}).trim();
git(['init','--quiet']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','--quiet','-m','fixture']);
const identity=await workspaceIdentity(root), file=path.join(root,'a.txt');
const script=path.join(root,'repository-preflight.ps1');
await fs.writeFile(script,"param($RepositoryRoot,$Mode,$ExpectedTaskId,$WriteScope)\nexit 0\n");
const grant:Grant={id:'fixture',principal:'fixture-owner',workspacePath:root,parentTaskId:'FIXTURE',role:'worker',
 expiresAt:new Date(Date.now()+600000).toISOString(),revision:1,branch:String(identity.branch),head:String(identity.head),
 writeScope:['a.txt'],protectedFiles:[],gate:{script,scriptHash:sha256(await fs.readFile(script)),mode:'continue',taskId:'FIXTURE',writeScope:['a.txt']}};
const policyPath=path.join(root,'operator-policy.json'), storePath=path.join(root,'operation-store');
await fs.writeFile(policyPath,JSON.stringify({schemaVersion:1,grants:[grant]}));
const ctx:ToolContext={principal:'fixture-owner',requireScopes:true,policyPath,storePath};
await runRepositoryPreflight(ctx,'fixture',root);
const input=(op:string, expectedHash:string,payload:string)=>({file,action:'append',payload,authorizationId:'fixture',operationId:op,expectedHash,createParents:true});
const append=(text:string)=>(before:Buffer|null)=>Buffer.concat([before??Buffer.alloc(0),Buffer.from(text)]);
let r=await performMutation(ctx,input('one','ABSENT','one'),append('one'));
assert.equal(r.success,true);
r=await performMutation(ctx,input('one','ABSENT','one'),append('one'));
assert.equal(r.replayed,true);assert.equal(await fs.readFile(file,'utf8'),'one');
await assert.rejects(()=>performMutation(ctx,input('one','ABSENT','different'),append('different')),/PAYLOAD_MISMATCH/);
await assert.rejects(()=>performMutation(ctx,input('stale','ABSENT','x'),append('x')),/STALE_HASH/);
await assert.rejects(()=>operationStatus({...ctx,principal:'other'},'fixture','one'),/FOREIGN/);
const before=sha256(await fs.readFile(file));
const races=await Promise.allSettled(['a','b'].map(op=>performMutation(ctx,input('race-'+op,before,op),append(op))));
assert.equal(races.filter(x=>x.status==='fulfilled').length,1);
assert.equal(races.filter(x=>x.status==='rejected').length,1);
for(const phase of ['prepared','committed'] as const){
 const op='crash-'+phase, beforeBuffer=await fs.readFile(file);
 const request=input(op,sha256(beforeBuffer),'MARK-'+phase);
 const childFile=path.join(root,op+'.mjs');
 const policyURL=new URL('./policy.ts',import.meta.url).href, mutationURL=new URL('./mutations.ts',import.meta.url).href;
 await fs.writeFile(childFile,
  'import { runRepositoryPreflight } from '+JSON.stringify(policyURL)+';\n'+
  'import { performMutation } from '+JSON.stringify(mutationURL)+';\n'+
  'const ctx='+JSON.stringify(ctx)+'; const req='+JSON.stringify(request)+';\n'+
  'await runRepositoryPreflight(ctx,"fixture",'+JSON.stringify(root)+');\n'+
  'await performMutation(ctx,req,b=>Buffer.concat([b??Buffer.alloc(0),Buffer.from(req.payload)]),p=>{if(p==='+JSON.stringify(phase)+')process.exit(37)});\n');
 const child=spawnSync(process.execPath,[path.resolve('node_modules/tsx/dist/cli.mjs'),childFile],{encoding:'utf8',timeout:30000});
 assert.equal(child.status,37,child.stderr);
 const status=await operationStatus(ctx,'fixture',op);
 assert.equal(status.state,phase==='prepared'?'not_committed':'committed');
 await runRepositoryPreflight(ctx,'fixture',root);
 const replay=await performMutation(ctx,request,append(request.payload));
 assert.equal(replay.success,true);
 assert.equal(await fs.readFile(file,'utf8'),beforeBuffer.toString()+request.payload);
}
const unknownBefore=await fs.readFile(file);
const u=input('unknown',sha256(unknownBefore),'intended');
await assert.rejects(()=>performMutation(ctx,u,append('intended'),phase=>{if(phase==='prepared')throw new Error('fault');}),/fault/);
await fs.writeFile(file,'external writer');
assert.equal((await operationStatus(ctx,'fixture','unknown')).state,'unknown');
assert.equal((await performMutation(ctx,u,append('intended'))).success,false);
assert.equal(await fs.readFile(file,'utf8'),'external writer');
console.log('mutations: duplicate/payload/stale/concurrency/actual child-crash-before-after/restart-reconcile/unknown PASS; fixture '+root);

