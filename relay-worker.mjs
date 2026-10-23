// Fixed HTTPS front door. The update credential never grants MCP access.
const paths = new Set(['/mcp','/health','/oauth/authorize','/oauth/register','/oauth/token','/oauth/revoke','/.well-known/oauth-authorization-server','/.well-known/oauth-authorization-server/mcp','/.well-known/openid-configuration','/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp']);
export function validUpstream(value) {
  return typeof value==='string' && /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/i.test(value);
}
async function authorized(request,secret) {
  if(!secret || secret.length<40)return false;
  const actual=request.headers.get('authorization')||'';
  const enc=new TextEncoder();
  const a=new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(actual)));
  const b=new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode('Bearer '+secret)));
  let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];return diff===0;
}
export default {
  async fetch(request,env) {
    const url=new URL(request.url);
    if(url.pathname==='/_relay/register') {
      if(request.method!=='POST'||!await authorized(request,env.UPDATE_SECRET))return new Response('Unauthorized',{status:401});
      if(Number(request.headers.get('content-length')||0)>2048)return new Response('Too large',{status:413});
      const text=await request.text();if(text.length>2048)return new Response('Too large',{status:413});
      let body;try{body=JSON.parse(text);}catch{return new Response('Invalid JSON',{status:400});}
      if(!validUpstream(body.upstream))return new Response('Invalid origin',{status:400});
      try {
        const response=await fetch(body.upstream+'/health',{redirect:'manual',signal:AbortSignal.timeout(8000)});
        if(!response.ok)return Response.json({error:'Origin HTTP error',status:response.status},{status:503});
        const health=await response.json();
        if(!response.ok||health.service!==env.SERVICE||health.workspaceId!==env.WORKSPACE_ID)return new Response('Wrong service',{status:409});
      }catch(error){return Response.json({error:'Origin unavailable',detail:String(error.message).slice(0,300)},{status:503});}
      await env.ORIGIN.put('active',body.upstream);
      return Response.json({registered:true,workspaceId:env.WORKSPACE_ID},{headers:{'cache-control':'no-store'}});
    }
    if(!paths.has(url.pathname)||!['GET','HEAD','POST','DELETE','OPTIONS'].includes(request.method))return new Response('Not found',{status:404});
    const upstream=await env.ORIGIN.get('active');
    if(!validUpstream(upstream))return new Response('PC connection unavailable',{status:503,headers:{'cache-control':'no-store','retry-after':'10'}});
    const target=new URL(url.pathname+url.search,upstream);
    const headers=new Headers(request.headers);
    headers.delete('host');headers.delete('cookie');
    headers.set('x-forwarded-host',url.host);headers.set('x-forwarded-proto','https');
    try {
      const response=await fetch(target,{method:request.method,headers,body:['GET','HEAD'].includes(request.method)?undefined:request.body,redirect:'manual'});
      const outgoing=new Headers(response.headers);
      outgoing.set('cache-control','no-store');outgoing.delete('set-cookie');
      const location=outgoing.get('location');
      if(location && location.startsWith(upstream+'/'))outgoing.set('location',url.origin+location.slice(upstream.length));
      return new Response(response.body,{status:response.status,statusText:response.statusText,headers:outgoing});
    }catch{return new Response('PC connection unavailable',{status:503,headers:{'cache-control':'no-store','retry-after':'10'}});}
  }
};
