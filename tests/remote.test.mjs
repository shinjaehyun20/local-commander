import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,createHash} from 'node:crypto';
import {startRemote} from '../remote.mjs';
import {dependency} from '../deps.mjs';
import {AuthStore,filterScopes} from '../vendor-auth/auth/store.js';
import {writeSecureJson} from '../vendor-auth/config/paths.js';
const here=path.dirname(fileURLToPath(import.meta.url));
const work=path.resolve(here,'../.work');fs.mkdirSync(work,{recursive:true});
const fixture=fs.mkdtempSync(path.join(work,'commander-oauth-'));
const root=path.join(fixture,'root');fs.mkdirSync(root);fs.writeFileSync(path.join(root,'fixture.txt'),'OAuth acceptance');
const config={readRoots:[root],writeRoots:[root],allowShell:true,allowRemoteWrites:true,python:process.env.COMMANDER_PYTHON || 'python'};
let svc,base;
test.before(async()=>{svc=await startRemote(config,{authFile:path.join(fixture,'auth.json')});base=`http://127.0.0.1:${svc.port}`;});
const form=(values)=>({method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(values),redirect:'manual'});
async function authorize(scope,wrongVerifier=false){
  const registration=await (await fetch(base+'/oauth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'fixture',redirect_uris:['http://localhost/callback']})})).json();
  const verifier=randomBytes(32).toString('base64url');
  const challenge=createHash('sha256').update(verifier).digest('base64url');
  const query=new URLSearchParams({response_type:'code',client_id:registration.client_id,redirect_uri:'http://localhost/callback',scope,code_challenge:challenge,code_challenge_method:'S256',resource:base+'/mcp',state:'fixture-state'});
  const html=await (await fetch(base+'/oauth/authorize?'+query)).text();
  const id=html.match(/name="request_id" value="([^"]+)"/)[1];
  const pair=svc.pairing.create();
  const response=await fetch(base+'/oauth/authorize',form({request_id:id,pairing_code:pair.code}));
  assert.equal(response.status,302);
  const callback=new URL(response.headers.get('location'));assert.equal(callback.searchParams.get('state'),'fixture-state');
  const tokenResponse=await fetch(base+'/oauth/token',form({grant_type:'authorization_code',code:callback.searchParams.get('code'),code_verifier:wrongVerifier?'wrong':verifier,client_id:registration.client_id,redirect_uri:'http://localhost/callback'}));
  return {status:tokenResponse.status,body:await tokenResponse.json(),clientId:registration.client_id};
}
test('OAuth metadata identifies self-hosted scopes',async()=>{
  const metadata=await(await fetch(base+'/.well-known/oauth-authorization-server')).json();
  assert.equal(metadata.issuer,base);assert.ok(metadata.scopes_supported.includes('process.execute'));
  assert.equal((await fetch(base+'/mcp',{method:'POST'})).status,401);
});
test('unknown requested scopes never expand to all privileges',()=>{
  assert.deepEqual(filterScopes('unknown.permission'),[]);
  assert.deepEqual(filterScopes('desktop.read unknown.permission'),['desktop.read']);
});
test('PKCE mismatch fails without issuing access token',async()=>{
  const result=await authorize('desktop.read',true);assert.equal(result.status,400);assert.equal(result.body.error,'invalid_grant');
});
test('readonly token cannot edit or run commands',async()=>{
  const result=await authorize('desktop.read');assert.equal(result.status,200);
  const response=await fetch(base+'/mcp',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+result.body.access_token},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'write_file',arguments:{path:'denied.txt',content:'bad'}}})});
  assert.equal(response.status,403);assert.equal(fs.existsSync(path.join(root,'denied.txt')),false);
});
test('OAuth official client performs read, write and execution; refresh and revocation work',async()=>{
  const result=await authorize('desktop.read desktop.write process.execute offline_access');assert.equal(result.status,200);
  const {Client}=await dependency('@modelcontextprotocol/sdk/client/index.js');
  const {StreamableHTTPClientTransport}=await dependency('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client=new Client({name:'remote-fixture',version:'1'});
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+result.body.access_token}}}));
    assert.equal((await client.listTools()).tools.length,16);
    const read=await client.callTool({name:'read_file',arguments:{path:'fixture.txt'}});assert.match(read.content[0].text,/OAuth acceptance/);
    const write=await client.callTool({name:'write_file',arguments:{path:'created.txt',content:'remote write'}});assert.equal(write.isError,undefined);assert.equal(fs.readFileSync(path.join(root,'created.txt'),'utf8'),'remote write');
    const processResult=await client.callTool({name:'start_process',arguments:{executable:process.execPath,args:['-e',"console.log('remote execution')"],waitMs:1000}});
    const p=JSON.parse(processResult.content[0].text);await svc.engine.session(p.sessionId).done;assert.equal(svc.engine.session(p.sessionId).exitCode,0);
  } finally {await client.close();}
  const refresh=await fetch(base+'/oauth/token',form({grant_type:'refresh_token',refresh_token:result.body.refresh_token,client_id:result.clientId}));assert.equal(refresh.status,200);
  const fresh=await refresh.json();assert.notEqual(fresh.access_token,result.body.access_token);
  const replay=await fetch(base+'/oauth/token',form({grant_type:'refresh_token',refresh_token:result.body.refresh_token,client_id:result.clientId}));assert.equal(replay.status,400);
  await fetch(base+'/oauth/revoke',form({token:fresh.access_token}));
  const rejected=await fetch(base+'/mcp',{method:'POST',headers:{authorization:'Bearer '+fresh.access_token}});assert.equal(rejected.status,401);
});
test('root expansion with explicit identity preserves OAuth token and refresh without pairing again',async()=>{
  const token=await authorize('desktop.read offline_access');assert.equal(token.status,200);
  const port=svc.port;
  const id=svc.id, extraRoot=path.join(fixture,'extra-root');fs.mkdirSync(extraRoot);fs.writeFileSync(path.join(extraRoot,'new-root.txt'),'ROOT_EXPANSION_OK');
  await svc.close();
  // Let the client's pooled sockets observe server shutdown before reconnecting.
  await new Promise(resolve=>setTimeout(resolve,100));
  svc=await startRemote({...config,workspaceId:id,readRoots:[...config.readRoots,extraRoot],writeRoots:[...config.writeRoots,extraRoot]},{port,authFile:path.join(fixture,'auth.json')});
  assert.equal(svc.id,id);
  assert.equal(svc.port,port);
  assert.equal((await(await fetch(base+'/.well-known/oauth-authorization-server')).json()).issuer,base);
  const {Client}=await dependency('@modelcontextprotocol/sdk/client/index.js');
  const {StreamableHTTPClientTransport}=await dependency('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client=new Client({name:'restart-fixture',version:'1'});
  try{
    await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+token.body.access_token}}}));
    const read=await client.callTool({name:'read_file',arguments:{path:'fixture.txt'}});assert.match(read.content[0].text,/OAuth acceptance/);
    const extra=await client.callTool({name:'read_file',arguments:{path:path.join(extraRoot,'new-root.txt')}});assert.match(extra.content[0].text,/ROOT_EXPANSION_OK/);
  }finally{await client.close();}
  const refresh=await fetch(base+'/oauth/token',form({grant_type:'refresh_token',refresh_token:token.body.refresh_token,client_id:token.clientId}));
  assert.equal(refresh.status,200);
});
test('corrupt auth state file is preserved and rejected instead of silently resetting, and writes are atomic',()=>{
  const corruptDir=fs.mkdtempSync(path.join(fixture,'corrupt-check-'));
  const authPath=path.join(corruptDir,'auth.json');
  fs.writeFileSync(authPath,'{"clients":[{"clientId":"broken"');
  assert.throws(()=>new AuthStore('1234567890ab',{file:authPath}),/Corrupt JSON in state file/);
  const files=fs.readdirSync(corruptDir);
  const backups=files.filter(f=>f.startsWith('auth.json.corrupt-'));
  assert.equal(backups.length,1);
  assert.equal(fs.readFileSync(path.join(corruptDir,backups[0]),'utf8'),'{"clients":[{"clientId":"broken"');
  assert.equal(fs.readFileSync(authPath,'utf8'),'{"clients":[{"clientId":"broken"');

  const atomicPath=path.join(corruptDir,'atomic.json');
  writeSecureJson(atomicPath,{ok:true,step:1});
  writeSecureJson(atomicPath,{ok:true,step:2});
  assert.deepEqual(JSON.parse(fs.readFileSync(atomicPath,'utf8')),{ok:true,step:2});
  assert.deepEqual(fs.readdirSync(corruptDir).filter(f=>f.includes('.tmp-')),[]);
});
test.after(async()=>{await svc.close();assert.ok(path.relative(work,fixture).startsWith('commander-oauth-'));fs.rmSync(fixture,{recursive:true,force:true});});
