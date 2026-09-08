// Evidence for the current gap; no feature implementation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import React from 'react';
import {mount,inAct} from '../../test/support/dom.ts';
import {AutomationsView} from '../../src/components/AutomationsView.tsx';
const require=createRequire(import.meta.url);
const {Store}=require('../../electron/store.js');
const services=require('../../electron/services.js');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'solenta-features-audit-'));
const store=new Store(path.join(tmp,'store.json'));
const project={id:'p1',name:'Audit',slug:'audit',path:tmp};
store.setProjects([project]);
let m;
try {
  const pending=[];
  m=await mount(React.createElement(AutomationsView,{
    automations:[],projects:[project],providers:[{id:'claude',name:'Claude',models:[]}],
    onCreate:async input=>{services.addAutomation(store,input);await new Promise(resolve=>pending.push(resolve));},
    onUpdate:async()=>{},onRemove:async()=>{},onRunNow:async()=>{},
  }));
  await m.type(m.query('[aria-label="Name"]'),'Daily review');
  await m.type(m.query('[aria-label="Prompt"]'),'Review recent changes');
  const submit=m.query('[data-automation-create] button[type="submit"]');
  await m.click(submit);
  assert.equal(submit.disabled,false);
  await m.click(submit);
  const autos=store.getAutomations();
  assert.equal(autos.length,2);
  assert.notEqual(autos[0].id,autos[1].id);
  assert.equal(autos[0].prompt,autos[1].prompt);
  assert.ok(autos.every(a=>a.enabled));
  await inAct(()=>pending.forEach(resolve=>resolve()));
  console.log('CONFIRMED: repeated Add automation while pending creates two enabled schedules for the same form.');
  const before=autos[0];
  const updated=services.updateAutomation(store,{id:before.id,prompt:'Revised review scope',model:'claude-sonnet-5'});
  assert.equal(updated.id,before.id);
  assert.equal(updated.nextRunAt,before.nextRunAt);
  assert.equal(updated.prompt,'Revised review scope');
  console.log('VERIFIED: existing updateAutomation already edits prompt/model in place and preserves nextRunAt when schedule is unchanged.');
} finally {
  m?.unmount();store.saveNow();if(store._bakCopy)await store._bakCopy;fs.rmSync(tmp,{recursive:true,force:true});
}
