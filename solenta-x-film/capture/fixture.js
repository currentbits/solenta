// Fresh demonstration data. All visible UI comes from the current app source.
import { devCoder } from '../../src/devCoder.ts';
import providers from './providers.json';
import { savePaneLayout } from '../../src/paneLayout.ts';
const api = devCoder;
const statusGet = api.app.status.bind(api.app);
api.app.status = async () => ({...await statusGet(),build:globalThis.__SOLENTA_FILM_BUILD__});
const now = Date.now();
const project = {id: 'film-project', name: 'Solenta', slug: 'currentbits/solenta', path: '/demo/solenta'};
const scene = globalThis.__SOLENTA_FILM_SCENE__ || 'overview';
const thread = (id, title, provider, extras = {}) => ({
  id, title, projectId: project.id, provider, model: null, status: 'idle',
  branch: 'feat/project-search', baseBranch: 'main', prNumber: null, prUrl: null,
  lastError: null, lastErrorKind: null, createdAt: now - 600000, updatedAt: now - 60000,
  runStartedAt: null, archived: false, settledOverride: null, settledAt: null,
  lastVisitedAt: now, pinnedAt: null, snoozedUntil: null, sessionId: 'demo-session',
  permissionMode: 'default', reasoningEffort: null, webSearch: false,
  worktreePath: '/demo/worktrees/project-search', handoffFrom: null, muted: false, ejected: false,
  notes: '', tags: [], ...extras,
});
const lead = thread('film-lead', 'Build a fast project search', 'claude', {
  model: providers.find(p=>p.id==='claude')?.models[0] || null,
  orchestrator: true,
  ...(scene === 'workers' ? {status: 'working', runStartedAt: now - 83000} : {}),
  planSteps: [
    {step: 'Read the existing search and shared memory', status: 'done'},
    {step: 'Build search, keyboard controls, and tests', status: scene === 'workers' ? 'doing' : 'done'},
    {step: 'Review the changes and run verification', status: scene === 'workers' ? 'todo' : 'done'},
  ],
});
const threads = [lead,
  thread('film-ui', 'Search interface', 'codex', {handoffFrom: lead.id, status: 'working', runStartedAt: now - 45000, branch: 'feat/search-ui'}),
  thread('film-api', 'Search index', 'grok', {handoffFrom: lead.id, status: 'working', runStartedAt: now - 38000, branch: 'feat/search-index'}),
  thread('film-test', 'Keyboard and search tests', 'claude', {handoffFrom: lead.id, status: 'working', runStartedAt: now - 29000, branch: 'test/search'}),
  thread('film-memory', 'Remember the project conventions', 'codex', {updatedAt: now - 180000}),
  thread('film-review', 'Review the search changes', 'claude', {updatedAt: now - 240000}),
];
for (const t of threads) if (t.handoffFrom) {
  t.worktreePath = `/demo/worktrees/${t.id}`;
  if (scene !== 'workers') t.status = 'done';
}
if (scene === 'composer') Object.assign(lead,{planSteps:[],branch:null,worktreePath:null,sessionId:null});
const messages = [
  {id:'prompt',role:'user',text:'Add fast project search. Keep the existing design, support the keyboard, and test the important paths.',createdAt:now-110000},
  {id:'answer',role:'assistant',text: scene === 'workers'
    ? 'I found the existing helpers in `src/search.ts` and the project conventions in shared memory.\n\nI split the work across three agents, each in its own worktree.\n\n- **Codex** is building the search interface.\n- **Grok** is updating the search index.\n- **Claude Code** is testing keyboard navigation.\n\nI will review their changes together before merging.'
    : 'Project search is ready for review.\n\nI reused `src/search.ts` and followed the conventions from shared memory.\n\n- Filter projects as you type.\n- Move through results with the arrow keys.\n- Press Enter to open a project.\n- Press Escape to clear the search.\n\nThe changes are isolated in a worktree. Keyboard navigation and search tests pass.',createdAt:now-60000},
];
const detail = (id) => ({thread: threads.find(t=>t.id===id) || lead, messages: scene === 'composer' ? [] : messages, workLog: [], workflow:null, usage:null});
api.projects.list = async () => [project];
api.projects.codeMap = async () => ({projectId:project.id,updatedAt:now,fileCount:942,symbolCount:5322,headSha:'9d08e29',defaultBranch:'main',modules:[],dependencies:['react','electron']});
api.projects.lintAgentConfig = async () => ({projectId:project.id,files:[],score:100,grade:'A',memory:{considered:4,covered:4,missing:[]},issues:[],recommendations:[]});
api.spaces.list = async () => [];
api.threads.list = async () => threads;
api.threads.get = async id => detail(id);
api.threads.summaries = async () => threads.map(t => ({...t,lastActivity:{text:t.handoffFrom?'Working in an isolated worktree.':'Ready for review.',at:now-40000}}));
api.threads.crewTasks = async () => ({rootThreadId:lead.id,tasks:[]});
api.threads.crewIntegration = async () => null;
api.threads.markVisited = async () => {};
api.on = () => () => {};
const settingsGet = api.settings.get.bind(api.settings);
api.settings.get = async () => ({...await settingsGet(),onboardingSeen:true,theme:'dark',agentsPanelDefault:'closed',agentsPanelRememberLast:false});
api.providers.list = async () => providers;
api.git.prStatus = async () => null;
api.git.prChecks = async () => [];
api.git.listCheckpoints = async () => [];
const patch = `diff --git a/src/search.ts b/src/search.ts
index 12aa000..45bb000 100644
--- a/src/search.ts
+++ b/src/search.ts
@@ -1,6 +1,10 @@
 export function searchProjects(projects, query) {
-  return projects.filter(project =>
-    project.name.includes(query)
-  );
+  const term = query.trim().toLowerCase();
+  if (!term) return projects;
+
+  return projects.filter(project => {
+    const name = project.name.toLowerCase();
+    return name.includes(term);
+  });
 }
`;
api.git.diff = async () => scene === 'composer' ? {files:[],patch:'',truncated:false} : ({files:[{path:'src/search.ts',status:'M',additions:7,deletions:3},{path:'src/components/ProjectSearch.tsx',status:'M',additions:24,deletions:5},{path:'test/search.test.ts',status:'A',additions:32,deletions:0}],patch,truncated:false});
api.git.reviewItinerary = async () => ({items:[],generatedAt:now});
const memory = [
  ['convention','Use the existing search helpers','Project search belongs in src/search.ts. Reuse its normalization and matching helpers before adding another implementation.'],
  ['strategy','Keyboard navigation is part of the feature','Arrow keys move the active result. Enter opens it. Escape clears the query. Keep focus on the input while moving through results.'],
  ['knowledge','Project scope uses the repository path','Pass the repository path to shared memory. The server resolves worktrees to the same project so every agent can retrieve the same context.'],
  ['convention','Keep the interface consistent','Use the existing components and theme variables. Preserve focus indicators, readable contrast, and reduced-motion preferences.'],
].map(([type,title,body],i)=>({id:`film-memory-${i}`,type,title,body,project:project.path,importance:3,createdAt:new Date(now-3600000).toISOString(),updatedAt:new Date(now-3600000).toISOString(),source:i%2?'codex':'claude',citations:[]}));
api.memory.recent = async () => memory;
api.memory.search = async ({query}) => memory.filter(m=>(m.title+m.body).toLowerCase().includes(query.toLowerCase()));
api.memory.get = async ({id}) => memory.find(m=>m.id===id);
api.issues.list = async () => ({ok:true,issues:[
  {number:101,title:'Build a fast project search',state:'OPEN',labels:['plan:doing'],url:'https://github.com/currentbits/solenta'},
  {number:102,title:'Add keyboard navigation',state:'OPEN',labels:['plan:todo'],url:'https://github.com/currentbits/solenta'},
  {number:103,title:'Document project conventions',state:'CLOSED',labels:['plan:done'],url:'https://github.com/currentbits/solenta'},
]});
localStorage.clear();
localStorage.setItem('solenta-theme','dark');
localStorage.setItem('coder.bootSnapshot.v1',JSON.stringify({savedAt:now,projects:[project],threads,selectedThreadId:lead.id}));
if (scene === 'git') savePaneLayout(lead.id,{kind:'leaf',id:'film-diff',type:'diff'});
window.coder = api;
export { api };
