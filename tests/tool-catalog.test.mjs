import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Commander} from '../core.mjs';
import {makeServer} from '../server.mjs';
import {dependency} from '../deps.mjs';
const {Client}=await dependency('@modelcontextprotocol/sdk/client/index.js');
const {InMemoryTransport}=await dependency('@modelcontextprotocol/sdk/inMemory.js');
const work=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../.work');
const expected=['get_config','get_usage_stats','get_recent_tool_calls','list_directory','read_file','read_multiple_files','get_file_info','write_file','edit_block','create_directory','start_search','start_process','read_process_output','interact_with_process','force_terminate','list_sessions'];
const mutating=['write_file','edit_block','create_directory','start_process','interact_with_process','force_terminate'];
async function fixture(fn,readOnly=false){
  fs.mkdirSync(work,{recursive:true});
  const root=fs.mkdtempSync(path.join(work,'commander-catalog-'));
  const engine=new Commander({readRoots:[root],writeRoots:[root],allowShell:true,logFile:path.join(root,'calls.jsonl')});
  const server=makeServer(engine,{readOnly});
  const client=new Client({name:'commander-catalog-test',version:'1'});
  const [ct,st]=InMemoryTransport.createLinkedPair();
  try{await server.connect(st);await client.connect(ct);await fn({client,engine,root});}
  finally{await client.close();await server.close();await engine.close();fs.rmSync(root,{recursive:true,force:true});}
}
test('catalog preserves all existing names and write safety annotations',()=>fixture(async({client})=>{
  const {tools}=await client.listTools();assert.deepEqual(tools.map(t=>t.name),expected);
  for(const t of tools)assert.equal(t.annotations.readOnlyHint,!mutating.includes(t.name),t.name);
}));
test('file and execution descriptions identify the actual user action',()=>fixture(async({client})=>{
  const {tools}=await client.listTools();const descriptions=Object.fromEntries(tools.map(t=>[t.name,t.description]));
  assert.match(descriptions.write_file,/text files|텍스트/);
  assert.match(descriptions.edit_block,/exact|정확/);
  assert.match(descriptions.start_process,/executable|명령/);
}));
test('get_config reports server catalog without claiming client exposure',()=>fixture(async({client,root})=>{
  const response=await client.callTool({name:'get_config',arguments:{}});const result=JSON.parse(response.content[0].text);
  assert.deepEqual(result.readRoots,[fs.realpathSync.native(root)]);
  const c=result.toolAvailability;assert.ok(c,'missing toolAvailability');
  assert.deepEqual(c.serverToolNames,expected);assert.deepEqual(c.serverWriteToolNames,mutating);
  assert.equal(c.clientVisibility,'client-controlled');assert.equal(c.readOnly,false);
  assert.match(c.catalogSha256,/^[a-f0-9]{64}$/);
}));
test('read-only registration remains read-only and cannot execute hidden writes',()=>fixture(async({client})=>{
  const {tools}=await client.listTools();assert.deepEqual(tools.map(t=>t.name),expected.filter(n=>!mutating.includes(n)));
  const result=JSON.parse((await client.callTool({name:'get_config',arguments:{}})).content[0].text);
  assert.ok(result.toolAvailability);assert.equal(result.toolAvailability.readOnly,true);
  assert.deepEqual(result.toolAvailability.serverWriteToolNames,[]);
  const denied=await client.callTool({name:'write_file',arguments:{path:'must-not-exist.txt',content:'denied'}});
  assert.equal(denied.isError,true);
},true));
test('server catalog record contains names and fingerprint, never request payloads',()=>fixture(async({engine})=>{
  const rows=engine.history.filter(r=>r.event==='mcp_catalog');assert.equal(rows.length,1);
  assert.equal(rows[0].toolCount,16);assert.equal(rows[0].writeToolCount,6);
  assert.match(rows[0].catalogSha256,/^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(rows[0],'arguments'),false);assert.equal(Object.hasOwn(rows[0],'authorization'),false);
}));
test('input schemas and authorization hints exactly match the preserved source',()=>{
  const dir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const before=fs.readFileSync(path.join(dir,'tests/fixtures/server-contract-before.mjs'),'utf8');
  const after=fs.readFileSync(path.join(dir,'server.mjs'),'utf8');
  const schema=s=>s.match(/const schemas=\{[\s\S]*?\n\};/)[0];
  const hints=s=>s.split('\n').find(line=>line.includes('annotations:{readOnlyHint:'));
  assert.equal(schema(after),schema(before));assert.equal(hints(after),hints(before));
});
