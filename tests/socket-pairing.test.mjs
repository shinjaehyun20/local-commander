import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {PairingManager} from '../vendor-auth/pairing/manager.js';
import {refreshSocketPairing} from '../launch-socket.mjs';

test('socket pairing refresh is explicit, atomic, single-use, and preserves auth',()=>{
  const work=path.resolve('.work');fs.mkdirSync(work,{recursive:true});
  const state=fs.mkdtempSync(path.join(work,'socket-pairing-'));
  try{
    const pairing=new PairingManager('1234567890ab');
    const auth=path.join(state,'auth.json');fs.writeFileSync(auth,'preserve-existing-auth');
    const request=path.join(state,'refresh-pairing.request');
    const output=path.join(state,'pairing.json');
    const previous=pairing.create();
    assert.equal(refreshSocketPairing(state,pairing),false);
    assert.equal(fs.existsSync(output),false);
    fs.writeFileSync(request,new Date().toISOString());
    assert.equal(refreshSocketPairing(state,pairing),true);
    const fresh=JSON.parse(fs.readFileSync(output,'utf8'));
    assert.notEqual(fresh.code,previous.code);
    assert.ok(fresh.expiresAt>Date.now());
    assert.equal(fs.existsSync(request),false);
    assert.equal(pairing.verify(previous.code).ok,false);
    assert.equal(pairing.verify(fresh.code).ok,true);
    assert.equal(pairing.verify(fresh.code).ok,false);
    assert.equal(fs.readFileSync(auth,'utf8'),'preserve-existing-auth');
    assert.equal(refreshSocketPairing(state,pairing),false);
  }finally{fs.rmSync(state,{recursive:true,force:true});}
});

test('failed pairing publication retains the refresh request for retry',()=>{
  const work=path.resolve('.work');fs.mkdirSync(work,{recursive:true});
  const state=fs.mkdtempSync(path.join(work,'socket-pairing-'));
  try{
    const request=path.join(state,'refresh-pairing.request');
    fs.writeFileSync(request,'request');
    fs.mkdirSync(path.join(state,'pairing.json'));
    assert.throws(()=>refreshSocketPairing(state,new PairingManager('1234567890ab')));
    assert.equal(fs.existsSync(request),true);
  }finally{fs.rmSync(state,{recursive:true,force:true});}
});
