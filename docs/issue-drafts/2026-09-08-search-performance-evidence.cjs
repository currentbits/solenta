// Disposable on-disk shards, real Store search; no live store is loaded.
const fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const assert=require('node:assert/strict');
const {performance}=require('node:perf_hooks');
const {Store}=require('../../electron/store.js');
(async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'solenta-search-perf-'));
 let store;
 try {
  const file=path.join(tmp,'coder-store.json');
  const threads=Array.from({length:100},(_,i)=>({id:`thread-${i}`,projectId:'audit',title:`Archive ${i}`,archived:true,updatedAt:i,status:'idle'}));
  fs.writeFileSync(file,JSON.stringify({projects:[],threads,messagesByThread:{},workLogByThread:{},usageByThread:{}}));
  fs.mkdirSync(path.join(tmp,'messages'));
  const text='Synthetic transcript payload. '.repeat(35000);
  for(const t of threads) fs.writeFileSync(path.join(tmp,'messages',`${t.id}.json`),JSON.stringify([{id:`message-${t.id}`,role:'assistant',text,createdAt:1}]));
  store=new Store(file);
  const before=Object.keys(store._messagesHydrated).length;
  global.gc?.(); const heapBefore=process.memoryUsage().heapUsed;
  const started=performance.now();
  const hits=store.searchThreads('unfindable-audit-needle');
  const elapsed=performance.now()-started;
  global.gc?.(); const heapAfter=process.memoryUsage().heapUsed;
  const after=Object.keys(store._messagesHydrated).length;
  assert.equal(before,0); assert.equal(after,100); assert.equal(hits.length,0);
  console.log(JSON.stringify({fixture:'100 archived threads, ~100MB total; warm OS file cache',hydratedBefore:before,hydratedAfter:after,searchMainThreadBlockedMs:Math.round(elapsed),retainedHeapGrowthMiB:Math.round((heapAfter-heapBefore)/1024/1024)},null,2));
  await store._bakCopy;
 } finally {if(store){store._dirty=false;process.removeListener('exit',store._flushOnExit)} fs.rmSync(tmp,{recursive:true,force:true,maxRetries:5,retryDelay:10})}
})().catch(e=>{console.error(e);process.exitCode=1});
