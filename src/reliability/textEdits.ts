import { TextDecoder } from 'node:util';
import { isBinaryBuffer, redactSensitiveData, validatePathForTextWrite } from '../security/index.js';
import { performMutation } from './mutations.js';
import { type ToolContext } from './policy.js';
interface Args {
 filePath:string; authorizationId?:string; expectedHash?:string; operationId?:string; dryRun?:boolean;
 text?:string; content?:string; findText?:string; replaceText?:string; createIfMissing?:boolean; overwrite?:boolean; createParents?:boolean;
}
function decode(b:Buffer):string{
 if(b.length>5*1024*1024||isBinaryBuffer(b))throw new Error('UNSUPPORTED_TEXT_FILE');
 return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(b);
}
export async function managedTextEdit(context:ToolContext, action:'append'|'replace'|'write',args:Args){
 try{
  const file=validatePathForTextWrite(args.filePath);
  const payload={text:args.text,content:args.content,findText:args.findText,replaceText:args.replaceText,
   createIfMissing:args.createIfMissing,overwrite:args.overwrite,createParents:args.createParents};
  for(const text of [args.text,args.content,args.findText,args.replaceText]){
   if(text!==undefined && Buffer.from(text,'utf8').toString('utf8')!==text)throw new Error('INVALID_UTF8_INPUT');
  }
  const result=await performMutation(context,{file,action,payload,...args,
   createParents:action==='append'?args.createIfMissing:action==='write'?args.createParents:false},before=>{
   if(before)decode(before);
   if(action==='append'){
    if(!before&&!args.createIfMissing)throw new Error('FILE_MISSING');
    return Buffer.concat([before??Buffer.alloc(0),Buffer.from(args.text??'','utf8')]);
   }
   if(action==='replace'){
    if(!before)throw new Error('FILE_MISSING');
    if(!args.findText)throw new Error('EMPTY_SEARCH_REJECTED');
    const text=decode(before), first=text.indexOf(args.findText);
    if(first<0)throw new Error('SEARCH_NOT_FOUND');
    if(text.indexOf(args.findText,first+args.findText.length)>=0)throw new Error('MULTIPLE_MATCHES');
    return Buffer.from(text.slice(0,first)+(args.replaceText??'')+text.slice(first+args.findText.length),'utf8');
   }
   if(before&&!args.overwrite)throw new Error('FILE_ALREADY_EXISTS');
   return Buffer.from(args.content??'','utf8');
  });
  return {isError:!result.success,content:[{type:'text' as const,text:JSON.stringify(result)}]};
 }catch(error){
  return {isError:true,content:[{type:'text' as const,text:JSON.stringify({success:false,
   operationId:args.operationId,error:redactSensitiveData(error instanceof Error?error.message:String(error)),
   errorLayer:'mutation',commitKnown:false,retryable:false,nextAction:'Check project_profile action=operation_status; do not blind retry.'})}]};
 }
}
