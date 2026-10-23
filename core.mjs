import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const hash = data => createHash('sha256').update(data).digest('hex');
function decodeText(data) {
  if(data[0]===255 && data[1]===254) return {text:data.subarray(2).toString('utf16le'),encoding:'utf16le',bom:true};
  if(data[0]===254 && data[1]===255) {const b=Buffer.from(data.subarray(2));if(b.length%2)throw Error('Invalid UTF16');b.swap16();return {text:b.toString('utf16le'),encoding:'utf16be',bom:true};}
  if(data.includes(0))throw Error('Binary file: use a dedicated document tool');
  const bom=data.subarray(0,3).equals(Buffer.from([239,187,191]));
  return {text:new TextDecoder('utf-8',{fatal:true}).decode(bom?data.subarray(3):data),encoding:'utf8',bom};
}
function encodeText(text,format) {
  let data=Buffer.from(text,format.encoding==='utf8'?'utf8':'utf16le');
  if(format.encoding==='utf16be')data.swap16();
  const prefix=format.encoding==='utf8'?[239,187,191]:format.encoding==='utf16le'?[255,254]:[254,255];
  return format.bom?Buffer.concat([Buffer.from(prefix),data]):data;
}
const forbidden = /(^|[\\/])(\.env(?:\..*)?|\.ssh|\.aws|\.git|node_modules|auth|credentials)([\\/]|$)|\.(pem|key|pfx)$/i;
const office = /\.(xlsx?|xlsm|pptx?|pptm|docx?|hwp|hwpx|pdf)$/i;
function inside(root, target) { const rel=path.relative(root,target); return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..'+path.sep); }

export class Commander {
  constructor(config) {
    if (!config.readRoots?.length) throw Error('readRoots required');
    this.config=config;
    this.readRoots=config.readRoots.map(r=>fs.realpathSync.native(path.resolve(r)));
    this.writeRoots=(config.writeRoots || []).map(r=>fs.realpathSync.native(path.resolve(r)));
    if (this.writeRoots.some(r=>!this.readRoots.some(x=>inside(x,r)))) throw Error('writeRoots must be within readRoots');
    this.sessions=new Map(); this.calls=0; this.startedAt=new Date().toISOString();
    this.history=[];
    this.logFile=config.logFile ? path.resolve(config.logFile) : null;
    if(this.logFile){
      fs.mkdirSync(path.dirname(this.logFile),{recursive:true});
      if(fs.existsSync(this.logFile)){
        const fd=fs.openSync(this.logFile,'r');
        try{const size=fs.fstatSync(fd).size, start=Math.max(0,size-256000), buffer=Buffer.alloc(size-start);fs.readSync(fd,buffer,0,buffer.length,start);
          const rows=buffer.toString('utf8').split('\n');if(start)rows.shift();
          this.history=rows.filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}).slice(-1000);
        }finally{fs.closeSync(fd);}
      }
    }
  }
  record(event) {
    const row={time:new Date().toISOString(),...event};
    this.history.push(row);if(this.history.length>1000)this.history.shift();
    if(this.logFile)fs.appendFileSync(this.logFile,JSON.stringify(row)+'\n','utf8');
  }
  resolve(input, write=false) {
    if(typeof input!=='string' || !input || input.includes('\0')) throw Error('Invalid path');
    const full=path.resolve(path.isAbsolute(input)?input:path.join(this.readRoots[0],input));
    if (forbidden.test(full)) throw Error('Sensitive or excluded path');
    const roots=write?this.writeRoots:this.readRoots;
    if(!roots.some(r=>inside(r,full))) throw Error('Outside allowed roots');
    let ancestor=full;
    while(!fs.existsSync(ancestor)) {const up=path.dirname(ancestor); if(up===ancestor)throw Error('Missing ancestor'); ancestor=up;}
    const real=fs.realpathSync.native(ancestor);
    if(!roots.some(r=>inside(r,real)) || forbidden.test(real)) throw Error('Link escapes allowed roots');
    // Reject all symlink/junction components, including links back inside the root.
    const root=roots.find(r=>inside(r,full));
    let cursor=root;
    for(const part of path.relative(root,ancestor).split(path.sep).filter(Boolean)) {
      cursor=path.join(cursor,part);
      if(fs.lstatSync(cursor).isSymbolicLink())throw Error('Links are not followed');
    }
    return full;
  }
  readFile(args) {
    const file=this.resolve(args.path), st=fs.statSync(file);
    if(!st.isFile() || st.size>2*1024*1024) throw Error('Use bounded text files up to 2 MiB');
    const data=fs.readFileSync(file);
    const format=decodeText(data), lines=format.text.split(/\r?\n/), start=args.offset<0?Math.max(0,lines.length+args.offset):(args.offset??0), count=Math.min(args.length??200,1000);
    return {path:file,sha256:hash(data),encoding:format.encoding,bom:format.bom,totalLines:lines.length,offset:start,lines:lines.slice(start,start+count),nextOffset:start+count<lines.length?start+count:null};
  }
  writeFile(args) {
    const file=this.resolve(args.path,true);
    if(office.test(file))throw Error('Office/PDF writes require a source-preserving document workflow');
    if(Buffer.byteLength(args.content)>2*1024*1024)throw Error('Content too large');
    const exists=fs.existsSync(file), before=exists?fs.readFileSync(file):null;
    if(exists && args.expectedSha256!==hash(before))throw Error('Conflict: current SHA256 required');
    if(!exists && args.expectedSha256)throw Error('Conflict: file does not exist');
    fs.mkdirSync(path.dirname(file),{recursive:true});
    this.resolve(file,true);
    const format=before?decodeText(before):{encoding:'utf8',bom:false};
    const data=encodeText(args.mode==='append' && before ? format.text+args.content : args.content,format);
    const temp=file+'.'+randomUUID()+'.tmp';
    try { fs.writeFileSync(temp,data,{flag:'wx'}); fs.renameSync(temp,file); }
    finally {if(fs.existsSync(temp))fs.unlinkSync(temp);}
    return {path:file,sha256:hash(fs.readFileSync(file)),bytes:data.length};
  }
  editBlock(args) {
    if(!args.oldText)throw Error('oldText must not be empty');
    const r=this.readFile({path:args.path,offset:0,length:1000});
    const file=this.resolve(args.path,true), content=decodeText(fs.readFileSync(file)).text;
    if(args.expectedSha256!==r.sha256)throw Error('Conflict: current SHA256 required');
    const occurrences=content.split(args.oldText).length-1;
    if(occurrences!==1)throw Error('oldText must occur exactly once');
    return this.writeFile({path:file,content:content.replace(args.oldText,args.newText),expectedSha256:args.expectedSha256});
  }
  listDirectory(args) {
    const dir=this.resolve(args.path||'.');
    const entries=fs.readdirSync(dir,{withFileTypes:true}).filter(d=>!forbidden.test(path.join(dir,d.name)))
      .sort((a,b)=>a.name.localeCompare(b.name)).map(d=>({name:d.name,type:d.isSymbolicLink()?'link':d.isDirectory()?'directory':'file'}));
    const offset=args.offset||0, length=Math.min(args.length||100,1000);
    return {path:dir,total:entries.length,entries:entries.slice(offset,offset+length),nextOffset:offset+length<entries.length?offset+length:null};
  }
  search(args) {
    const root=this.resolve(args.path||'.'), found=[]; let scanned=0, skipped=0, truncated=false;
    const needle=String(args.pattern).toLowerCase(), max=Math.min(args.maxResults||100,500), deadline=Date.now()+5000;
    if(!needle)throw Error('pattern required');
    const visit=dir=>{
      for(const ent of fs.readdirSync(dir,{withFileTypes:true})) {
        if(scanned>=5000 || found.length>=max || Date.now()>deadline){truncated=true;return;}
        const p=path.join(dir,ent.name); scanned++;
        if(forbidden.test(p)||ent.isSymbolicLink()){skipped++;continue;}
        try {
          this.resolve(p);
          if(ent.isDirectory()){visit(p);if(truncated)return;}
          else if(args.searchType==='files'){if(ent.name.toLowerCase().includes(needle))found.push({path:p});}
          else {
            if(fs.statSync(p).size>256*1024){skipped++;continue;}
            const data=fs.readFileSync(p); if(data.includes(0)){skipped++;continue;}
            const lines=data.toString('utf8').split(/\r?\n/);
            for(let i=0;i<lines.length && found.length<max;i++)if(lines[i].toLowerCase().includes(needle))found.push({path:p,line:i+1,text:lines[i].slice(0,1000)});
          }
        } catch {skipped++;}
      }
    };
    visit(root); return {results:found,scanned,skipped,truncated:truncated||found.length>=max};
  }
  snapshot(s, offset=0, length=20000) {
    return {sessionId:s.id,pid:s.child.pid,startedAt:s.startedAt,state:s.state,exitCode:s.exitCode,
      timedOut:s.timedOut,offset,output:s.output.slice(offset,offset+Math.min(length,100000)),nextOffset:Math.min(offset+length,s.output.length),outputTruncated:s.truncated};
  }
  async startProcess(args) {
    if(!this.config.allowShell)throw Error('Process execution is disabled');
    if([...this.sessions.values()].filter(s=>s.state==='running').length>=4)throw Error('Four concurrent sessions maximum');
    while(this.sessions.size>=100){const old=[...this.sessions.entries()].find(([,s])=>s.state!=='running');if(!old)throw Error('Session history full');this.sessions.delete(old[0]);}
    const cwd=this.resolve(args.cwd||'.'), executable=args.executable, argv=args.args||[];
    if(!executable || argv.some(a=>typeof a!=='string'))throw Error('Executable and string args required');
    const timeout=Math.min(args.timeoutMs||60000,300000);
    const spec={executable,args:argv,cwd};
    const child=process.platform==='win32'
      ? spawn(this.config.python,[path.join(here,'supervise.py'),Buffer.from(JSON.stringify(spec)).toString('base64')],{cwd,windowsHide:true,stdio:'pipe'})
      : spawn(executable,argv,{cwd,windowsHide:true,stdio:'pipe',detached:true});
    const s={id:randomUUID(),child,state:'running',output:'',truncated:false,exitCode:null,timedOut:false,startedAt:new Date().toISOString()};
    this.sessions.set(s.id,s);
    const append=d=>{const data=d.toString('utf8'),room=1000000-s.output.length;if(data.length>room)s.truncated=true;if(room>0)s.output+=data.slice(0,room);};
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); child.stdout.on('data',append);child.stderr.on('data',append);
    s.done=new Promise(resolve=>{child.once('error',e=>{append(e.message);s.state='failed';s.exitCode=-1;clearTimeout(s.timer);resolve();});
      child.once('close',(code,signal)=>{s.state=s.timedOut?'timed_out':signal?'terminated':code===0?'completed':'failed';s.exitCode=code;clearTimeout(s.timer);try{this.record({event:'process_exit',sessionId:s.id,pid:s.child.pid,state:s.state,exitCode:code,timedOut:s.timedOut});}finally{resolve();}});});
    s.timer=setTimeout(()=>{s.timedOut=true;this.terminate(s);},timeout);
    await Promise.race([s.done,new Promise(r=>setTimeout(r,Math.min(args.waitMs??1000,10000)))]);
    return this.snapshot(s);
  }
  terminate(s) {
    if(s.state!=='running')return;
    if(process.platform==='win32')s.child.kill();
    else {try{process.kill(-s.child.pid,'SIGTERM');}catch{};setTimeout(()=>{try{process.kill(-s.child.pid,'SIGKILL');}catch{}},1000).unref();}
  }
  session(id) {const s=this.sessions.get(id);if(!s)throw Error('Unknown owned session');return s;}
  async close(){for(const s of this.sessions.values())this.terminate(s);await Promise.all([...this.sessions.values()].map(s=>s.done));}
  async call(name,args={}) {
    this.calls++;
    const callId=randomUUID(), started=Date.now();
    this.record({event:'tool_start',callId,tool:name});
    try{const result=await this.dispatch(name,args);this.record({event:'tool_end',callId,tool:name,status:'ok',durationMs:Date.now()-started,sessionId:result?.sessionId});return result;}
    catch(e){this.record({event:'tool_end',callId,tool:name,status:'error',durationMs:Date.now()-started,errorType:e.constructor.name});throw e;}
  }
  async dispatch(name,args={}) {
    switch(name) {
      case 'get_config': return {readRoots:this.readRoots,writeRoots:this.writeRoots,allowShell:!!this.config.allowShell,monthlyQuota:null,transport:'self-hosted',shellHasOSUserPermissions:true,persistentLogging:!!this.logFile,logFile:this.logFile};
      case 'get_recent_tool_calls': return {calls:this.history.slice(-Math.min(args.maxResults??50,1000))};
      case 'get_usage_stats':return {calls:this.calls,startedAt:this.startedAt,monthlyQuota:null,sessions:this.sessions.size};
      case 'read_file':return this.readFile(args);
      case 'read_multiple_files':return args.paths.map(p=>{try{return this.readFile({path:p});}catch(e){return {path:p,error:e.message};}});
      case 'write_file':return this.writeFile(args);
      case 'edit_block':return this.editBlock(args);
      case 'create_directory':{const p=this.resolve(args.path,true);fs.mkdirSync(p,{recursive:true});return {path:p};}
      case 'list_directory':return this.listDirectory(args);
      case 'get_file_info':{const p=this.resolve(args.path),s=fs.statSync(p);return {path:p,size:s.size,type:s.isDirectory()?'directory':'file',modified:s.mtime.toISOString()};}
      case 'start_search':return this.search(args);
      case 'start_process':return this.startProcess(args);
      case 'read_process_output':return this.snapshot(this.session(args.sessionId),args.offset||0,args.length||20000);
      case 'interact_with_process':{const s=this.session(args.sessionId);if(s.state!=='running')throw Error('Session already ended');if(Buffer.byteLength(args.input)>65536)throw Error('Input too large');s.child.stdin.write(args.input);return this.snapshot(s);}
      case 'force_terminate':{const s=this.session(args.sessionId);this.terminate(s);await s.done;return this.snapshot(s);}
      case 'list_sessions':return {sessions:[...this.sessions.values()].map(s=>this.snapshot(s,0,1))};
      default:throw Error('Unknown tool');
    }
  }
}
