import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ownerPolicyPath=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../.ai/owner-access-policy.json');
export interface OwnerPolicy {schemaVersion:1;enabled:boolean;principals:string[]}
const access=new AsyncLocalStorage<{principal:string;owner:boolean;policyPath:string}>();
export function readOwnerPolicy(policyPath=ownerPolicyPath):OwnerPolicy{
  try{
    const raw=JSON.parse(readFileSync(policyPath,'utf8')) as OwnerPolicy;
    if(raw.schemaVersion!==1||typeof raw.enabled!=='boolean'||!Array.isArray(raw.principals)||raw.principals.length>8||raw.principals.some(p=>!/^oauth:prf_[a-f0-9]{64}$/.test(p)&&p!=='legacy-owner'))return {schemaVersion:1,enabled:false,principals:[]};
    return raw;
  }catch{return {schemaVersion:1,enabled:false,principals:[]};}
}
export function hasOwnerAccess():boolean{return access.getStore()?.owner===true;}
export function ownerPrincipal():string|undefined{return access.getStore()?.principal;}
export function auditOwnerCall(tool:string):void{
  if(!hasOwnerAccess())return;
  try{const file=path.join(path.dirname(access.getStore()!.policyPath),'owner-access-audit.jsonl');mkdirSync(path.dirname(file),{recursive:true});appendFileSync(file,JSON.stringify({at:new Date().toISOString(),principal:ownerPrincipal(),tool,mode:'owner'})+'\n');}catch{/* Audit failure never changes the authenticated principal or grants access. */}
}
export function withOwnerAccess<T>(principal:string,callback:()=>T,policyPath?:string):T{
  const policy=readOwnerPolicy(policyPath);
  return access.run({principal,owner:principal!=='legacy-unverified'&&policy.enabled&&policy.principals.includes(principal),policyPath:policyPath??ownerPolicyPath},callback);
}
export function ownerAbsolutePath(value:string):string{
  if(!path.isAbsolute(value)||value.includes('\0')||/^\\\\[?.]\\/.test(value))throw new Error('ABSOLUTE_NORMAL_PATH_REQUIRED');
  return path.resolve(value);
}
