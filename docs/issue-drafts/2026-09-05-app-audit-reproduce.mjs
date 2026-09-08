// Audit evidence: these checks assert the current defects, not corrected behavior.
import { createRequire } from 'node:module';
import { createFakeCoder, installFakeCoder, project, thread, detail } from '../../test/support/fakeCoder.ts';
import App from '../../src/App.tsx';
const require = createRequire(import.meta.url);
import assert from 'node:assert/strict';
import React from 'react';
import { mount, inAct } from '../../test/support/dom.ts';
import { Sidebar } from '../../src/components/Sidebar.tsx';
import { SettingsModal } from '../../src/components/SettingsModal.tsx';
const h = React.createElement;
const noop = () => {};
const auditProject = { id: 'audit', name: 'Audit', slug: 'audit', path: '/tmp/audit' };
const sidebar = await mount(h(Sidebar, {
  appName: 'Solenta', searchPlaceholder: 'Search threads', projectsHeader: 'Projects',
  projects: [auditProject], threads: [], providers: [], activeThreadId: null,
  onSelectThread: noop, onCreateThread: noop, onAddProject: noop,
  searchThreads: async () => { throw new Error('Search service unavailable'); },
}));
await sidebar.type(sidebar.query('[aria-label="Search threads"]'), 'audit');
await inAct(async () => { await new Promise(r => setTimeout(r, 350)); });
await sidebar.flush();
assert.match(sidebar.text(), /No threads match/);
assert.doesNotMatch(sidebar.text(), /Search service unavailable/);
console.log('Confirmed: a rejected search renders No threads match with no failure explanation.');
sidebar.unmount();

const trigger = document.createElement('button');
trigger.textContent = 'Open settings';
document.body.append(trigger);
trigger.focus();
const settings = await mount(h(SettingsModal, {
  open: true, onClose: noop, settings: null, status: null,
  onSaveSettings: async patch => patch,
}));
assert.ok(settings.query('[role="dialog"][aria-modal="true"]'));
assert.equal(document.activeElement, trigger);
assert.equal(trigger.closest('[inert]'), null);
console.log('Confirmed: opening Settings leaves keyboard focus on the background trigger.');
settings.unmount();
trigger.remove();


let seq = 0;
async function boot({ busy = false, queued = null } = {}) {
  const a = thread({id: 'audit-a-' + ++seq, title: 'Audit A', status: busy ? 'working' : 'idle', queued});
  const b = thread({id: 'audit-b-' + seq, title: 'Audit B', status: 'idle'});
  const fake = createFakeCoder({projects:[project()],threads:[a,b],details:{[a.id]:detail({thread:a}),[b.id]:detail({thread:b})}});
  const shell = await mount(h('div'));
  window.localStorage.clear();
  installFakeCoder(fake);
  shell.unmount();
  const m = await mount(h(App));
  const select = async title => { await m.click(m.query('button[aria-label^="Select thread: '+ title + '"]')); await m.flush(); };
  await select('Audit A');
  return {a,b,fake,m,select};
}

