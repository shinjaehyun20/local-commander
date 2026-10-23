// Compatibility with the existing deployed CommanderSocketRelay (protocol v1).
// The relay credential authenticates only this channel, never an MCP request.
import fs from 'node:fs';
import http from 'node:http';
import WebSocket from 'ws';

const routes=new Set(['/health','/mcp','/oauth/authorize','/oauth/register','/oauth/token','/oauth/revoke',
  '/.well-known/oauth-authorization-server','/.well-known/oauth-authorization-server/mcp',
  '/.well-known/openid-configuration','/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp']);
const methods=new Set(['GET','HEAD','POST','DELETE','OPTIONS']);
const hop=new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer',
  'transfer-encoding','upgrade','host','cookie','set-cookie','content-length']);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const bodyLimit=2*1024*1024,responseLimit=4*1024*1024;

export function validateRequest(value){
  if(!value || value.type!=='http' || !uuid.test(value.id) || !methods.has(value.method))throw Error('Invalid relay request');
  if(typeof value.path!=='string' || !value.path.startsWith('/') || value.path.startsWith('//') || /[\\\r\n\0]|%0[ad0]/i.test(value.path))throw Error('Invalid relay path');
  const url=new URL(value.path,'http://127.0.0.1');
  if(url.origin!=='http://127.0.0.1' || !routes.has(url.pathname))throw Error('Relay route excluded');
  if(!Array.isArray(value.headers) || value.headers.length>128)throw Error('Invalid relay headers');
  const headers={};
  for(const pair of value.headers){
    if(!Array.isArray(pair)||pair.length!==2||pair.some(x=>typeof x!=='string'))throw Error('Invalid relay headers');
    const [key,text]=pair;
    if(!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(key)||/[\r\n\0]/.test(text))throw Error('Invalid relay headers');
    if(!hop.has(key.toLowerCase()))headers[key]=text;
  }
  let body=Buffer.alloc(0);
  if(value.body!==null && value.body!==undefined){
    if(typeof value.body!=='string' || value.body.length>Math.ceil(bodyLimit/3)*4)throw Error('Relay body too large');
    body=Buffer.from(value.body,'base64');
    if(body.length>bodyLimit || body.toString('base64')!==value.body)throw Error('Invalid relay body');
  }
  return {...value,headers,body};
}

export function forwardRequest(value,port,{signal}={}){
  const request=validateRequest(value);
  return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,method:request.method,path:request.path,
      headers:request.headers,signal,timeout:25000},res=>{
      const chunks=[];let size=0;
      res.on('data',chunk=>{size+=chunk.length;if(size>responseLimit)res.destroy(Error('Relay response too large'));else chunks.push(chunk);});
      res.on('error',reject);
      res.on('end',()=>resolve({type:'http-result',id:request.id,status:res.statusCode,
        headers:Object.entries(res.headers).filter(([k])=>!hop.has(k.toLowerCase())).flatMap(([k,v])=>(Array.isArray(v)?v:[v]).filter(v=>v!==undefined).map(v=>[k,String(v)])),
        body:Buffer.concat(chunks).toString('base64')}));
    });
    req.on('timeout',()=>req.destroy(Error('Relay request timeout')));
    req.on('error',reject);
    req.end(request.body);
  });
}

export function connectSocketRelay({publicUrl,secretFile,port,workspaceId,onState=()=>{},wsUrl,backoffDelays=[1000,3000,10000]}){
  const origin=new URL(publicUrl);
  if(origin.protocol!=='https:' || origin.pathname!=='/' || origin.search || origin.hash || origin.username || origin.password)throw Error('Fixed HTTPS relay required');
  const secret=fs.readFileSync(secretFile,'utf8').trim();
  if(secret.length<40)throw Error('Missing existing relay credential');
  const url=wsUrl ? new URL(wsUrl) : (()=>{const u=new URL('/_relay/connect',origin);u.protocol='wss:';return u;})();
  let stopped=false,socket,timer,heartbeat,retry=0,readySettled=false;
  const active=new Map(),completed=new Set();
  let readyResolve,readyReject,doneResolve,doneReject;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const done=new Promise((resolve,reject)=>{doneResolve=resolve;doneReject=reject;});
  // Callers may still be waiting for ready when a terminal error occurs.
  done.catch(()=>{});
  function clearRequests(){for(const controller of active.values())controller.abort();active.clear();completed.clear();}
  function fail(error){if(stopped)return;stopped=true;clearTimeout(timer);clearInterval(heartbeat);clearRequests();socket?.terminate();onState('failed');if(!readySettled){readySettled=true;readyReject(error);}doneReject(error);}
  function connect(){
    if(stopped)return;
    onState('connecting');
    socket=new WebSocket(url,{headers:{authorization:'Bearer '+secret},handshakeTimeout:10000,maxPayload:8*1024*1024,perMessageDeflate:false,followRedirects:false});
    const current=socket;
    let lastSeen=Date.now(),confirmed=false,terminal=false;
    timer=setTimeout(()=>current.terminate(),15000);
    current.on('unexpected-response',(_req,res)=>{terminal=true;res.resume();fail(Error('Relay handshake rejected: HTTP '+res.statusCode));});
    current.on('error',()=>{});
    current.on('message',async(data,binary)=>{
      if(stopped||current!==socket)return;
      lastSeen=Date.now();
      if(binary){current.close(1008,'Text protocol required');return;}
      const text=data.toString('utf8');
      if(text==='ping'){current.send('pong');return;}
      if(text==='pong')return;
      let message;try{message=JSON.parse(text);}catch{current.close(1008,'Invalid relay frame');return;}
      if(message.type==='ready'){
        if(message.service!=='local-commander'||message.workspaceId!==workspaceId){terminal=true;fail(Error('Relay identity mismatch'));return;}
        clearTimeout(timer);confirmed=true;retry=0;onState('ready');
        heartbeat=setInterval(()=>{if(Date.now()-lastSeen>45000)current.terminate();else if(current.readyState===WebSocket.OPEN)current.send('ping');},15000);
        if(!readySettled){readySettled=true;readyResolve();}
        return;
      }
      if(!confirmed || active.has(message.id) || completed.has(message.id) || active.size>=32){current.close(1008,'Invalid or duplicate relay request');return;}
      try{validateRequest(message);}catch{current.close(1008,'Invalid relay request');return;}
      const controller=new AbortController();active.set(message.id,controller);
      let result;
      try{result=await forwardRequest(message,port,{signal:controller.signal});}
      catch{result={type:'http-result',id:message.id,status:502,headers:[['content-type','text/plain']],body:Buffer.from('PC request failed').toString('base64')};}
      finally{active.delete(message.id);completed.add(message.id);if(completed.size>1024)completed.delete(completed.values().next().value);}
      if(current.readyState===WebSocket.OPEN && current===socket)current.send(JSON.stringify(result));
    });
    current.on('close',()=>{
      clearTimeout(timer);clearInterval(heartbeat);clearRequests();
      if(stopped||current!==socket||terminal)return;
      onState('disconnected');
      if(++retry>3){fail(Error('Relay reconnect attempts exhausted'));return;}
      timer=setTimeout(connect,backoffDelays[retry-1]??backoffDelays[backoffDelays.length-1]??1000);
    });
  }
  connect();
  return {ready,done,close(){if(stopped)return;stopped=true;clearTimeout(timer);clearInterval(heartbeat);clearRequests();socket?.terminate();if(!readySettled){readySettled=true;readyReject(Error('Relay closed'));}doneResolve();}};
}
