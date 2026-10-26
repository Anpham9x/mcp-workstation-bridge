import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../tools/atomicFile.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
interface Manifest{schemaVersion:number;buildId:string;builtAt:string;sourceHead:string;files:Record<string,string>}
export const startupBuild:Record<string,unknown>=await (async()=>{
 try{
  const raw=JSON.parse(await fs.readFile(path.join(root,'.ai/build-provenance.json'),'utf8')) as Manifest;
  if(raw.schemaVersion!==1||!raw.files||!raw.buildId)throw new Error('Invalid build manifest');
  for(const [relative,expected] of Object.entries(raw.files)){
   if(!/^(src|dist)\//.test(relative)||relative.includes('..')||! /^[a-f0-9]{64}$/.test(expected))throw new Error('Invalid build manifest path/hash');
   if(sha256(await fs.readFile(path.join(root,relative)))!==expected)throw new Error('Build/source hash mismatch: '+relative);
  }
  return {verified:true,buildId:raw.buildId,builtAt:raw.builtAt,sourceHead:raw.sourceHead,verifiedFiles:Object.keys(raw.files).length};
 }catch(e){return {verified:false,error:e instanceof Error?e.message:String(e)};}
})();

