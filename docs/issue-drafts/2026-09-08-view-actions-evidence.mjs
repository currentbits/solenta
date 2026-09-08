// Audit assertions describe current defects; no real requests or agent runs.
// node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types docs/issue-drafts/2026-09-08-view-actions-evidence.mjs
import assert from 'node:assert/strict';
import React from 'react';
import { mount, inAct, unmountAll } from '../../test/support/dom.ts';
import { PlanboardView } from '../../src/components/PlanboardView.tsx';
import { PrListView } from '../../src/components/PrListView.tsx';
import { UsageView } from '../../src/components/UsageView.tsx';
import { FleetView } from '../../src/components/FleetView.tsx';

const projects = ['a','b'].map(id=>({id,slug:`audit/${id}`,name:id,path:`/tmp/audit-${id}`}));
const issue = (project, number) => ({number,title:`Project ${project} only`,url:`https://github.com/audit/${project}/issues/${number}`,state:'OPEN',labels:['plan:todo']});
const listIssues = async p => ({ok:true,issues:[issue(p.endsWith('-a')?'a':'b',p.endsWith('-a')?11:22)]});
const pr = {number:11,title:'Valid PR',url:'https://github.com/audit/a/pull/11',state:'OPEN',headRefName:'fix/a'};
const pending = ()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}};
const errors=[];
const capture=e=>errors.push(e);
process.on('unhandledRejection',capture);
// dom.ts imports node:test, whose global listener rethrows deliberate unhandled
// rejections. Capture only this audit's named transport faults; fail on others.
process.setUncaughtExceptionCaptureCallback(e=>{if(/^audit-(pr|meter|start)-offline$/.test(e.message)){errors.push(e);return} console.error(e);process.exitCode=1;throw e});
const settle=async m=>{await new Promise(r=>setImmediate(r));await m.flush()};
try {
  const start=pending(), started=[];
  let m=await mount(React.createElement(PlanboardView,{projects,listIssues,onStartTask:input=>{started.push(input);return started.length===1?start.promise:Promise.resolve({ok:true})}}));
  await m.click(m.query('[data-plan-start="11"]'));
  await m.change(m.query('[aria-label="Project"]'),'b');
  assert.ok(m.text().includes('Project b only'));
  await inAct(()=>start.resolve({ok:true})); await settle(m);
  assert.equal(m.query('[aria-label="Project"]').value,'b');
  assert.ok(m.text().includes('Project a only'));
  assert.ok(!m.text().includes('Project b only'));
  await m.click(m.query('[data-plan-start="11"]'));
  assert.equal(started[1].projectId,'b'); assert.equal(started[1].ref,'11');
  console.log('CONFIRMED: completing Start task in A after selecting B paints A cards under B; next Start task sends B/#11.');
  m.unmount();

  let failure=pending();
  m=await mount(React.createElement(PrListView,{projects,threads:[],listPrs:p=>p.endsWith('-a')?failure.promise:Promise.resolve({ok:true,prs:[pr]}),onSelectThread:()=>{}}));
  failure.reject(Error('audit-pr-offline')); await settle(m);
  assert.equal(m.byText('Refresh').disabled,true);
  assert.ok(m.text().includes('Loading pull requests'));
  assert.equal(m.query('[data-pr-row]'),null);
  assert.equal(m.query('[role="alert"]'),null);
  assert.ok(errors.some(e=>e.message==='audit-pr-offline'));
  console.log('CONFIRMED: one rejected PR load leaves Refresh disabled, hides successful sibling results and emits unhandled rejection.');
  m.unmount();

  failure=pending();
  m=await mount(React.createElement(PlanboardView,{projects,listIssues,listPrs:()=>failure.promise}));
  failure.reject(Error('audit-meter-offline')); await settle(m);
  assert.equal(m.byText('Refresh').disabled,true);
  assert.ok(m.text().includes('Loading plan'));
  assert.equal(m.query('[data-plan-issue]'),null);
  assert.ok(errors.some(e=>e.message==='audit-meter-offline'));
  console.log('CONFIRMED: rejected optional PR meter blocks successful issue load and strands Planboard Refresh.');
  m.unmount();

  failure=pending();
  m=await mount(React.createElement(PlanboardView,{projects,listIssues,onStartTask:()=>failure.promise}));
  await m.click(m.query('[data-plan-start="11"]'));
  failure.reject(Error('audit-start-offline')); await settle(m);
  assert.equal(m.query('[data-plan-start="11"]').disabled,true);
  assert.equal(m.query('[data-plan-start-note]'),null);
  assert.ok(errors.some(e=>e.message==='audit-start-offline'));
  console.log('CONFIRMED: rejected Start task leaves all start buttons locked without an error.');
  m.unmount();

  let fail=false;
  const d=new Date(), key=[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');
  const usage={byDay:{[key]:{claude:{sonnet:{costUsd:12.5,inputTokens:1000,cachedInputTokens:0,cacheWriteTokens:0,outputTokens:100,turns:2,wastedUsd:0}}}},threadsByDay:{}};
  m=await mount(React.createElement(UsageView,{loadUsage:async()=>{if(fail)throw Error('audit-usage-offline');return usage}}));
  assert.ok(m.text().includes('$12.50'));
  fail=true;await m.click(m.byText('Refresh'));await settle(m);
  assert.ok(!m.text().includes('$12.50'));assert.equal(m.query('[role="alert"]'),null);
  assert.ok(m.text().includes('No usage'));
  console.log('CONFIRMED: Usage refresh failure erases loaded $12.50 report, displays No usage, and gives no error.');
  m.unmount();

  fail=false;const now=Date.now();
  const evidence={collectedAt:now,durabilityWindowDays:14,notes:[],prs:[],threads:[{threadId:'fleet-a',projectId:'a',title:'Retained fleet row',provider:'claude',model:'sonnet',createdAt:now-60000,endedAt:now,activeMs:30000,costUsd:12.5,inputTokens:100,outputTokens:100,turns:1,linesAdded:null,linesSurviving:null,durabilityMeasurable:false,feltSavedMs:null}]};
  m=await mount(React.createElement(FleetView,{loadEvidence:async()=>{if(fail)throw Error('audit-fleet-offline');return evidence}}));
  assert.ok(m.text().includes('Retained fleet row'));
  fail=true;await m.click(m.byText('Refresh'));await settle(m);
  assert.ok(m.text().includes('Retained fleet row')); assert.equal(m.query('[role="alert"]'),null);assert.ok(!m.text().includes('audit-fleet-offline'));
  console.log('CONFIRMED: Fleet retains old report after failed refresh but hides the failure and any stale-data warning.');
  m.unmount();

  m=await mount(React.createElement(PrListView,{projects,threads:[],listPrs:async()=>({ok:true,prs:[pr]}),onSelectThread:()=>{}}));
  assert.equal(m.query('input[type="search"], [role="searchbox"]'),null);
  assert.equal(m.query('select'),null);
  console.log('CONFIRMED: PR list has no search, scope or sort controls; all triage is manual scanning.');
  m.unmount();
} finally {unmountAll();process.removeListener('unhandledRejection',capture);process.setUncaughtExceptionCaptureCallback(null)}
