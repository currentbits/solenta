// Isolated evidence for Codex writer-lock + Retry-after-notice.
// Temp fixtures only. Does not spawn real Codex, touch ~/.codex, or kill Desktop.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {
  lastUserMessage,
  retryAnchorEventId,
  retryButtonTitle,
} from '../../src/retryTurn.ts';

const require = createRequire(import.meta.url);
const {Store} = require('../../electron/store.js');
const services = require('../../electron/services.js');
const {createRunner, classifyClaudeResultError, formatRunExitError} = require('../../electron/runner.js');
const {getProvider} = require('../../electron/providers.js');
const {
  classifyContextOverflow,
  classifyCliUpgrade,
} = require('../../electron/quotaWait.js');
const {materializeCodexGuardrailHome} = require('../../electron/codex-guardrail.js');
const {writeFakeBin} = require('../../electron/test/support/fakeBin.js');

const LOCK_ID = '01a072f7-10e0-7fd2-b691-7d481327516f';
const LIVE_STDERR = [
  `2026-09-06T06:31:14.325982Z ERROR codex_core::session::session: failed to initialize thread persistence: thread-store conflict: thread ${LOCK_ID} already has an active writer`,
  'Error: thread/resume failed with error: failed to load thread: thread-store conflict: thread already has an active writer (code -32600)',
].join('\n');

function waitFor(predicate, {timeoutMs = 15000, intervalMs = 20} = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      try {
        if (predicate()) return resolve();
      } catch (e) {
        return reject(e);
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error('waitFor timed out'));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function git(cwd, args) {
  execFileSync('git', args, {cwd, stdio: 'ignore'});
}

const dumped = formatRunExitError(1, LIVE_STDERR);
assert.match(dumped, /thread-store conflict/);
assert.match(dumped, /already has an active writer/);
assert.match(dumped, /^Run error \(exit 1\):/);
assert.doesNotMatch(dumped, /Quit Codex Desktop|Retry will keep failing|Session reset/);
assert.equal(classifyContextOverflow(dumped), null);
assert.equal(classifyCliUpgrade(dumped), null);
const classified = classifyClaudeResultError({errors: [], stderr: LIVE_STDERR});
assert.equal(classified.kind, 'fail');
assert.equal(classified.sessionLost, false);
assert.doesNotMatch(classified.text, /Session reset/);
console.log('CONFIRMED: Codex writer-lock is dumped as opaque stderr. sessionLost/overflow/upgrade classifiers miss it.');

const resumeArgs = getProvider('codex').buildArgs({
  prompt: '[orchestration] Worker finished',
  sessionId: LOCK_ID,
});
assert.equal(resumeArgs[0], 'exec');
assert.equal(resumeArgs[1], 'resume');
assert.equal(resumeArgs[2], LOCK_ID);
assert.ok(!resumeArgs.includes('--sandbox'));
console.log('CONFIRMED: a lead with a Codex sessionId always spawns `exec resume <id>`.');

const overlayTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'solenta-codex-overlay-'));
try {
  const source = path.join(overlayTmp, 'source');
  const dest = path.join(overlayTmp, 'dest');
  fs.mkdirSync(path.join(source, 'sessions'), {recursive: true});
  fs.mkdirSync(path.join(source, 'thread-writer-locks'), {recursive: true});
  fs.writeFileSync(path.join(source, 'auth.json'), '{}\n');
  fs.writeFileSync(path.join(source, 'thread-writer-locks', 'held.lock'), 'pid=999\n');
  materializeCodexGuardrailHome({dest, sourceHome: source});
  assert.ok(fs.lstatSync(path.join(dest, 'sessions')).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(dest, 'thread-writer-locks')).isSymbolicLink());
  assert.equal(
    fs.readlinkSync(path.join(dest, 'thread-writer-locks')),
    path.join(source, 'thread-writer-locks'),
  );
  console.log('CONFIRMED: overlay shares sessions and thread-writer-locks with the source Codex home via symlink (shared locking; not a defect).');
} finally {
  fs.rmSync(overlayTmp, {recursive: true, force: true});
}

