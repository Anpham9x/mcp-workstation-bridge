import fs from 'node:fs';
import { TextDecoder } from 'node:util';
export interface FileRange {filePath:string;startLine:number;endLine:number;maxLines?:number}
export async function boundedRange(file:string,range:FileRange,maxBytes:number,numbered:boolean,scanLimit=5*1024*1024){
 if(!Number.isInteger(range.startLine)||!Number.isInteger(range.endLine)||range.startLine<1||range.endLine<range.startLine)throw new Error('INVALID_RANGE');
 const stream=fs.createReadStream(file,{highWaterMark:16*1024,end:scanLimit-1});
 let readBytes=0,returnedBytes=0,line=0,carry=Buffer.alloc(0),truncated=false,reachedEnd=false;
 const output:string[]=[];
 const add=(b:Buffer)=>{
  line++;
  if(line<range.startLine)return true;
  if(line>range.endLine){reachedEnd=true;return false;}
  const text=new TextDecoder('utf8',{fatal:true}).decode(b).replace(/\r$/,'');
  const value=(numbered?line+': ':'')+text;
  const bytes=Buffer.byteLength(value)+(output.length?1:0);
  if(returnedBytes+bytes>maxBytes||output.length>=(range.maxLines??1000)){truncated=true;return false;}
  output.push(value);returnedBytes+=bytes;
  if(line===range.endLine){reachedEnd=true;return false;}
  return true;
 };
 try{
  outer:for await(const chunk of stream){
   const bytes=chunk as Buffer;readBytes+=bytes.length;
   if(bytes.includes(0))throw new Error('BINARY_FILE');
   if(readBytes>scanLimit){truncated=true;break;}
   carry=Buffer.concat([carry,bytes]);
   let idx:number;
   while((idx=carry.indexOf(10))>=0){
    const b=carry.subarray(0,idx);carry=carry.subarray(idx+1);
    if(!add(b))break outer;
   }
   if(carry.length>Math.min(maxBytes,1024*1024)){truncated=true;break;}
  }
  if(!reachedEnd&&readBytes>=scanLimit&&(await fs.promises.stat(file)).size>scanLimit)truncated=true;
  if(!reachedEnd&&!truncated&&carry.length)add(carry);
 }finally{stream.destroy();}
 return {content:output.join('\n'),truncated,readBytes,returnedBytes,linesRead:output.length,
   requestedRange:range,rangeComplete:reachedEnd,scanLimitBytes:scanLimit};
}

