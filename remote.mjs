import path from 'node:path';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {dependency} from './deps.mjs';
import {Commander} from './core.mjs';
import {makeServer} from './server.mjs';
import {AuthStore} from './vendor-auth/auth/store.js';
import {createOAuthRouter} from './vendor-auth/auth/oauth.js';
import {bearerAuth} from './vendor-auth/auth/middleware.js';
import {PairingManager} from './vendor-auth/pairing/manager.js';
import {writeSecureJson,getStateDir} from './vendor-auth/config/paths.js';
const express=(await dependency('express')).default;
const {StreamableHTTPServerTransport}=await dependency('@modelcontextprotocol/sdk/server/streamableHttp.js');
const logger={info(){},warn(){},error(){},debug(){}};
export async function startRemote(config,{port=0,publicUrl,authFile}={}){
  const engine=new Commander(config);
  const id=config.workspaceId ?? createHash('sha256').update(JSON.stringify(engine.readRoots)).digest('hex').slice(0,12);
  if(!/^[a-f0-9]{12}$/.test(id))throw Error('workspaceId must be a 12-character hexadecimal identity');
  const store=new AuthStore(id,{file:authFile});
  const pairing=new PairingManager(id);
  const app=express();app.disable('x-powered-by');
  let boundPort;
  const base=()=>publicUrl || `http://127.0.0.1:${boundPort}`;
  if(publicUrl && (!publicUrl.startsWith('https://') || new URL(publicUrl).pathname!=='/'))throw Error('Public URL must be an HTTPS origin');
  app.get('/health',(_req,res)=>res.json({service:'local-commander',workspaceId:id,status:'ok',remoteWrites:!!config.allowRemoteWrites}));
  app.use(createOAuthRouter({store,pairing,workspaceName:config.name||'Local Commander',getBaseUrl:base,logger}));
  const mutable=new Set(['write_file','edit_block','create_directory','start_process','interact_with_process','force_terminate']);
  const commands=new Set(['start_process','interact_with_process','force_terminate']);
  app.all('/mcp',express.json({limit:'2mb'}),bearerAuth({store,workspaceId:id,getBaseUrl:base,logger}),async(req,res)=>{
    const method=req.body?.method, name=req.body?.params?.name;
    if(method==='tools/call'){
      const needed=commands.has(name)?'process.execute':mutable.has(name)?'desktop.write':'desktop.read';
      if(!req.auth?.scopes.includes(needed)){res.status(403).json({error:'insufficient_scope'});return;}
    }
    const mcp=makeServer(engine,{readOnly:!config.allowRemoteWrites});
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    res.on('close',()=>{void transport.close();void mcp.close();});
    try{await mcp.connect(transport);await transport.handleRequest(req,res,req.body);}
    catch{if(!res.headersSent)res.status(500).json({error:'MCP request failed'});}
  });
  const server=await new Promise((resolve,reject)=>{const s=app.listen(port,'127.0.0.1',()=>resolve(s));s.once('error',reject);});
  boundPort=server.address().port;
  return {port:boundPort,store,pairing,engine,id,close:async()=>{await engine.close();await new Promise(r=>{server.close(r);server.closeAllConnections();});}};
}
async function main(){
  const args=process.argv.slice(2),opt=key=>{const i=args.indexOf(key);return i<0?undefined:args[i+1];};
  const config=JSON.parse(fs.readFileSync(path.resolve(opt('--config')||'config.json'),'utf8'));
  const svc=await startRemote(config,{port:Number(opt('--port')||48781),publicUrl:opt('--public-url')});
  const runtime=path.join(getStateDir(),'runtime.json'), pairFile=path.join(getStateDir(),'pairing.json');
  writeSecureJson(runtime,{pid:process.pid,startedAt:new Date().toISOString(),port:svc.port,workspaceId:svc.id});
  // The one-time pairing code is saved locally; never emit persistent tokens.
  writeSecureJson(pairFile,svc.pairing.create());
  console.error(`Local Commander OAuth server ready at 127.0.0.1:${svc.port}; pairing file: ${pairFile}`);
  const stop=async()=>{await svc.close();fs.rmSync(runtime,{force:true});process.exit(0);};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