const noticeMsgs = [
  {id: 'u1', role: 'user', text: 'look at the app', createdAt: 1, runId: 'r0'},
  {id: 'a1', role: 'assistant', text: 'ok', createdAt: 2, runId: 'r0'},
  {
    id: 'u-notice',
    role: 'user',
    text: `[orchestration] Worker thread abc finished with status done.\nContinue orchestrating; thread_status has full details.`,
    createdAt: 3,
    runId: 'r1',
  },
  {id: 'e1', role: 'event', text: dumped, createdAt: 4, runId: 'r1'},
];
assert.equal(lastUserMessage(noticeMsgs).id, 'u-notice');
assert.equal(retryAnchorEventId('failed', noticeMsgs), 'e1');
assert.match(retryButtonTitle(lastUserMessage(noticeMsgs).text), /^Retry: \[orchestration\]/);
console.log('CONFIRMED: after a failed fromNotice spawn, Retry re-sends the notice (and still resumes the locked session).');

const undelivered = [
  {id: 'u1', role: 'user', text: 'look at the app', createdAt: 1, runId: 'r0'},
  {id: 'a1', role: 'assistant', text: 'ok', createdAt: 2, runId: 'r0'},
  {
    id: 'e1',
    role: 'event',
    text: `[orchestration] Worker thread abc finished with status done.\nContinue orchestrating; thread_status has full details.\n\nNot delivered: Daily budget reached`,
    createdAt: 3,
  },
];
assert.equal(lastUserMessage(undelivered).text, 'look at the app');
assert.equal(retryAnchorEventId('failed', undelivered), 'e1');
assert.equal(retryButtonTitle(lastUserMessage(undelivered).text), 'Retry: look at the app');
console.log('CONFIRMED: after an undeliverable notice (event only), Retry re-sends the original user prompt, not the notice.');

