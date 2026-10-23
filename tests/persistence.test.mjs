import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Commander} from '../core.mjs';
const work=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../.work');
async function fixture(fn){fs.mkdirSync(work,{recursive:true});const root=fs.mkdtempSync(path.join(work,'commander-persistence-'));const logFile=path.join(root,'calls.jsonl');const config={readRoots:[root],writeRoots:[root],allowShell:true,python:process.env.COMMANDER_PYTHON || 'python',logFile};const c=new Commander(config);try{await fn(c,root,config);}finally{await c.close();fs.rmSync(root,{recursive:true,force:true});}}
test('UTF16 BOM and CRLF survive edit and append; negative offset reads tail',()=>fixture(async(c,root)=>{
  const file=path.join(root,'u.txt');fs.writeFileSync(file,Buffer.concat([Buffer.from([255,254]),Buffer.from('Alpha\r\nBeta','utf16le')]));
  const r=await c.call('read_file',{path:file,offset:-1});assert.deepEqual(r.lines,['Beta']);
  const e=await c.call('edit_block',{path:file,oldText:'Beta',newText:'한글',expectedSha256:r.sha256});
  await c.call('write_file',{path:file,content:'\r\nEnd',mode:'append',expectedSha256:e.sha256});
  const bytes=fs.readFileSync(file);assert.deepEqual([...bytes.subarray(0,2)],[255,254]);assert.equal(bytes.subarray(2).toString('utf16le'),'Alpha\r\n한글\r\nEnd');
}));
test('retained completed sessions do not exhaust future command execution',()=>fixture(async c=>{
  for(let i=0;i<100;i++)c.sessions.set('old'+i,{state:'completed',done:Promise.resolve()});
  const started=await c.call('start_process',{executable:process.execPath,args:['-e','console.log("CAPACITY_OK 한글")'],waitMs:1000});
  await c.session(started.sessionId).done;const result=c.snapshot(c.session(started.sessionId));assert.equal(result.exitCode,0);assert.match(result.output,/CAPACITY_OK 한글/);assert.equal(c.sessions.size,100);
}));
test('success, denial, and process exit persist without command or content payloads',()=>fixture(async(c,root,config)=>{
  await c.call('write_file',{path:'proof.txt',content:'PRIVATE_PAYLOAD'});
  await assert.rejects(c.call('write_file',{path:'proof.txt',content:'PRIVATE_CHANGE'}),/Conflict/);
  const p=await c.call('start_process',{executable:process.execPath,args:['-e','console.log("PRIVATE_OUTPUT")'],waitMs:1000});await c.session(p.sessionId).done;
  const raw=fs.readFileSync(config.logFile,'utf8');assert.doesNotMatch(raw,/PRIVATE_PAYLOAD|PRIVATE_CHANGE|PRIVATE_OUTPUT/);
  const rows=raw.trim().split('\n').map(JSON.parse);assert.ok(rows.some(r=>r.status==='error'));assert.ok(rows.some(r=>r.event==='process_exit'&&r.exitCode===0));
  const next=new Commander(config);try{const history=await next.call('get_recent_tool_calls');assert.ok(history.calls.some(r=>r.event==='process_exit'));assert.ok(fs.readFileSync(config.logFile,'utf8').length>raw.length);}finally{await next.close();}
}));
