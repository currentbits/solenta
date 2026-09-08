// Reproduces current multi-worker behavior in an isolated temporary repo.
// No live branches, agents, remotes, or GitHub issues are changed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {Store}=require('../../electron/store.js');
const services=require('../../electron/services.js');
const {setupWorktree,mergeWorktree}=require('../../electron/worktrees.js');
const issues=require('../../electron/issues.js');
const originalComplete=issues.completeIssue;
const completed=[];
issues.completeIssue=async(...args)=>{completed.push(args);return {ok:true};};
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'solenta-merge-audit-'));
const repo=path.join(tmp,'repo');fs.mkdirSync(repo);
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const store=new Store(path.join(tmp,'store.json'));
try {
  git(repo,'init','-b','main');git(repo,'config','user.name','Audit');git(repo,'config','user.email','audit@example.invalid');git(repo,'config','commit.gpgsign','false');
  fs.writeFileSync(path.join(repo,'shared.txt'),'base\n');git(repo,'add','.');git(repo,'commit','-m','base');
  const mainBefore=git(repo,'rev-parse','main');
  store.setProjects([{id:'audit',name:'Audit',slug:'audit',path:repo}]);
  const bind=t=>setupWorktree({store,threadId:t.id,worktreeBase:path.join(tmp,'worktrees')});
  const lead=bind(services.createThread(store,{projectId:'audit',title:'Lead'}));
  fs.writeFileSync(path.join(lead.worktreePath,'lead-only.txt'),'shared API\n');git(lead.worktreePath,'add','.');git(lead.worktreePath,'commit','-m','lead API');
  const a=bind(services.forkWorkerThread(store,{threadId:lead.id}));
  const b=bind(services.forkWorkerThread(store,{threadId:lead.id}));
  assert.ok(!fs.existsSync(path.join(a.worktreePath,'lead-only.txt')));
  assert.equal(git(a.worktreePath,'rev-parse','HEAD'),mainBefore);
  console.log('CONFIRMED: forkWorkerThread + setupWorktree starts from main, omitting committed lead-only work.');
  for(const [t,text] of [[a,'worker A\n'],[b,'worker B\n']]) {
    fs.writeFileSync(path.join(t.worktreePath,'shared.txt'),text);git(t.worktreePath,'add','.');git(t.worktreePath,'commit','-m',text.trim());
  }
  store.updateThread(a.id,{issueNumber:123,status:'done'});
  mergeWorktree({store,threadId:a.id,intoPath:lead.worktreePath});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(git(repo,'rev-parse','main'),mainBefore);
  assert.equal(completed.length,1);assert.equal(completed[0][1],123);
  assert.equal(store.getThread(a.id).branch,null);
  console.log('CONFIRMED: integrating A into the lead invokes issue completion and clears A branch/worktree even though main has not moved. GitHub write was stubbed.');
  const leadAfterA=git(lead.worktreePath,'rev-parse','HEAD');
  let failure;
  try {mergeWorktree({store,threadId:b.id,intoPath:lead.worktreePath});} catch(e){failure=e;}
  assert.match(failure?.message??'',/MERGE_CONFLICT/);
  assert.ok(failure.message.includes(`conflicts with ${lead.branch}`));
  assert.equal(git(b.worktreePath,'diff','--name-only','--diff-filter=U'),'shared.txt');
  assert.ok(fs.readFileSync(path.join(b.worktreePath,'shared.txt'),'utf8').includes('<<<<<<<'));
  assert.equal(git(lead.worktreePath,'rev-parse','HEAD'),leadAfterA);
  console.log('VERIFIED WORKING: B conflict is replayed against the lead branch, with shared.txt conflict entries in B; lead HEAD stays intact.');
} finally {
  issues.completeIssue=originalComplete;store.saveNow();if(store._bakCopy)await store._bakCopy;
  fs.rmSync(tmp,{recursive:true,force:true});
}