{
  const {m,select} = await boot();
  await m.type(m.query('textarea'), 'Unsent draft that must survive navigation');
  await select('Audit B');
  await select('Audit A');
  assert.equal(m.query('textarea').value, '');
  console.log('CONFIRMED: App thread switch A → B → A loses the unsent A draft.');
  m.unmount();
}
{
  const {fake,m} = await boot({busy:true});
  fake.api.threads.setQueued = async () => { throw new Error('Queue write rejected'); };
  await m.type(m.query('textarea'), 'Follow-up never saved');
  await m.click(m.query('button[aria-label="Send"]'));
  await m.flush();
  assert.equal(m.query('textarea').value, '');
  assert.equal(m.query('[data-queued-prompt]'), null);
  assert.match(m.text(), /Queue write rejected/);
  console.log('CONFIRMED: rejected queue write clears composer; no queued copy exists.');
  m.unmount();
}
{
  const {a,fake,m} = await boot({busy:true,queued:{prompt:'Still queued on host'}});
  fake.api.threads.setQueued = async () => { throw new Error('Cancel rejected'); };
  await m.click(m.query('[data-cancel-queued]'));
  await m.flush();
  assert.equal(m.query('[data-queued-prompt]'), null);
  assert.equal((await fake.api.threads.get(a.id)).thread.queued.prompt, 'Still queued on host');
  console.log('CONFIRMED: failed cancellation hides the queue while the host still holds it.');
  m.unmount();
}
{
  const {fake,m} = await boot({busy:true,queued:{prompt:'Original queued text'}});
  fake.api.threads.setQueued = async () => { throw new Error('Edit rejected'); };
  await m.click(m.query('[data-edit-queued]'));
  await m.type(m.query('[data-edit-queued-input]'), 'Important edited instructions');
  await m.click(m.query('[data-save-queued-edit]'));
  await m.flush();
  assert.equal(m.query('[data-edit-queued-input]'), null);
  assert.match(m.query('[data-queued-prompt]').textContent, /Original queued text/);
  await m.click(m.query('[data-edit-queued]'));
  assert.equal(m.query('[data-edit-queued-input]').value, 'Original queued text');
  console.log('CONFIRMED: rejected queue edit discards edited text; reopening restores only the original.');
  m.unmount();
}
{
  const {a,fake,m} = await boot({queued:{prompt:'Retry this once',error:'Previous delivery failed'}});
  const originalSetQueued = fake.api.threads.setQueued;
  fake.api.threads.setQueued = async input => {
    if (input.prompt === null) throw new Error('Clear rejected');
    return originalSetQueued(input);
  };
  await m.click(m.query('[data-retry-queued]'));
  await m.flush();
  assert.equal((await fake.api.threads.get(a.id)).thread.queued.prompt, 'Retry this once\n\nRetry this once');
  assert.equal(fake.of('runs.start').length, 0);
  console.log('CONFIRMED: retry whose clear fails appends a second copy to the host queue.');
  m.unmount();
}
{
  const {b,fake,m,select} = await boot();
  const get = fake.api.threads.get;
  let release;
  fake.api.threads.get = async id => id === b.id ? new Promise(resolve => { release = resolve; }) : get(id);
  await select('Audit B');
  assert.equal(typeof release, 'function');
  assert.match(m.text(), /Select a thread/);
  console.log('CONFIRMED: while selected thread B is loading, App says Select a thread.');
  await inAct(async () => release(await get(b.id)));
  await m.flush();
  m.unmount();
}
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Store} = require('../../electron/store.js');
const services = require('../../electron/services.js');
const {createRunner} = require('../../electron/runner.js');
await (async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'solenta-audit-'));
  const store = new Store(path.join(tmp, 'store.json'));
  const runner = createRunner({store, core:{}, userDataPath:tmp, pushFn:()=>{}});
  try {
    store.data.projects.push({id:'audit',name:'Audit',slug:'audit',path:tmp});
    const thread = services.createThread(store,{projectId:'audit',title:'Audit',provider:'simulate'});
    services.setQueued(store,{threadId:thread.id,prompt:'Previously queued instructions'});
    services.setSettings(store,{dailyBudgetUsd:1});
    store.recordSpend(1);
    await assert.rejects(runner.startRun({threadId:thread.id,prompt:'New user instruction'}), /Daily budget reached/);
    assert.equal(store.getThread(thread.id).queued, null);
    assert.equal(store.getMessages(thread.id).length, 0);
    store.saveNow();
    const reloaded = new Store(path.join(tmp, 'store.json'));
    assert.equal(reloaded.getThread(thread.id).queued, null);
    console.log('CONFIRMED: budget rejection after manual send deletes the existing queue, including on disk, without starting a run.');
    reloaded.saveNow();
  } finally {
    runner.stopAll();
    store.saveNow();
    fs.rmSync(tmp,{recursive:true,force:true});
  }
})().catch(err=>{console.error(err);process.exitCode=1;});
