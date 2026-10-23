// Restores the existing fixed-address transport; no deployment or re-pairing.
import fs from 'node:fs';
import path from 'node:path';
import {startRemote} from './remote.mjs';
import {getStateDir,writeSecureJson} from './vendor-auth/config/paths.js';
import {connectSocketRelay} from './relay-socket-client.mjs';

export async function launchSocket(configPath){
  const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
  if(config.tunnel?.mode!=='relay'||config.tunnel?.transport!=='websocket')throw Error('Existing WebSocket relay configuration required');
  const state=getStateDir(),record=path.join(state,'runtime.json');
  if(fs.existsSync(record))throw Error('Existing runtime record: verify ownership before starting');
  fs.mkdirSync(state,{recursive:true});
  const identity={pid:process.pid,parentPid:process.ppid,startedAt:new Date().toISOString(),port:48781,
    workspaceId:config.workspaceId,publicUrl:config.tunnel.publicUrl,mcpUrl:config.tunnel.publicUrl+'/mcp',
    tunnelMode:'relay',configPath,managedTunnel:true,lifecycleRevision:2,relayTransport:'websocket'};
  const stopFile=path.join(state,'stop.request');
  fs.rmSync(stopFile,{force:true});
  let svc,relay,poll,closing=false,stop;
  const stopped=new Promise(resolve=>{stop=resolve;});
  const ownRecord=()=>{try{return JSON.parse(fs.readFileSync(record,'utf8')).pid===process.pid;}catch{return false;}};
  const status=connectionState=>{if(closing)return;writeSecureJson(record,{...identity,connectionState,lastVerifiedAt:new Date().toISOString()});};
  const close=async()=>{if(closing)return;closing=true;clearInterval(poll);relay?.close();if(svc)await svc.close();if(ownRecord())fs.rmSync(record);fs.rmSync(stopFile,{force:true});stop();};
  process.once('SIGINT',()=>{void close();});process.once('SIGTERM',()=>{void close();});
  try{
    svc=await startRemote(config,{port:48781,publicUrl:config.tunnel.publicUrl});
    if(svc.id!==config.workspaceId)throw Error('Existing Commander identity mismatch');
    status('starting');
    relay=connectSocketRelay({...config.tunnel,port:svc.port,workspaceId:svc.id,onState:status});
    poll=setInterval(()=>{if(fs.existsSync(stopFile))void close();},500);
    await relay.ready;
    console.error('Local Commander fixed-address backend ready; existing authentication retained.');
    await Promise.race([relay.done,stopped]);
  }finally{await close();}
}
