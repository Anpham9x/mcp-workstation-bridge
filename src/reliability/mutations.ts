import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { authorizeFile, bridgeRoot, grantFingerprint, loadGrant, type ToolContext } from './policy.js';
import { assertNoLinks, atomicFile, readOptional, sha256 } from '../tools/atomicFile.js';

export interface MutationInput {
  authorizationId?: string; operationId?: string; expectedHash?: string;
  file: string; action: string; payload: unknown; dryRun?: boolean; createParents?: boolean;
}
interface RecordEntry {
  version: 1; key: string; principal: string; authorizationId: string; operationId: string;
  file: string; fingerprint: string; beforeHash: string; afterHash: string; requestId: string;
  state: 'prepared'|'committed'|'not_committed'|'unknown'; createdAt: string; bytes: number; temp: string;
}
const hashOf = (b: Buffer|null) => b === null ? 'ABSENT' : sha256(b);
const store = (context:ToolContext) => context.storePath ?? path.join(bridgeRoot,'.ai/reliability-operations');
const opKey=(context:ToolContext,id:string,op:string)=>sha256(Buffer.from(context.principal+'|'+id+'|'+op));
const mutexes = new Map<string,Promise<void>>();
async function lock<T>(context:ToolContext,file:string,action:()=>Promise<T>):Promise<T> {
  const key=sha256(Buffer.from(path.resolve(file).toLowerCase()));
  const previous=mutexes.get(key)??Promise.resolve();
  let unlock!:()=>void;
  const wait=new Promise<void>(r=>{unlock=r;}); const tail=previous.then(()=>wait);
  mutexes.set(key,tail);
  await previous;
  const dir=path.join(store(context),'locks',key);
  let acquired=false,recoveryOwned=false;
  const recovery=dir+'-recovery';
  try {
    await assertNoLinks(store(context));
    await fs.mkdir(path.dirname(dir),{recursive:true});
    try { await fs.mkdir(dir); acquired=true; }
    catch(e) {
      if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
      // Serialize stale-owner rechecks; no contender may remove a replacement live lock.
      try{await fs.mkdir(recovery);recoveryOwned=true;}catch{throw new Error('RECOVERY_BUSY');}
      // Never steal a possibly live/recycled PID lock. Dead-owner recovery only.
      let owner:{pid:number};
      try{owner=JSON.parse(await fs.readFile(path.join(dir,'owner.json'),'utf8'));}
      catch{throw new Error('LOCK_OWNER_UNKNOWN');}
      try{process.kill(owner.pid,0);throw new Error('WRITER_BUSY');}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
      await fs.unlink(path.join(dir,'owner.json'));await fs.rmdir(dir);
      await fs.mkdir(dir);acquired=true;
    }
    await fs.writeFile(path.join(dir,'owner.json'),JSON.stringify({pid:process.pid}),{flag:'wx'});
    return await action();
  } finally {
    if(acquired){await fs.unlink(path.join(dir,'owner.json')).catch(()=>undefined);await fs.rmdir(dir).catch(()=>undefined);}
    if(recoveryOwned)await fs.rmdir(recovery).catch(()=>undefined);
    unlock();if(mutexes.get(key)===tail)mutexes.delete(key);
  }
}
async function writeRecord(file:string,value:unknown):Promise<void>{
  await assertNoLinks(file);await fs.mkdir(path.dirname(file),{recursive:true});
  await atomicFile(file,Buffer.from(JSON.stringify(value)),await readOptional(file));
}
async function readRecord(file:string):Promise<RecordEntry|null>{
  await assertNoLinks(file);const raw=await readOptional(file);return raw?JSON.parse(raw.toString('utf8')) as RecordEntry:null;
}
function paths(context:ToolContext,key:string,file:string) {
  return {entry:path.join(store(context),'entries',key+'.json'),
    pending:path.join(store(context),'pending',sha256(Buffer.from(path.resolve(file).toLowerCase()))+'.json')};
}
function response(record:RecordEntry,replayed=false){
  return {success:record.state==='committed',operationId:record.operationId,requestId:record.requestId,
    state:record.state,commitKnown:record.state==='committed'||record.state==='not_committed',committed:record.state==='committed',retryable:false,replayed,
    beforeHash:record.beforeHash,afterHash:record.afterHash,bytes:record.bytes};
}
async function reconcile(context:ToolContext,record:RecordEntry):Promise<RecordEntry>{
  const p=paths(context,record.key,record.file);
  const actual=hashOf(await readOptional(record.file));
  if(record.state==='prepared'){
    record.state=actual===record.afterHash?'committed':actual===record.beforeHash?'not_committed':'unknown';
    await writeRecord(p.entry,record);
    if(record.state==='committed')await fs.unlink(p.pending).catch(()=>undefined);
  }
  return record;
}
export async function operationStatus(context:ToolContext,authorizationId:string|undefined,operationId:string|undefined){
  if(!operationId || !/^[a-zA-Z0-9_-]{1,100}$/.test(operationId))throw new Error('OPERATION_ID_REQUIRED');
  const grant=await loadGrant(context,authorizationId);
  const key=opKey(context,grant.id,operationId);
  const entry=path.join(store(context),'entries',key+'.json');
  const record=await readRecord(entry);
  if(!record)return {success:false,operationId,state:'not_found',commitKnown:false,retryable:false};
  if(record.principal!==context.principal || record.authorizationId!==grant.id)throw new Error('FOREIGN_OPERATION');
  await authorizeFile(context,grant.id,record.file,false);
  return lock(context,record.file,async()=>response(await reconcile(context,(await readRecord(entry))!)));
}
export async function performMutation(
  context:ToolContext|undefined,input:MutationInput,
  plan:(before:Buffer|null)=>Buffer,
  fault?: (phase:'prepared'|'committed')=>void
):Promise<Record<string,unknown>> {
  const file=path.resolve(input.file);
  if(!context?.requireScopes){
    await assertNoLinks(file);
    const before=await readOptional(file), after=plan(before);
    if(input.expectedHash&&hashOf(before)!==(input.expectedHash==='ABSENT'?'ABSENT':input.expectedHash.toLowerCase()))throw new Error('STALE_HASH');
    if(!input.dryRun){if(input.createParents)await fs.mkdir(path.dirname(file),{recursive:true});await atomicFile(file,after,before);}
    return {success:true,dryRun:!!input.dryRun,beforeHash:hashOf(before),afterHash:sha256(after),bytes:after.length};
  }
  const start=performance.now();
  const grant=await authorizeFile(context,input.authorizationId,file,!input.dryRun);
  if(!input.expectedHash || !/^[a-f0-9]{64}$|^ABSENT$/i.test(input.expectedHash))throw new Error('EXPECTED_HASH_REQUIRED');
  if(!input.operationId || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.operationId))throw new Error('OPERATION_ID_REQUIRED');
  if(input.dryRun){
    const before=await readOptional(file);
    if(hashOf(before)!==input.expectedHash.toLowerCase() && !(before===null&&input.expectedHash==='ABSENT'))throw new Error('STALE_HASH');
    const after=plan(before);
    return {success:true,dryRun:true,commitKnown:'not-applicable',beforeHash:hashOf(before),afterHash:sha256(after),bytes:after.length};
  }
  return lock(context,file,async()=>{
    const current=await authorizeFile(context,grant.id,file,true);
    if(grantFingerprint(current)!==grantFingerprint(grant))throw new Error('AUTHORIZATION_CHANGED');
    const key=opKey(context,grant.id,input.operationId!);
    const fingerprint=sha256(Buffer.from(JSON.stringify({file,action:input.action,payload:input.payload,expectedHash:input.expectedHash,parent:grant.parentTaskId,scope:grant.writeScope,branch:grant.branch,head:grant.head})));
    const p=paths(context,key,file);
    let old=await readRecord(p.entry);
    const pending=await readRecord(p.pending);
    if(!old&&pending?.key===key){old=pending;await writeRecord(p.entry,old);}
    if(old){
      if(old.fingerprint!==fingerprint)throw new Error('OPERATION_PAYLOAD_MISMATCH');
      if(old.state==='prepared')old=await reconcile(context,old);
      if(old.state==='not_committed'){
        const actual=await readOptional(file);
        if(hashOf(actual)!==old.beforeHash)throw new Error('STALE_HASH_AT_RECOVERY');
        const staged=await readOptional(old.temp);
        if(!staged||sha256(staged)!==old.afterHash)throw new Error('RECOVERY_STAGE_MISSING');
        await atomicFile(file,staged,actual);old.state='committed';await writeRecord(p.entry,old);
        await fs.unlink(p.pending).catch(()=>undefined);await fs.unlink(old.temp).catch(()=>undefined);
      }
      return {...response(old,true),durationMs:performance.now()-start};
    }
    if(pending){
      const recovered=await reconcile(context,pending);
      if(recovered.state!=='committed')throw new Error('UNRESOLVED_PREDECESSOR_OPERATION');
    }
    await fs.mkdir(path.join(store(context),'entries'),{recursive:true});
    if((await fs.readdir(path.join(store(context),'entries'))).length>=10000)throw new Error('OPERATION_STORE_CAPACITY');
    const before=await readOptional(file);
    const expected=input.expectedHash!.toUpperCase()==='ABSENT'?'ABSENT':input.expectedHash!.toLowerCase();
    if(hashOf(before)!==expected)throw new Error('STALE_HASH');
    const after=plan(before);
    if(after.length>5*1024*1024)throw new Error('OUTPUT_TOO_LARGE');
    if(input.createParents)await fs.mkdir(path.dirname(file),{recursive:true});
    await assertNoLinks(file);
    const temp=path.join(path.dirname(file),'.bridge-operation-'+key+'.tmp');
    const handle=await fs.open(temp,'wx',0o600);
    try{await handle.writeFile(after);await handle.sync();}finally{await handle.close();}
    const record:RecordEntry={version:1,key,principal:context.principal,authorizationId:grant.id,operationId:input.operationId!,
      file,fingerprint,beforeHash:hashOf(before),afterHash:sha256(after),requestId:randomUUID(),
      state:'prepared',createdAt:new Date().toISOString(),bytes:after.length,temp};
    // Durable intent before touching target; pending contains enough data for orphan-ledger recovery.
    await writeRecord(p.pending,record);await writeRecord(p.entry,record);
    fault?.('prepared');
    await authorizeFile(context,grant.id,file,true);
    const now=await readOptional(file);
    if(hashOf(now)!==record.beforeHash)throw new Error('STALE_HASH_AT_COMMIT');
    // atomicFile rechecks immediately before rename; managed writers share the cross-process lock.
    await atomicFile(file,after,before);
    fault?.('committed');
    record.state='committed';await writeRecord(p.entry,record);await fs.unlink(p.pending);
    await fs.unlink(temp).catch(()=>undefined);
    return {...response(record),durationMs:performance.now()-start};
  });
}

