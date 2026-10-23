import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tunnelConfig} from '../tunnel-config.mjs';
test('named tunnel reuses exact HTTPS origin on every start',()=>{
  const config={tunnel:{mode:'named',name:'owned-commander',publicUrl:'https://commander.example.com'}};
  const first=tunnelConfig(config,48781),second=tunnelConfig(config,48781);
  assert.equal(first.publicUrl,config.tunnel.publicUrl);assert.deepEqual(first,second);
  assert.deepEqual(first.args.slice(-2),['run','owned-commander']);
  assert.ok(!first.args.includes('--token'));
});
test('named tunnel rejects random origins and embedded credentials',()=>{
  for(const publicUrl of ['http://commander.example.com','https://user:password@commander.example.com','https://abc.trycloudflare.com','https://commander.example.com/path','https://commander.example.com/?token=secret']){
    assert.throws(()=>tunnelConfig({tunnel:{mode:'named',name:'owned',publicUrl}},48781));
  }
});
test('named mode has no quick fallback on missing settings',()=>{
  assert.throws(()=>tunnelConfig({tunnel:{mode:'named'}},48781));
  assert.throws(()=>tunnelConfig({tunnel:{mode:'named',name:'--bad',publicUrl:'https://commander.example.com'}},48781));
});
test('explicit quick mode remains available for manual deployment',()=>{
  const result=tunnelConfig({},48781);assert.equal(result.mode,'quick');assert.ok(!result.args.includes('run'));
});
test('relay keeps fixed public origin while internal quick transport changes',()=>{
  const config={tunnel:{mode:'relay',publicUrl:'https://fixture.user.workers.dev',secretFile:'private-state-file'}};
  assert.equal(tunnelConfig(config,48781).publicUrl,config.tunnel.publicUrl);
  assert.throws(()=>tunnelConfig({tunnel:{mode:'relay',publicUrl:'https://abc.trycloudflare.com',secretFile:'private-state-file'}},48781));
});
