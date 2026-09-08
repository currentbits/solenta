// Current-defect assertions, synthetic callbacks only. No writes or processes.
// node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types docs/issue-drafts/2026-09-08-editor-actions-evidence.mjs
import assert from 'node:assert/strict';
import React, {useState} from 'react';
import {mount, inAct, unmountAll} from '../../test/support/dom.ts';
import {MemoryTab} from '../../src/components/MemoryTab.tsx';
import {WorkflowsModal} from '../../src/components/WorkflowsModal.tsx';
import {SkillsTab} from '../../src/components/SkillsTab.tsx';
import {useCoder} from '../../src/useCoder.ts';
import {createFakeCoder,installFakeCoder} from '../../test/support/fakeCoder.ts';
import {createRequire} from 'node:module';
const {validateMcpServers}=createRequire(import.meta.url)('../../electron/mcp.js');
const empty = async()=>[];
const noop = async()=>{};
const pending = ()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
const memoryProps={recentMemory:empty,searchMemory:empty,getMemory:noop,updateMemory:noop,removeMemory:noop,storeMemory:noop};
const report={files:[],grade:'A',score:100,memory:{missing:[],considered:0,covered:0}};
try {
  const writes=[];let select;
  const lint=async()=>report;
  const preview=async({projectId})=>({projectId,files:[{path:'AGENTS.md',content:'PREVIEW FOR '+projectId,exists:true}]});
  function MemoryHarness(){const [project,setProject]=useState('a');select=setProject;return React.createElement(MemoryTab,{...memoryProps,projectSlug:'/tmp/audit-'+project,projectId:project,lintAgentConfig:lint,previewAgentConfig:preview,writeAgentConfig:async input=>{writes.push(input);return {written:['AGENTS.md']}}})}
  let m=await mount(React.createElement(MemoryHarness));
  await m.click(m.byText('Preview'));
  await m.click(m.byText('Write AGENTS.md'));
  assert.equal(writes.length,0);
  await inAct(()=>select('b'));await m.flush();
  assert.ok(m.query('[data-config-preview]').textContent.includes('PREVIEW FOR a'));
  assert.ok(m.byText('Confirm write'));
  await m.click(m.byText('Confirm write'));
  assert.deepEqual(writes,[{projectId:'b'}]);
  console.log('CONFIRMED: preview and confirmation for A survive project switch; Confirm write dispatches B.');
  m.unmount();

  const workflows=['a','b'].map(id=>({id,name:'Workflow '+id,builtin:false,phases:[{name:'phase',agentCount:1,instruction:'Do work',provider:'claude',model:null}]}));
  const providers=[{id:'claude',name:'Claude',available:true,models:[]}];
  m=await mount(React.createElement(WorkflowsModal,{open:true,onClose:()=>{},workflows,providers,onSave:noop,onRemove:noop}));
  await m.type(m.query('#wf-name'),'Unsaved custom workflow');
  await m.click(m.byText('Workflow b'));
  await m.click(m.byText('Workflow a'));
  assert.equal(m.query('#wf-name').value,'Workflow a');
  console.log('CONFIRMED: selecting another workflow and back discards unsaved editor text without confirmation.');
  m.unmount();

  let setOpen;const save=pending();
  function WorkflowHarness(){const [open,updateOpen]=useState(true);setOpen=updateOpen;return React.createElement(WorkflowsModal,{open,onClose:()=>updateOpen(false),workflows,providers,onSave:()=>save.promise,onRemove:noop})}
  m=await mount(React.createElement(WorkflowHarness));
  await m.click(m.byText('Save'));
  assert.ok(m.byText('Saving'));
  await m.click(m.query('[aria-label="Close"]'));
  assert.equal(m.query('[role="dialog"]'),null);
  await inAct(()=>setOpen(true));await m.flush();
  await m.click(m.byText('Workflow b'));
  await m.type(m.query('#wf-name'),'New B draft');
  await inAct(()=>save.resolve({...workflows[0],name:'Saved A'}));await m.flush();
  assert.equal(m.query('#wf-name').value,'Saved A');
  console.log('CONFIRMED: closing/reopening during save enables a new edit; old save completion replaces the new B draft with A.');
  m.unmount();

  const saved=[];
  m=await mount(React.createElement(SkillsTab,{projectPath:'/tmp/audit',settings:{mcpServers:[]},saveSettings:noop,listMcpServers:empty,listMcpCatalog:empty,listSkills:empty,listSkillCatalog:empty,saveMcpServer:async x=>saved.push(x),removeMcpServer:noop,setMcpEnabled:noop,pickMcpImport:noop,previewMcpImport:noop,installMcpImport:noop,discardMcpImport:noop,addSkill:noop,removeSkill:noop,syncSkills:noop,pickSkillImport:noop,previewSkillImport:noop,installSkillImport:noop,discardSkillImport:noop}));
  await m.type(m.query('[aria-label="MCP server name"]'),'local-audit');
  await m.type(m.query('[aria-label="MCP command"]'),'node');
  await m.type(m.query('[aria-label="MCP command arguments"]'),'"/tmp/My Tools/server.mjs" --label "hello world"');
  await m.click(m.byText('Add local server'));
  assert.deepEqual(saved[0].args,['"/tmp/My','Tools/server.mjs"','--label','"hello','world"']);
  assert.deepEqual(validateMcpServers(saved)[0].args,saved[0].args);
  console.log('CONFIRMED: MCP argument field splits quoted paths and values into invalid argv elements, saves without validation.');
  m.unmount();

  const fake=createFakeCoder();const committed=[];let failRefresh=false;
  fake.api.workflows.list=async()=>{if(failRefresh)throw Error('audit-workflow-refresh-offline');return committed};
  fake.api.workflows.save=async payload=>{const row={...payload,id:'saved-'+(committed.length+1),builtin:false};committed.push(row);return row};
  installFakeCoder(fake);
  function HookWorkflowHarness(){const api=useCoder();return React.createElement(WorkflowsModal,{open:true,onClose:()=>{},workflows:api.workflows,providers,onSave:api.saveWorkflow,onRemove:api.removeWorkflow})}
  m=await mount(React.createElement(HookWorkflowHarness));
  failRefresh=true;
  await m.click(m.byText('Save'));
  assert.equal(committed.length,1);
  assert.ok(m.query('[role="alert"]').textContent.includes('audit-workflow-refresh-offline'));
  await m.click(m.byText('Save'));
  assert.equal(committed.length,2);
  assert.equal(committed[0].name,committed[1].name);
  assert.notEqual(committed[0].id,committed[1].id);
  console.log('CONFIRMED: real useCoder treats acknowledged workflow save as failed when list refresh rejects; retry issues another create.');
  m.unmount();
} finally {unmountAll()}