const envPrev = {
  CODER_SIMULATE: process.env.CODER_SIMULATE,
  CODER_AGENT_CMD: process.env.CODER_AGENT_CMD,
  CODER_CODEX_BIN: process.env.CODER_CODEX_BIN,
  CODER_FAKE_CODEX_ARGV_FILE: process.env.CODER_FAKE_CODEX_ARGV_FILE,
  CODER_GROK_MCP_DISABLE: process.env.CODER_GROK_MCP_DISABLE,
  CODER_GROK_BIN: process.env.CODER_GROK_BIN,
  CODER_GUARDRAILS: process.env.CODER_GUARDRAILS,
  CODEX_HOME: process.env.CODEX_HOME,
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'solenta-runtime-audit-'));
const emptyCodex = path.join(tmp, 'empty-codex');
fs.mkdirSync(emptyCodex);
const argvFile = path.join(tmp, 'argv.json');
const fakeCodex = writeFakeBin(
  path.join(tmp, 'codex'),
  `#!/usr/bin/env node
const fs = require("fs");
if (process.env.CODER_FAKE_CODEX_ARGV_FILE) {
  fs.writeFileSync(process.env.CODER_FAKE_CODEX_ARGV_FILE, JSON.stringify(process.argv.slice(1)));
}
if (process.argv.includes("resume")) {
  const i = process.argv.indexOf("resume");
  const id = process.argv[i + 1] || "unknown";
  process.stderr.write("2026-09-06T06:31:14.325982Z ERROR codex_core::session::session: failed to initialize thread persistence: thread-store conflict: thread " + id + " already has an active writer\\n");
  process.stderr.write("Error: thread/resume failed with error: failed to load thread: thread-store conflict: thread already has an active writer (code -32600)\\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify({type:"thread.started", thread_id:"codex-sess-worker"}) + "\\n");
process.stdout.write(JSON.stringify({type:"item.completed", item:{id:"m", type:"agent_message", text:"worker done"}}) + "\\n");
process.stdout.write(JSON.stringify({type:"turn.completed", usage:{input_tokens:1, output_tokens:1}}) + "\\n");
process.exit(0);
`,
);
let runner;
try {
  delete process.env.CODER_SIMULATE;
  delete process.env.CODER_AGENT_CMD;
  process.env.CODER_GROK_MCP_DISABLE = '1';
  process.env.CODER_GROK_BIN = 'no-grok-not-a-real-binary';
  process.env.CODER_GUARDRAILS = 'off';
  process.env.CODEX_HOME = emptyCodex;
  process.env.CODER_CODEX_BIN = fakeCodex;
  process.env.CODER_FAKE_CODEX_ARGV_FILE = argvFile;

  const repo = path.join(tmp, 'app');
  fs.mkdirSync(repo);
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'audit@example.invalid']);
  git(repo, ['config', 'user.name', 'Audit']);
  const store = new Store(path.join(tmp, 'store.json'));
  const core = await import(pathToFileURL(path.join(process.cwd(), 'core/dist/index.js')).href);
  runner = createRunner({store, core, pushFn() {}, tickMs: 15, userDataPath: tmp});
  const project = await services.addProject(store, repo);
  const lead = services.createThread(store, {projectId: project.id, title: 'Lead'});
  services.setProvider(store, {threadId: lead.id, provider: 'codex'});
  store.updateThread(lead.id, {sessionId: LOCK_ID, status: 'done'});
  store.appendMessage(lead.id, {
    id: 'seed-user',
    role: 'user',
    text: 'look at the app',
    createdAt: Date.now(),
    runId: 'seed',
  });
  const worker = services.forkThread(store, {threadId: lead.id});
  store.updateThread(worker.id, {
    orchWorker: true,
    title: 'Worker A',
    provider: 'simulate',
    pendingWorktree: false,
  });
  store.saveNow();

  await runner.startRun({threadId: worker.id, prompt: 'worker task'});
  await waitFor(() => store.getThread(worker.id).status === 'done');
  await waitFor(() => store.getThread(lead.id).status === 'failed');

  const argv1 = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
  const execIdx = argv1.indexOf('exec');
  assert.ok(execIdx >= 0, JSON.stringify(argv1));
  assert.equal(argv1[execIdx + 1], 'resume');
  assert.equal(argv1[execIdx + 2], LOCK_ID);

  const leadMsgs = store.getMessages(lead.id);
  const lastUser = lastUserMessage(leadMsgs);
  assert.match(lastUser.text, /^\[orchestration\]/);
  assert.match(lastUser.text, /Worker A/);
  assert.match(lastUser.text, /Continue orchestrating/);
  const last = leadMsgs[leadMsgs.length - 1];
  assert.equal(last.role, 'event');
  assert.match(last.text, /thread-store conflict/);
  assert.match(last.text, /already has an active writer/);
  assert.doesNotMatch(last.text, /Quit Codex Desktop|Session reset|Retry will keep failing/);
  assert.equal(retryAnchorEventId(store.getThread(lead.id).status, leadMsgs), last.id);
  console.log('CONFIRMED: worker-finished auto-continue resumes the locked Codex session immediately and surfaces raw stderr.');

  fs.unlinkSync(argvFile);
  await runner.startRun({threadId: lead.id, prompt: lastUser.text});
  await waitFor(() => {
    const msgs = store.getMessages(lead.id);
    return msgs.filter((m) => m.role === 'event' && /thread-store conflict/.test(m.text)).length >= 2;
  });
  const argv2 = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
  assert.equal(argv2[argv2.indexOf('exec') + 1], 'resume');
  assert.equal(argv2[argv2.indexOf('exec') + 2], LOCK_ID);
  assert.equal(store.getThread(lead.id).status, 'failed');
  console.log('CONFIRMED: Retry of that notice calls startRun without fromNotice and immediately re-fails the same resume.');
} finally {
  if (runner) runner.stopAll();
  fs.rmSync(tmp, {recursive: true, force: true});
  for (const [k, v] of Object.entries(envPrev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
