import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
process.chdir(root);
try { loadEnvFile(path.join(root,'.env')); } catch(error) { if(error.code!=='ENOENT') throw error; }
const runtime=path.join(root,'.runtime');
const stateFile=path.join(runtime,'supervisor.json');
const logDir=path.join(root,'logs');
const command=process.argv[2] || 'help';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function readState(){try{return JSON.parse(await fs.readFile(stateFile,'utf8'));}catch{return null;}}
async function control(action){
  const state=await readState();
  if(!state) throw new Error('Bridge is not managed by this CLI. Run: npm run bridge -- start');
  const response=await fetch(`http://127.0.0.1:${state.controlPort}/${action}`,{
    method:'POST',headers:{Authorization:'Bearer '+state.token},signal:AbortSignal.timeout(5000)
  });
  if(!response.ok)throw new Error('Supervisor rejected request: '+response.status);
  return response.json();
}
async function portInUse(port){return new Promise(resolve=>{
  const socket=net.connect({host:'127.0.0.1',port});
  socket.setTimeout(500);
  const finish=value=>{socket.destroy();resolve(value);};
  socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));socket.once('timeout',()=>finish(false));
});}
async function supervise(){
  const port=Number(process.env.PORT || 3011);
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('PORT must be 1024..65535');
  if(await portInUse(port))throw new Error('Port already occupied; refusing to adopt or stop another process');
  await fs.access(path.join(root,'dist/server.js'));
  const token=randomBytes(32).toString('hex');
  let child, timer, stopping=false, failures=0, startedAt=0, lastExit=null, generation=0;
  const launch=()=>{
    if(stopping)return;
    generation++;
    startedAt=Date.now();
    child=spawn(process.execPath,['scripts/start-local.mjs'],{
      cwd:root,env:{...process.env,PORT:String(port)},windowsHide:true,stdio:['ignore','inherit','inherit']
    });
    child.once('error',error=>console.error('Runtime spawn:',error.message));
    child.once('exit',(code,signal)=>{
      lastExit={code,signal,at:new Date().toISOString()};child=null;
      if(stopping)return;
      failures=Date.now()-startedAt>60000?0:failures+1;
      const backoff=Math.min(30000,1000*2**Math.min(failures,5));
      console.error('Runtime exited; retry in '+backoff+'ms',lastExit);
      timer=setTimeout(launch,backoff);
    });
  };
  async function haltChild(){
    clearTimeout(timer);
    const current=child;
    if(!current)return;
    await new Promise(resolve=>{current.once('exit',resolve);current.kill();});
  }
  const server=http.createServer(async(req,res)=>{
    const supplied=Buffer.from(req.headers.authorization || '');
    const expected=Buffer.from('Bearer '+token);
    if(req.method!=='POST'||supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){
      res.writeHead(403);res.end();return;
    }
    const send=body=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body));};
    if(req.url==='/status'){send({supervisorPid:process.pid,runtimePid:child?.pid??null,generation,port,running:!!child,lastExit});return;}
    if(req.url!=='/stop'&&req.url!=='/restart'){res.writeHead(404);res.end();return;}
    if(stopping){res.writeHead(409);res.end();return;}
    stopping=true;
    try{
      await haltChild();
      if(req.url==='/restart'){stopping=false;failures=0;launch();send({restarting:true});}
      else{await fs.unlink(stateFile).catch(()=>{});send({stopped:true});server.close();}
    }catch(error){res.writeHead(500);res.end(JSON.stringify({error:error.message}));}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  await fs.writeFile(stateFile,JSON.stringify({controlPort:server.address().port,token}),{mode:0o600});
  const shutdown=async()=>{if(stopping)return;stopping=true;await haltChild();await fs.unlink(stateFile).catch(()=>{});server.close();};
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
  launch();
}
async function start(){
  await fs.mkdir(runtime,{recursive:true});await fs.mkdir(logDir,{recursive:true});
  const lock=await fs.open(path.join(runtime,'start.lock'),'wx').catch(()=>{throw new Error('Another start is in progress. If it crashed, remove .runtime/start.lock and retry.');});
  try{
    try{const status=await control('status');console.log(JSON.stringify(status));return;}catch{}
    await fs.unlink(stateFile).catch(()=>{});
    await fs.access(path.join(root,'dist/server.js')).catch(()=>{throw new Error('Build first: npm ci && npm run build');});
    const log=await fs.open(path.join(logDir,'supervisor.log'),'a');
    const supervisor=spawn(process.execPath,[fileURLToPath(import.meta.url),'__supervise'],{
      cwd:root,detached:true,windowsHide:true,stdio:['ignore',log.fd,log.fd],env:process.env
    });
    let spawnError;
    supervisor.once('error',error=>{spawnError=error;});supervisor.unref();await log.close();
    for(let attempt=0;attempt<40;attempt++){
      if(spawnError)throw spawnError;
      await delay(250);
      try{const status=await control('status');if(status.running&&await portInUse(status.port)){console.log(JSON.stringify(status));return;}}catch{}
    }
    // A failed start must not leave a retrying daemon behind.
    try{await control('stop');}catch{}
    throw new Error('Startup failed; inspect logs/supervisor.log');
  }finally{await lock.close();await fs.unlink(path.join(runtime,'start.lock')).catch(()=>{});}
}
try{
  if(command==='__supervise')await supervise();
  else if(command==='start')await start();
  else if(['status','restart','stop'].includes(command))console.log(JSON.stringify(await control(command)));
  else if(command==='help')console.log('npm run bridge -- start|status|restart|stop\nLogs: logs/supervisor.log. Auto-retry: 2..30 seconds.');
  else throw new Error('Unknown command. Use start, status, restart or stop.');
}catch(error){console.error(error.message);process.exitCode=1;}
