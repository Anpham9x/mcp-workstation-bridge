import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { hasOwnerAccess, ownerAbsolutePath } from '../security/ownerAccess.js';
import { assertNoLinks, atomicFile, readOptional, sha256 } from './atomicFile.js';
import { redactSensitiveData } from '../security/index.js';

export const filesystemSchema=z.object({
  action:z.enum(['mkdir','stat','copy','move','delete','write_bytes']),
  path:z.string().min(1),destination:z.string().optional(),
  recursive:z.boolean().optional().default(false),
  overwrite:z.boolean().optional().default(false),
  permanent:z.boolean().optional().default(false),
  confirmDelete:z.literal(true).optional(),
  base64:z.string().max(7*1024*1024).optional(),
  expectedHash:z.string().regex(/^[a-f0-9]{64}$|^ABSENT$/i).optional(),
  dryRun:z.boolean().optional().default(false),
}).strict();
type Input=z.infer<typeof filesystemSchema>;
function noRoot(target:string):void{if(target===path.parse(target).root)throw new Error('FILESYSTEM_ROOT_MUTATION_DENIED');}
function separate(source:string,destination:string):void{const rel=path.relative(source,destination);if(!rel||(!rel.startsWith('..')&&!path.isAbsolute(rel)))throw new Error('DESTINATION_INSIDE_SOURCE');}
async function assertTree(target:string):Promise<void>{
  await assertNoLinks(target);let entries=0;
  async function walk(dir:string):Promise<void>{for(const e of await fs.readdir(dir,{withFileTypes:true})){if(++entries>100000)throw new Error('TREE_TOO_LARGE_USE_POWERSHELL');if(e.isSymbolicLink())throw new Error('PATH_LINK_DENIED');if(e.isDirectory())await walk(path.join(dir,e.name));}}
  if((await fs.lstat(target)).isDirectory())await walk(target);
}
export async function filesystemManage(raw:z.input<typeof filesystemSchema>):Promise<Record<string,unknown>>{
  if(!hasOwnerAccess())throw new Error('STANDING_OWNER_ACCESS_REQUIRED');
  const input=filesystemSchema.parse(raw),target=ownerAbsolutePath(input.path);
  await assertNoLinks(target);
  if(input.action==='stat'){
    try{const s=await fs.lstat(target);return {success:true,path:target,exists:true,type:s.isDirectory()?'directory':'file',bytes:s.size,modifiedAt:s.mtime.toISOString()};}
    catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {success:true,path:target,exists:false};throw e;}
  }
  noRoot(target);
  if(input.action==='mkdir'){
    if(!input.dryRun)await fs.mkdir(target,{recursive:input.recursive});
    return {success:true,path:target,action:input.action,dryRun:input.dryRun};
  }
  if(input.action==='write_bytes'){
    if(input.base64===undefined||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.base64))throw new Error('VALID_BASE64_REQUIRED');
    const bytes=Buffer.from(input.base64,'base64');if(bytes.length>5*1024*1024)throw new Error('FILE_TOO_LARGE_USE_POWERSHELL');
    const before=await readOptional(target);
    if(before&&!input.overwrite)throw new Error('FILE_ALREADY_EXISTS');
    if(input.expectedHash&&(before?sha256(before):'ABSENT')!==(input.expectedHash.toUpperCase()==='ABSENT'?'ABSENT':input.expectedHash.toLowerCase()))throw new Error('STALE_HASH');
    if(!input.dryRun){await fs.mkdir(path.dirname(target),{recursive:true});await atomicFile(target,bytes,before);}
    return {success:true,path:target,bytes:bytes.length,sha256:sha256(bytes),dryRun:input.dryRun};
  }
  const stat=await fs.lstat(target);
  if(input.action==='delete'){
    if(input.confirmDelete!==true)throw new Error('CONFIRM_DELETE_REQUIRED');
    if(stat.isDirectory()&&!input.recursive&&(await fs.readdir(target)).length)throw new Error('NONEMPTY_DIRECTORY_REQUIRES_RECURSIVE');
    await assertTree(target);
    if(input.dryRun)return {success:true,path:target,dryRun:true,permanent:input.permanent};
    if(input.permanent){await fs.rm(target,{recursive:input.recursive,force:false});return {success:true,path:target,deleted:true,recoverable:false};}
    // Same-volume sibling trash: rename preserves bytes and does not copy then erase a potentially changing tree.
    const trashRoot=path.join(path.dirname(target),'.mcp-trash');
    if(target.toLowerCase()===trashRoot.toLowerCase())throw new Error('TRASH_DELETE_REQUIRES_PERMANENT');
    await assertNoLinks(trashRoot);await fs.mkdir(trashRoot,{recursive:true});
    const trashPath=path.join(trashRoot,randomUUID()+'-'+path.basename(target));
    await assertNoLinks(target);await fs.rename(target,trashPath);
    return {success:true,path:target,deleted:true,recoverable:true,trashPath,nextAction:'Restore with filesystem_manage action=move from trashPath to original path if needed.'};
  }
  if(!input.destination)throw new Error('DESTINATION_REQUIRED');
  const destination=ownerAbsolutePath(input.destination);noRoot(destination);separate(target,destination);await assertNoLinks(destination);
  let existing=false;try{await fs.lstat(destination);existing=true;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  if(existing&&!input.overwrite)throw new Error('DESTINATION_EXISTS');
  if(existing&&stat.isDirectory())throw new Error('DIRECTORY_OVERWRITE_REQUIRES_SEPARATE_DELETE');
  await assertTree(target);
  if(!input.dryRun){await fs.mkdir(path.dirname(destination),{recursive:true});await assertNoLinks(destination);
    if(input.action==='copy')await fs.cp(target,destination,{recursive:input.recursive,force:input.overwrite,errorOnExist:!input.overwrite});
    else await fs.rename(target,destination);
  }
  return {success:true,path:target,destination,action:input.action,dryRun:input.dryRun};
}
export function registerFilesystemManageTool(server:McpServer):void{
  server.registerTool('filesystem_manage',{description:'General filesystem operations for authenticated standing owner: mkdir/stat/copy/move/delete/write_bytes on all paths accessible to Windows account. No project bootstrap, authorizationId, Git baseline or local grant dialog required. Text create/edit uses write_text_file/append_to_file/replace_text_once/apply_patch. delete requires confirmDelete=true; default moves to same-volume .mcp-trash and returns recovery path; permanent=true explicitly removes. Drive/share roots and junction traversal are refused by this helper; PowerShell remains available for owner commands. dryRun previews mutations.',inputSchema:filesystemSchema,annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:true}},async args=>{
    try{return {content:[{type:'text',text:JSON.stringify(await filesystemManage(args))}]};}
    catch(e){return {isError:true,content:[{type:'text',text:JSON.stringify({success:false,error:redactSensitiveData(e instanceof Error?e.message:String(e))})}]};}
  });
}
