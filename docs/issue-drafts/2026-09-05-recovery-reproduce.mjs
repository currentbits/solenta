// Audit evidence: assertions confirm existing defects, not corrected behavior.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import React, { useState } from 'react';
import { mount, inAct } from '../../test/support/dom.ts';
import { createFakeCoder, installFakeCoder, project, thread, detail } from '../../test/support/fakeCoder.ts';
import { createWireCoder } from '../../src/wireClient.ts';
import { useCoder } from '../../src/useCoder.ts';
import { SettingsModal } from '../../src/components/SettingsModal.tsx';
const require = createRequire(import.meta.url);
const { Store } = require('../../electron/store.js');
const services = require('../../electron/services.js');
const { runAutomation, startScheduler, MAX_THREADS_PER_AUTOMATION } = require('../../electron/automations.js');
const h = React.createElement;

class FakeSocket {
  static OPEN = 1;
  static instances = [];
  readyState = 0;
  sent = [];
  constructor() { FakeSocket.instances.push(this); }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  open() { this.readyState = 1; this.onopen?.({}); }
  close() { this.readyState = 3; this.onclose?.({}); }
  deliver(msg) { this.onmessage?.({data: JSON.stringify(msg)}); }
}
{
  let reconnect;
  const api = createWireCoder({url:'ws://fixture.invalid',token:'fixture',WebSocket:FakeSocket,
    setTimeout(fn,ms) { if (ms < 120000) reconnect=fn; return {unref(){}}; }});
  const first = FakeSocket.instances.at(-1);
  first.open(); first.deliver({kind:'auth-ok'}); first.close();
  const writes = [true,false,true].map(notifications => api.settings.set({notifications}));
  reconnect();
  const socket = FakeSocket.instances.at(-1);
  socket.open(); socket.deliver({kind:'auth-ok'});
  const sent = socket.sent.filter(x=>x.channel==='settings:set');
  assert.deepEqual(sent.map(x=>x.args[0].notifications), [true,false]);
  for (const msg of socket.sent.filter(x=>x.kind==='invoke')) {
    socket.deliver({kind:'reply',id:msg.id,result:msg.channel==='threads:list'?[]:msg.args[0]});
  }
  assert.deepEqual((await Promise.all(writes)).map(x=>x.notifications), [true,false,true]);
  console.log('CONFIRMED: offline true → false → true settings writes become only true → false on the host, while all three callers resolve.');
}

{
  const busy = thread({id:'reconnect-thread',status:'working',title:'Reconnect audit'});
  const fake = createFakeCoder({projects:[project()],threads:[busy],details:{[busy.id]:detail({thread:busy,messages:[]})}});
  const init = await mount(h('div')); window.localStorage.clear(); installFakeCoder(fake); init.unmount();
  let state;
  function Hook() { state=useCoder(); return null; }
  const m = await mount(h(Hook)); await m.flush();
  assert.equal(state.detail.thread.status, 'working');
  const done = {...busy,status:'done',updatedAt:busy.updatedAt+1000};
  const finalDetail = detail({thread:done,messages:[{id:'missed',role:'assistant',text:'Reply completed during outage',createdAt:Date.now()}]});
  let detailReloads = 0;
  fake.api.threads.get = async () => { detailReloads++; return finalDetail; };
  await inAct(()=>fake.emitThreads([done])); await m.flush();
  assert.equal(state.threads[0].status,'done');
  assert.equal(state.detail.thread.status,'working');
  assert.equal(state.detail.messages.length,0);
  assert.equal(detailReloads,0);
  console.log('CONFIRMED: reconnect-style threads:changed updates the list to done but leaves open detail working with missing final reply.');
  m.unmount();
}

{
  let saved;
  const loaded = {dailyBudgetUsd:5,orchestrationBudgetUsd:2,autoSettleAfterDays:3,prDiffCapLines:400};
  function Shell() {
    const [settings,setSettings]=useState(null);
    return h(React.Fragment,null,
      h('button',{onClick:()=>setSettings(loaded),'data-load-settings':''},'Load settings'),
      h(SettingsModal,{open:true,initialPane:'git',onClose(){},settings,status:null,onSaveSettings:async patch=>{saved=patch;return {...loaded,...patch};}}));
  }
  const m = await mount(h(Shell));
  await m.click(m.query('[data-load-settings]'));
  await m.type(m.query('#pr-diff-cap'),'500');
  await m.press(m.query('#pr-diff-cap'),'Enter'); await m.flush();
  assert.equal(saved.prDiffCapLines,500);
  assert.equal(saved.dailyBudgetUsd,null);
  assert.equal(saved.orchestrationBudgetUsd,null);
  assert.equal(saved.autoSettleAfterDays,null);
  console.log('CONFIRMED: settings loaded after modal open are ignored; saving PR size sends null for both existing budgets and auto-settle.');
  m.unmount();
}

