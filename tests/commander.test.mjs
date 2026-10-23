import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Commander} from '../core.mjs';
import {dependency} from '../deps.mjs';
import {startHttp} from '../server.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const work=path.resolve(here,'../.work');fs.mkdirSync(work,{recursive:true});
const fixture=fs.mkdtempSync(path.join(work,'commander-tests-'));
const root=path.join(fixture,'root'),outside=path.join(fixture,'outside');fs.mkdirSync(root);fs.mkdirSync(outside);
const config={readRoots:[root],writeRoots:[root],allowShell:true,python:process.env.COMMANDER_PYTHON || 'python'};
const engine=new Commander(config);
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const waitDone=async(id)=>{const s=engine.session(id);await s.done;return engine.snapshot(s);};
test('file create, read-back hash and pagination',async()=>{
  const w=await engine.call('write_file',{path:'한글.txt',content:'하나\n둘\n셋'});
  const r=await engine.call('read_file',{path:'한글.txt',offset:1,length:1});
  assert.equal(r.sha256,w.sha256);assert.deepEqual(r.lines,['둘']);assert.equal(r.nextOffset,2);
});
test('conflicting overwrite and ambiguous edits fail',async()=>{
  await assert.rejects(engine.call('write_file',{path:'한글.txt',content:'changed'}),/Conflict/);
  const r=engine.readFile({path:'한글.txt'});
  await assert.rejects(engine.call('edit_block',{path:'한글.txt',oldText:'missing',newText:'x',expectedSha256:r.sha256}),/exactly once/);
  const w=await engine.call('edit_block',{path:'한글.txt',oldText:'둘',newText:'두 번째',expectedSha256:r.sha256});
  assert.notEqual(w.sha256,r.sha256);assert.equal(fs.readFileSync(path.join(root,'한글.txt'),'utf8'),'하나\n두 번째\n셋');
});
test('out-of-root reads and writes fail',async()=>{
  await assert.rejects(engine.call('read_file',{path:'../outside/a.txt'}),/Outside/);
  await assert.rejects(engine.call('write_file',{path:'../outside/a.txt',content:'x'}),/Outside/);
});
test('sensitive paths and Office writes fail',async()=>{
  fs.writeFileSync(path.join(root,'.env'),'secret');
  await assert.rejects(engine.call('read_file',{path:'.env'}),/Sensitive/);
  await assert.rejects(engine.call('write_file',{path:'source.xlsx',content:'bad'}),/source-preserving/);
});
test('junction traversal blocked for reads and new descendants',async()=>{
  const link=path.join(root,'link');fs.symlinkSync(outside,link,process.platform==='win32'?'junction':'dir');
  fs.writeFileSync(path.join(outside,'file.txt'),'private');
  await assert.rejects(engine.call('read_file',{path:'link/file.txt'}),/Link|Links/);
  await assert.rejects(engine.call('write_file',{path:'link/new/file.txt',content:'escape'}),/Link|Links/);
  assert.equal(fs.existsSync(path.join(outside,'new')),false);
});
test('read-only configuration denies mutation',async()=>{
  const readOnly=new Commander({...config,writeRoots:[],allowShell:false});
  await assert.rejects(readOnly.call('write_file',{path:'denied.txt',content:'x'}),/Outside/);
  await assert.rejects(readOnly.call('start_process',{executable:process.execPath,args:['-e','process.exit(0)']}),/disabled/);
});
test('bounded search reports matching lines and skips secrets/links',async()=>{
  const r=await engine.call('start_search',{pattern:'두 번째',searchType:'content'});
  assert.equal(r.results.length,1);assert.equal(r.results[0].line,2);
  assert.ok(r.skipped>=2);
});
test('real process exit code, UTF8 output and PID ownership',async()=>{
  const r=await engine.call('start_process',{executable:process.execPath,args:['-e',"console.log('한글 출력'); process.exit(7)"],waitMs:1000});
  const done=await waitDone(r.sessionId);assert.equal(done.exitCode,7);assert.match(done.output,/한글 출력/);
  assert.equal(alive(done.pid),false);
  await assert.rejects(engine.call('force_terminate',{sessionId:'not-owned'}),/Unknown owned/);
});
test('interactive input reaches owned process',async()=>{
  const r=await engine.call('start_process',{executable:process.execPath,args:['-e',"process.stdin.once('data',d=>{console.log('reply:'+d);process.exit(0)});"],waitMs:0});
  await engine.call('interact_with_process',{sessionId:r.sessionId,input:'hello\n'});
  const done=await waitDone(r.sessionId);assert.match(done.output,/reply:hello/);assert.equal(done.exitCode,0);
});
test('timeout cleans owned child and grandchild',async()=>{
  const pidFile=path.join(root,'descendant.json');
  const script=`const {spawn}=require('node:child_process');const fs=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({parent:process.pid,child:child.pid}));setInterval(()=>{},1000);`;
  const r=await engine.call('start_process',{executable:process.execPath,args:['-e',script],timeoutMs:1200,waitMs:0});
  const done=await waitDone(r.sessionId);assert.equal(done.timedOut,true);assert.equal(done.state,'timed_out');
  const pids=JSON.parse(fs.readFileSync(pidFile,'utf8'));
  await new Promise(r=>setTimeout(r,300));
  for(const pid of [done.pid,pids.parent,pids.child])assert.equal(alive(pid),false,`PID ${pid} remains`);
});
test('normal parent exit also closes descendant job',async()=>{
  const pidFile=path.join(root,'normal-descendant.json');
  const script=`const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({parent:process.pid,child:child.pid}));process.exit(0);`;
  const r=await engine.call('start_process',{executable:process.execPath,args:['-e',script],waitMs:1000});
  const done=await waitDone(r.sessionId);assert.equal(done.exitCode,0);const pids=JSON.parse(fs.readFileSync(pidFile,'utf8'));
  await new Promise(r=>setTimeout(r,300));assert.equal(alive(pids.child),false);
});
test('stdio MCP discovery and call through official client',async()=>{
  const cfg=path.join(fixture,'config.json');fs.writeFileSync(cfg,JSON.stringify(config));
  const {Client}=await dependency('@modelcontextprotocol/sdk/client/index.js');
  const {StdioClientTransport}=await dependency('@modelcontextprotocol/sdk/client/stdio.js');
  const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve(here,'../server.mjs'),'--config',cfg],stderr:'pipe'});
  const client=new Client({name:'acceptance',version:'1'});
  try{await client.connect(transport);const tools=await client.listTools();assert.equal(tools.tools.length,16);
    const r=await client.callTool({name:'read_file',arguments:{path:'한글.txt'}});assert.equal(r.isError,undefined);assert.match(r.content[0].text,/두 번째/);
    const error=await client.callTool({name:'read_file',arguments:{path:'.env'}});assert.equal(error.isError,true);
  }finally{await client.close();}
});
test('HTTP denies unauthenticated and wrong tokens; official MCP client gets readonly tools',async()=>{
  const token='fixture-token-'+ 'x'.repeat(32), svc=await startHttp(engine,{token});
  const base=`http://127.0.0.1:${svc.port}`;
  const {Client}=await dependency('@modelcontextprotocol/sdk/client/index.js');
  const {StreamableHTTPClientTransport}=await dependency('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client=new Client({name:'http-acceptance',version:'1'});
  try {
    assert.equal((await fetch(base+'/mcp',{method:'POST'})).status,401);
    assert.equal((await fetch(base+'/mcp',{method:'POST',headers:{authorization:'Bearer wrong'}})).status,401);
    assert.equal((await fetch(base+'/mcp',{method:'POST',headers:{authorization:'Bearer '+token,origin:'https://evil.invalid'}})).status,403);
    await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
    const list=await client.listTools();assert.equal(list.tools.length,10);assert.equal(list.tools.some(t=>t.name==='start_process'),false);
    const r=await client.callTool({name:'read_file',arguments:{path:'한글.txt'}});assert.match(r.content[0].text,/두 번째/);
  }finally{await client.close();await svc.close();}
  await assert.rejects(fetch(base+'/health'));
});
test('close terminates owned running sessions',async()=>{
  const r=await engine.call('start_process',{executable:process.execPath,args:['-e','setInterval(()=>{},1000)'],waitMs:0});
  await engine.close();assert.equal(alive(r.pid),false);
});
test.after(async()=>{
  await engine.close();
  // Remove the exact fixture; unlink junction first so no outside tree is followed.
  const link=path.join(root,'link');if(fs.existsSync(link))fs.unlinkSync(link);
  assert.ok(insideWork(fixture));fs.rmSync(fixture,{recursive:true,force:true});
});
function insideWork(p){const rel=path.relative(work,p);return rel && !rel.startsWith('..') && !path.isAbsolute(rel);}
