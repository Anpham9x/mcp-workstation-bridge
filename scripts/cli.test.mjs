// Integration test: isolated loopback port, no Scheduled Task or desktop actions.
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile);
const reservation=net.createServer();
await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
const port=reservation.address().port;
await new Promise(resolve=>reservation.close(resolve));
const env={...process.env,PORT:String(port),MCP_LOCAL_URL:`http://127.0.0.1:${port}/mcp`,MCP_DESKTOP_INDICATOR_ENABLED:'false'};
// Refuse to touch a real supervisor belonging to the user's checkout.
try{await fs.access('.runtime/supervisor.json');throw new Error('Stop the existing CLI supervisor before running this isolated test');}
catch(error){if(error.code!=='ENOENT')throw error;}
const run=(...args)=>exec(process.execPath,args,{env,timeout:20000,windowsHide:true});
const cli=async action=>JSON.parse((await run('scripts/bridge.mjs',action)).stdout);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function ready(){
  let last;
  for(let n=0;n<35;n++){
    try{await run('scripts/check-local-mcp.mjs');return;}catch(error){last=error;await delay(300);}
  }
  throw last;
}
let ownsSupervisor=false;
try{
  const first=await cli('start');assert.equal(first.port,port);ownsSupervisor=true;await ready();
  const again=await cli('start');assert.equal(again.supervisorPid,first.supervisorPid);
  const state=JSON.parse(await fs.readFile('.runtime/supervisor.json','utf8'));
  const denied=await fetch(`http://127.0.0.1:${state.controlPort}/stop`,{method:'POST'});
  assert.equal(denied.status,403);
  await cli('restart');await ready();
  const restarted=await cli('status');assert.ok(restarted.generation>first.generation);
  process.kill(restarted.runtimePid); // Only the child returned by our own authenticated supervisor.
  let recovered;
  for(let attempt=0;attempt<45;attempt++){
    await delay(300);recovered=await cli('status');
    if(recovered.runtimePid&&recovered.generation>restarted.generation)break;
  }
  assert.ok(recovered.runtimePid);assert.ok(recovered.generation>restarted.generation);await ready();
  assert.equal((await cli('stop')).stopped,true);
  await assert.rejects(cli('status'));
  await delay(300);
  const foreign=net.createServer();
  await new Promise(resolve=>foreign.listen(port,'127.0.0.1',resolve));
  try{await assert.rejects(cli('start'));assert.equal(foreign.listening,true);}
  finally{await new Promise(resolve=>foreign.close(resolve));}
  console.log('CLI PASS: start, idempotent start, MCP catalog, auth, restart, crash recovery, stop, foreign-port refusal');
}finally{if(ownsSupervisor){try{await cli('stop');}catch{}}}