async function withStore(check) {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'solenta-recovery-audit-'));
  const store=new Store(path.join(tmp,'store.json'));
  store.setProjects([{id:'p1',name:'Audit',slug:'audit',path:tmp}]);
  try { await check(store,tmp); }
  finally { store.saveNow(); if(store._bakCopy) await store._bakCopy; fs.rmSync(tmp,{recursive:true,force:true}); }
}

await withStore(async store=>{
  const auto=services.addAutomation(store,{projectId:'p1',name:'Weekly',prompt:'Review',provider:'claude',preset:'weekly',hour:9});
  const monday=new Date(2026,5,8,9).getTime();
  const tuesday=new Date(2026,5,9,10).getTime();
  store.setAutomations([{...auto,nextRunAt:monday}]);
  const scheduler=startScheduler({store,runner:{startRun:async()=>({runId:'fixture'})},now:()=>tuesday,intervalMs:3600000});
  try { await scheduler.tick(); } finally { scheduler.stop(); }
  const next=store.getAutomation(auto.id).nextRunAt;
  assert.equal(new Date(next).getDay(),2);
  assert.equal(next,new Date(2026,5,16,9).getTime());
  console.log('CONFIRMED: a Monday weekly automation caught up on Tuesday permanently moves its next run to Tuesday.');
});

await withStore(async store=>{
  const auto=services.addAutomation(store,{projectId:'p1',name:'Retention',prompt:'Review',provider:'claude',preset:'hourly'});
  const old=services.createThread(store,{projectId:'p1',title:'Paused waiting for quota',automationId:auto.id});
  store.updateThread(old.id,{createdAt:1,status:'quota-wait',quotaWaitUntil:Date.now()+7*86400000});
  store.appendMessage(old.id,{id:'request',role:'user',text:'Finish this review',createdAt:1});
  store.appendMessage(old.id,{id:'valuable',role:'assistant',text:'Unfinished work',createdAt:2});
  for(let i=0;i<MAX_THREADS_PER_AUTOMATION;i++) {
    const recent=services.createThread(store,{projectId:'p1',title:'Newer',automationId:auto.id});
    store.updateThread(recent.id,{createdAt:i+100,status:'done'});
  }
  await runAutomation({store,runner:{startRun:async()=>({runId:'fixture'})}},auto,Date.now());
  assert.equal(store.getThread(old.id),null);
  assert.deepEqual(store.getMessages(old.id),[]);
  console.log('CONFIRMED: automation retention deletes an unpinned quota-wait thread and its transcript after newer runs exceed the cap.');
});

await withStore(async (store,tmp)=>{
  const t=services.createThread(store,{projectId:'p1',title:'Corrupt transcript'});
  store.appendMessage(t.id,{id:'old',role:'assistant',text:'Recoverable original transcript',createdAt:1});
  store.saveNow();
  const shard=path.join(tmp,'messages',encodeURIComponent(t.id)+'.json');
  const broken=fs.readFileSync(shard,'utf8').slice(0,-1);
  fs.writeFileSync(shard,broken);
  const loaded=new Store(path.join(tmp,'store.json'));
  try {
    assert.deepEqual(loaded.getMessages(t.id),[]);
    loaded.appendMessage(t.id,{id:'new',role:'user',text:'Continue',createdAt:2});
    loaded.saveNow();
    const current=fs.readFileSync(shard,'utf8');
    assert.equal(JSON.parse(current).length,1);
    assert.ok(!current.includes('Recoverable original transcript'));
    assert.deepEqual(fs.readdirSync(path.dirname(shard)),[path.basename(shard)]);
    console.log('CONFIRMED: appending after a corrupt shard read overwrites the original bytes without a quarantine copy.');
  } finally { if(loaded._bakCopy) await loaded._bakCopy; }
});
