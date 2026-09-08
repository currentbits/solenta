// Audit evidence: asserts current behavior, not desired regression expectations.
// Run with the renderer hooks shown in 2026-09-06-views-audit.md.
import assert from 'node:assert/strict';
import React from 'react';
import {mount, unmountAll} from '../../test/support/dom.ts';
import {ActivityView} from '../../src/components/ActivityView.tsx';
import {DigestView} from '../../src/components/DigestView.tsx';
import {PlanboardView} from '../../src/components/PlanboardView.tsx';
import {KanbanView} from '../../src/components/KanbanView.tsx';

const projects=[{id:'audit',name:'Audit',slug:'audit/example',path:'/tmp/solenta-view-audit'}];
const now=Date.now();
try {
  let fail=false;
  let m=await mount(React.createElement(ActivityView,{
    projects,projectScope:'audit',onSelectThread:()=>{},
    listActivity:async()=>{if(fail)throw Error('offline');return [{id:'event',kind:'done',threadId:'thread',projectId:'audit',threadTitle:'Completed audit',at:now}];},
  }));
  await m.flush();
  assert.ok(m.text().includes('Completed audit'));
  fail=true;
  await m.click(m.byText('Refresh'));
  assert.ok(m.text().includes('No activity yet'));
  assert.ok(!m.text().includes('Completed audit'));
  assert.equal(m.query('[role="alert"]'),null);
  console.log('CONFIRMED: failed Activity refresh discards loaded rows and says No activity yet.');
  m.unmount();

  m=await mount(React.createElement(DigestView,{
    projects,onSelectThread:()=>{},loadDigest:async()=>{throw Error('offline');},markSeen:async()=>({seenAt:now}),
  }));
  await m.flush();
  assert.ok(m.text().includes('Nothing ran while you were away.'));
  assert.equal(m.query('[role="alert"]'),null);
  assert.equal(m.byText('Mark reviewed').disabled,false);
  console.log('CONFIRMED: failed initial Digest load says nothing ran and leaves Mark reviewed enabled.');
  m.unmount();

  const boardProps={projects,initialProjectId:'audit',listIssues:async()=>({ok:true,issues:[]})};
  m=await mount(React.createElement(PlanboardView,boardProps));
  await m.change(m.query('[data-plan-sort]'),'number-asc');
  assert.equal(m.query('[data-plan-sort]').value,'number-asc');
  assert.equal(m.query('input[type="search"], [role="searchbox"]'),null);
  m.unmount();
  m=await mount(React.createElement(PlanboardView,boardProps));
  assert.equal(m.query('[data-plan-sort]').value,'updated');
  console.log('CONFIRMED: Planboard remount resets chosen sort; mounted board offers no search input. App conditionally unmounts the view on thread selection (source trace).');
  m.unmount();

  for(const [Component,props] of [
    [ActivityView,{listActivity:async()=>[]}],
    [KanbanView,{threads:[],providers:[]}],
  ]) {
    m=await mount(React.createElement(Component,{projects,projectScope:'audit',onSelectThread:()=>{},...props}));
    await m.flush();
    assert.ok(!m.query('header').textContent.includes('audit/example'));
    assert.equal(m.query('[aria-label="Project"]'),null);
    console.log(`CONFIRMED: ${Component.name} scoped empty state has no visible project in its header or in-view Project selector.`);
    m.unmount();
  }
} finally {unmountAll();}
