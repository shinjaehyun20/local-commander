import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker,{validUpstream} from '../relay-worker.mjs';
const secret='fixture-'.repeat(8),upstream='https://owned-fixture.trycloudflare.com';
const env={UPDATE_SECRET:secret,SERVICE:'fixture-service',WORKSPACE_ID:'fixture',ORIGIN:{async get(){return upstream;},async put(){throw Error('unexpected mutation');}}};
test('relay refuses registration without update credential',async()=>{
  assert.equal((await worker.fetch(new Request('https://fixed.example/_relay/register',{method:'POST',body:JSON.stringify({upstream})}),env)).status,401);
});
test('relay rejects localhost, credentials, paths and arbitrary origins',()=>{
  for(const origin of ['http://127.0.0.1:48781','https://user:pass@abc.trycloudflare.com','https://example.com','https://abc.trycloudflare.com/path','https://abc.trycloudflare.com.evil.example'])assert.equal(validUpstream(origin),false);
  assert.equal(validUpstream(upstream),true);
});
test('relay never exposes admin endpoints or arbitrary proxy targets',async()=>{
  for(const route of ['/admin/info','/admin/shutdown','/config.json','/_relay/anything'])assert.equal((await worker.fetch(new Request('https://fixed.example'+route),env)).status,404);
});
test('relay checks service identity before changing origin',async()=>{
  const original=globalThis.fetch;let written=false;
  globalThis.fetch=async()=>Response.json({service:'other',workspaceId:'fixture'});
  try{
    const result=await worker.fetch(new Request('https://fixed.example/_relay/register',{method:'POST',headers:{authorization:'Bearer '+secret},body:JSON.stringify({upstream})}),{...env,ORIGIN:{async put(){written=true;}}});
    assert.equal(result.status,409);assert.equal(written,false);
  }finally{globalThis.fetch=original;}
});
test('relay forwards OAuth and bearer headers without leaking update credential',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    assert.equal(String(url),upstream+'/mcp');assert.equal(options.headers.get('authorization'),'Bearer client-token');assert.equal(options.headers.get('cookie'),null);
    return new Response('fixture-response',{headers:{'www-authenticate':'Bearer resource_metadata="https://fixed.example/.well-known/oauth-protected-resource/mcp"'}});
  };
  try{
    const result=await worker.fetch(new Request('https://fixed.example/mcp',{method:'POST',headers:{authorization:'Bearer client-token',cookie:'private-cookie'},body:'fixture-request'}),env);
    assert.equal(await result.text(),'fixture-response');assert.equal(result.headers.get('cache-control'),'no-store');
  }finally{globalThis.fetch=original;}
});
