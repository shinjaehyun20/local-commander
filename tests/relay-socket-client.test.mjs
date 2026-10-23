import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {WebSocketServer} from 'ws';
import {validateRequest,forwardRequest,connectSocketRelay} from '../relay-socket-client.mjs';

const message=(extra={})=>({type:'http',id:randomUUID(),method:'GET',path:'/health',headers:[],body:null,...extra});
test('socket relay accepts only deployed routes, bounded bodies, and valid headers',()=>{
  assert.equal(validateRequest(message()).path,'/health');
  for(const p of ['//example.com/health','/admin','/mcp%0d%0ax:1','/\\example.com/mcp'])assert.throws(()=>validateRequest(message({path:p})));
  assert.throws(()=>validateRequest(message({headers:[['authorization','a\r\nb']]})));
  assert.throws(()=>validateRequest(message({body:'***'})));
  assert.throws(()=>validateRequest(message({body:Buffer.alloc(2*1024*1024+1).toString('base64')})));
  assert.throws(()=>validateRequest(message({method:'CONNECT'})));
});
test('socket forwarding preserves OAuth header and body, strips cookies, and never retries writes',async()=>{
  let received=0;
  const server=http.createServer((req,res)=>{
    received++;
    assert.equal(req.url,'/mcp');assert.equal(req.headers.authorization,'Bearer TEST_OAUTH');assert.equal(req.headers.cookie,undefined);
    let body='';req.on('data',chunk=>{body+=chunk;});req.on('end',()=>{
      assert.equal(body,'{"method":"tools/call"}');res.setHeader('set-cookie','must-not-forward');res.setHeader('content-type','application/json');res.end('{"ok":true}');
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const result=await forwardRequest(message({method:'POST',path:'/mcp',headers:[['authorization','Bearer TEST_OAUTH'],['cookie','private'],['content-type','application/json']],body:Buffer.from('{"method":"tools/call"}').toString('base64')}),server.address().port);
    assert.equal(result.status,200);assert.equal(Buffer.from(result.body,'base64').toString(),'{"ok":true}');
    assert.ok(!result.headers.some(([key])=>key.toLowerCase()==='set-cookie'));assert.equal(received,1);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
test('socket transport cannot turn a read request into an unauthenticated MCP write',async()=>{
  const server=http.createServer((req,res)=>{res.writeHead(req.headers.authorization?200:401);res.end('AUTH_REQUIRED');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{assert.equal((await forwardRequest(message({path:'/mcp',method:'POST'}),server.address().port)).status,401);}
  finally{await new Promise(resolve=>server.close(resolve));}
});
test('socket relay reconnects automatically after disconnect and forwards requests on new session',async()=>{
  const tmpDir=fs.mkdtempSync(path.join(os.tmpdir(),'relay-ws-test-'));
  const secretFile=path.join(tmpDir,'relay.secret');
  const secret='a'.repeat(48);
  fs.writeFileSync(secretFile,secret);
  const localHttp=http.createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end('{"health":"ok"}');});
  await new Promise(resolve=>localHttp.listen(0,'127.0.0.1',resolve));
  const wss=new WebSocketServer({port:0,host:'127.0.0.1'});
  await new Promise(resolve=>wss.once('listening',resolve));
  const states=[];
  let connections=0;
  let secondSocketResolve;
  const secondSocketResult=new Promise(resolve=>{secondSocketResolve=resolve;});
  wss.on('connection',(ws,req)=>{
    connections++;
    assert.equal(req.headers.authorization,`Bearer ${secret}`);
    ws.send(JSON.stringify({type:'ready',service:'local-commander',workspaceId:'1234567890ab'}));
    if(connections===1){
      setTimeout(()=>ws.close(1001,'Simulated network drop'),30);
    }else if(connections===2){
      ws.on('message',data=>{
        const parsed=JSON.parse(data.toString('utf8'));
        if(parsed.type==='http-result')secondSocketResolve(parsed);
      });
      setTimeout(()=>{
        ws.send(JSON.stringify(message({path:'/health'})));
      },20);
    }
  });
  const relay=connectSocketRelay({
    publicUrl:'https://relay.example.com',
    secretFile,
    port:localHttp.address().port,
    workspaceId:'1234567890ab',
    wsUrl:`ws://127.0.0.1:${wss.address().port}/_relay/connect`,
    backoffDelays:[20,40,80],
    onState:s=>states.push(s),
  });
  try{
    await relay.ready;
    const forwarded=await secondSocketResult;
    assert.equal(forwarded.status,200);
    assert.equal(Buffer.from(forwarded.body,'base64').toString('utf8'),'{"health":"ok"}');
    assert.ok(connections>=2);
    assert.ok(states.includes('disconnected'));
    assert.equal(states[states.length-1],'ready');
  }finally{
    relay.close();
    await new Promise(resolve=>wss.close(resolve));
    await new Promise(resolve=>localHttp.close(resolve));
    fs.rmSync(tmpDir,{recursive:true,force:true});
  }
});
test('socket relay transitions to failed after exhausting reconnect attempts',async()=>{
  const tmpDir=fs.mkdtempSync(path.join(os.tmpdir(),'relay-exhaust-test-'));
  const secretFile=path.join(tmpDir,'relay.secret');
  fs.writeFileSync(secretFile,'b'.repeat(48));
  const wss=new WebSocketServer({port:0,host:'127.0.0.1'});
  await new Promise(resolve=>wss.once('listening',resolve));
  const states=[];
  let attempts=0;
  wss.on('connection',ws=>{
    attempts++;
    if(attempts===1){
      ws.send(JSON.stringify({type:'ready',service:'local-commander',workspaceId:'1234567890ab'}));
      setTimeout(()=>ws.close(1011,'Drop 1'),15);
    }else{
      setTimeout(()=>ws.close(1011,'Still down'),10);
    }
  });
  const relay=connectSocketRelay({
    publicUrl:'https://relay.example.com',
    secretFile,
    port:65530,
    workspaceId:'1234567890ab',
    wsUrl:`ws://127.0.0.1:${wss.address().port}/_relay/connect`,
    backoffDelays:[15,15,15],
    onState:s=>states.push(s),
  });
  try{
    await relay.ready;
    await assert.rejects(relay.done,/Relay reconnect attempts exhausted/);
    assert.equal(attempts,4);
    assert.equal(states[states.length-1],'failed');
  }finally{
    relay.close();
    await new Promise(resolve=>wss.close(resolve));
    fs.rmSync(tmpDir,{recursive:true,force:true});
  }
});
