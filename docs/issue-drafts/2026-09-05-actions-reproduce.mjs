// Audit assertions confirm existing failures, not corrected behavior.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';
import { mount, inAct } from '../../test/support/dom.ts';
import { createFakeCoder, installFakeCoder, project, thread, detail } from '../../test/support/fakeCoder.ts';
import App from '../../src/App.tsx';
import { TerminalPane } from '../../src/components/TerminalPane.tsx';
const require=createRequire(import.meta.url);
const {Store}=require('../../electron/store.js');
const services=require('../../electron/services.js');
const {IPC_HANDLERS}=require('../../electron/ipc.js');
const h=React.createElement;

{
  const realInterval=globalThis.setInterval, realClear=globalThis.clearInterval;
  let poll;
  const timer={unref(){}};
  globalThis.setInterval=(fn,ms,...args)=>ms===250?(poll=fn,timer):realInterval(fn,ms,...args);
  globalThis.clearInterval=id=>{if(id!==timer)realClear(id);};
  const replies=[];
  const cursors=[];
  const state=over=>({running:true,cwd:'/tmp/audit',shell:'/bin/sh',cursor:0,text:'',pending:'',reset:false,startedAt:1,...over});
  const api={open:async()=>state({reset:true}),read:async(id,since)=>{cursors.push(since);return new Promise(resolve=>replies.push(resolve));},write:async()=>state(),close:async()=>state({running:false})};
  let m;
  try {
    m=await mount(h(TerminalPane,{threadId:'terminal-audit',api})); await m.flush();
    assert.equal(typeof poll,'function');
    await inAct(()=>{poll();poll();});
    assert.deepEqual(cursors,[0,0]);
    await inAct(()=>replies[0](state({text:'first\n',cursor:6})));
    await inAct(()=>replies[1](state({text:'first\nsecond\n',cursor:13})));
    assert.equal(m.query('[data-terminal-output]').textContent,'first\nfirst\nsecond\n');
    console.log('CONFIRMED: overlapping terminal reads both use cursor 0 and append overlapping deltas, duplicating output.');
  } finally {m?.unmount();globalThis.setInterval=realInterval;globalThis.clearInterval=realClear;}
}

{
  const t=thread({id:'notes-audit',notes:'Original saved note'});
  const fake=createFakeCoder({projects:[project()],threads:[t],details:{[t.id]:detail({thread:t})}});
  const init=await mount(h('div'));window.localStorage.clear();installFakeCoder(fake);init.unmount();
  fake.api.threads.setNotes=async()=>{throw new Error('Notes save rejected');};
  const m=await mount(h(App));
  try {
    await m.flush();
    await m.click(m.query('[data-thread-notes-btn]'));
    await m.type(m.query('[data-thread-notes-input]'),'Important unsaved investigation notes');
    await m.click(m.query('[data-thread-notes-btn]'));await m.flush();
    assert.equal(m.query('[data-thread-notes-input]'),null);
    assert.match(m.text(),/Notes save rejected/);
    await m.click(m.query('[data-thread-notes-btn]'));
    assert.equal(m.query('[data-thread-notes-input]').value,'Original saved note');
    assert.equal((await fake.api.threads.get(t.id)).thread.notes,'Original saved note');
    console.log('CONFIRMED: rejected notes save closes the editor and reopening loses the edited text in the real App.');
  } finally {m.unmount();}
}

{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'solenta-review-audit-'));
  const file=path.join(tmp,'store.json');
  const store=new Store(file);
  try {
    store.setProjects([{id:'p1',name:'Audit',slug:'audit',path:tmp}]);
    const t=services.createThread(store,{projectId:'p1',title:'Review persistence'});
    store.saveNow();
    assert.equal(store._dirty,false);
    const updated=await IPC_HANDLERS['git:setReviewAccepted']({store},{threadId:t.id,hashes:['reviewed-hunk']});
    assert.deepEqual(updated.reviewAcceptedHunks,['reviewed-hunk']);
    assert.equal(store._dirty,false);
    assert.equal(store._timer,null);
    store._flushOnExit();
    const disk=JSON.parse(fs.readFileSync(file,'utf8')).threads.find(x=>x.id===t.id);
    assert.ok(!disk.reviewAcceptedHunks?.includes('reviewed-hunk'));
    console.log('CONFIRMED: git:setReviewAccepted returns success but leaves the store clean with no save scheduled and acceptance absent from disk.');
    // Orderly desktop quit calls runner.stopAll -> saveNow; the defect is
    // unbounded unsaved time until that quit or another mutation saves.
  } finally {if(store._bakCopy)await store._bakCopy;fs.rmSync(tmp,{recursive:true,force:true});}
}
