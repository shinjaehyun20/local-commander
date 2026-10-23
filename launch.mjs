import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {startRemote} from './remote.mjs';
import {tunnelConfig} from './tunnel-config.mjs';
import {registerRelay} from './relay-client.mjs';
import {getStateDir,writeSecureJson} from './vendor-auth/config/paths.js';
const here=path.dirname(fileURLToPath(import.meta.url));
const state=getStateDir(),runtimeFile=path.join(state,'runtime.json');
const refreshFile=path.join(state,'refresh-pairing.request'),stopFile=path.join(state,'stop.request');
if(process.argv.includes('--socket')) {
  const index=process.argv.indexOf('--config');
  await (await import('./launch-socket.mjs')).launchSocket(index<0?path.join(here,'config.json'):path.resolve(process.argv[index+1]));
} else if(process.argv.includes('--stop') || process.argv.includes('--pair')) {
  if(!fs.existsSync(runtimeFile))throw Error('No recorded Local Commander service');
  fs.writeFileSync(process.argv.includes('--stop')?stopFile:refreshFile,new Date().toISOString());
} else {
  if(fs.existsSync(runtimeFile))throw Error('Existing runtime record: verify it before starting another service');
  fs.mkdirSync(state,{recursive:true});
  fs.rmSync(refreshFile,{force:true});fs.rmSync(stopFile,{force:true});
  const opt=key=>{const i=process.argv.indexOf(key);return i<0?undefined:process.argv[i+1];};
  const port=Number(opt('--port')||48781), config=JSON.parse(fs.readFileSync(opt('--config')||path.join(here,'config.json'),'utf8'));
  const bin=opt('--cloudflared')||'C:/Program Files (x86)/cloudflared/cloudflared.exe';
  // Explicitly invoked deployment helper: the stdio server never opens a tunnel.
  const tunnel=tunnelConfig(config,port);
  const child=spawn(bin,tunnel.args,{stdio:['ignore','pipe','pipe'],windowsHide:true});
  let svc,closed=false,poll;
  const stop=async()=>{
    if(closed)return;closed=true;clearInterval(poll);
    if(svc)await svc.close();
    child.kill('SIGTERM');
    fs.rmSync(runtimeFile,{force:true});fs.rmSync(stopFile,{force:true});
  };
  process.on('SIGINT',()=>{void stop();});process.on('SIGTERM',()=>{void stop();});
  try {
    const upstreamUrl=await new Promise((resolve,reject)=>{
      let buffer='';const deadline=setTimeout(()=>reject(Error('Tunnel address timeout')),45000);
      const scan=data=>{
        buffer=(buffer+data.toString()).slice(-12000);
        const match=buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if(tunnel.mode==='named' && /registered tunnel connection/i.test(buffer)){clearTimeout(deadline);resolve(tunnel.publicUrl);}
        else if(tunnel.mode!=='named' && match){clearTimeout(deadline);resolve(match[0]);}
      };
      child.stdout.on('data',scan);child.stderr.on('data',scan);
      child.once('error',e=>{clearTimeout(deadline);reject(e);});
      child.once('exit',code=>{clearTimeout(deadline);reject(Error(`Tunnel exited ${code}`));});
    });
    const publicUrl=tunnel.publicUrl || upstreamUrl;
    svc=await startRemote(config,{port,publicUrl});
    // Record identity before relay verification so a slow network never spawns
    // a duplicate supervisor. Auth state is independent and stays intact.
    writeSecureJson(runtimeFile,{pid:process.pid,parentPid:process.ppid,tunnelPid:child.pid,startedAt:new Date().toISOString(),port:svc.port,workspaceId:svc.id,publicUrl,mcpUrl:publicUrl+'/mcp',tunnelMode:tunnel.mode,connectionState:'starting',configPath:opt('--config')||path.join(here,'config.json')});
    if(tunnel.mode==='relay')await registerRelay(config.tunnel,upstreamUrl,{service:'local-commander',workspaceId:svc.id});
    writeSecureJson(path.join(state,'pairing.json'),svc.pairing.create());
    writeSecureJson(runtimeFile,{pid:process.pid,parentPid:process.ppid,tunnelPid:child.pid,startedAt:new Date().toISOString(),port:svc.port,workspaceId:svc.id,publicUrl,mcpUrl:publicUrl+'/mcp',tunnelMode:tunnel.mode,connectionState:'ready',configPath:opt('--config')||path.join(here,'config.json')});
    child.once('exit',()=>{void stop();});
    poll=setInterval(()=>{
      if(fs.existsSync(stopFile)){void stop();return;}
      if(fs.existsSync(refreshFile)){fs.rmSync(refreshFile,{force:true});writeSecureJson(path.join(state,'pairing.json'),svc.pairing.create());}
    },500);
    console.error('Local Commander started. Runtime and one-time pairing files are in its local state directory.');
  } catch(e) {await stop();throw e;}
}
