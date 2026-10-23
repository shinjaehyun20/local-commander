import fs from 'node:fs';
export async function registerRelay({publicUrl,secretFile},upstream,{service,workspaceId,delayMs=12000}={}) {
  if(!/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(publicUrl))throw Error('Invalid fixed relay origin');
  if(!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(upstream))throw Error('Invalid upstream origin');
  const secret=fs.readFileSync(secretFile,'utf8').trim();
  if(secret.length<40)throw Error('Missing relay credential');
  await new Promise(resolve=>setTimeout(resolve,delayMs));
  let registered=false;
  for(let attempt=0;attempt<12;attempt++) {
    try {
      if(!registered){
        const response=await fetch(publicUrl+'/_relay/register',{method:'POST',headers:{authorization:'Bearer '+secret,'content-type':'application/json'},body:JSON.stringify({upstream}),signal:AbortSignal.timeout(15000)});
        if(response.status===401||response.status===409)throw Error('Relay ownership rejected');
        registered=response.ok;
      }
      if(registered){
        const response=await fetch(publicUrl+'/health',{signal:AbortSignal.timeout(8000)});
        const health=await response.json();
        if(response.ok && health.service===service && health.workspaceId===workspaceId)return publicUrl;
      }
    }catch(error){if(error.message==='Relay ownership rejected')throw error;}
    await new Promise(resolve=>setTimeout(resolve,5000));
  }
  throw Error('Fixed relay registration or health verification failed');
}
