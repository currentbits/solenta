#!/usr/bin/env node
// Store write cost of one simulated stream (#1475, PM1 finding 1).
//
//   node scripts/perf/store-stream-bench.js /tmp/fstore [seconds]
//
// The argument is a directory under /tmp holding a COPY of coder-store.json
// and its messages/ (and optionally worklogs/) dir, e.g.
//   mkdir /tmp/fstore
//   cp -c ~/Library/Application\ Support/Solenta/coder-store.json /tmp/fstore/
//   cp -Rc ~/Library/Application\ Support/Solenta/messages /tmp/fstore/
// The bench clones that dir again (APFS clone) and works on the clone, so the
// copy stays pristine between runs. Never point it at the live data dir.
//
// Stream shape (PM1): ~40 text deltas/s with the runner's 250 ms partial
// save, a new assistant message every 1.8 s, a tool call + result every 2 s,
// through the same Store methods runner-provider-claude.js uses.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const src = path.resolve(process.argv[2] || "/tmp/fstore");
const seconds = Number(process.argv[3] || 30);
const tmpRoots = [os.tmpdir(), "/tmp", "/private/tmp"].map((p) => fs.realpathSync(p));
if (!tmpRoots.some((root) => fs.realpathSync(src).startsWith(root + path.sep))) {
  console.error(`refusing ${src}: the bench only runs on a copy under /tmp`);
  process.exit(2);
}
if (!fs.existsSync(path.join(src, "coder-store.json"))) {
  console.error(`no coder-store.json in ${src}`);
  process.exit(2);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "store-bench-"));
try {
  execFileSync("cp", ["-Rc", `${src}/.`, work]);
} catch {
  fs.cpSync(src, work, { recursive: true });
}
const filePath = path.join(work, "coder-store.json");

// Count bytes as they land: every store write ends in a rename onto its dest.
const stats = { envelopeWrites: 0, envelopeBytes: 0, shardWrites: 0, shardBytes: 0 };
const realRename = fs.renameSync;
fs.renameSync = (from, to) => {
  realRename(from, to);
  const size = fs.statSync(to).size;
  if (to === filePath) {
    stats.envelopeWrites += 1;
    stats.envelopeBytes += size;
  } else {
    stats.shardWrites += 1;
    stats.shardBytes += size;
  }
};

const { Store } = require("../../electron/store.js");
const store = new Store(filePath);
const timed = { serializeMs: 0, serializeCalls: 0, shardStringifyMs: 0 };
const realSerialize = store._serialize.bind(store);
store._serialize = (data) => {
  const t = performance.now();
  try {
    return realSerialize(data);
  } finally {
    timed.serializeMs += performance.now() - t;
    timed.serializeCalls += 1;
  }
};
const realSnapshot = store._snapshotDirtyShards.bind(store);
store._snapshotDirtyShards = (opts) => {
  const t = performance.now();
  try {
    return realSnapshot(opts);
  } finally {
    timed.shardStringifyMs += performance.now() - t;
  }
};

const project = store.getProjects()[0];
const threadId = randomUUID();
store.setThreads([
  ...store.getThreads(),
  {
    id: threadId,
    projectId: project ? project.id : "bench",
    title: "store-stream-bench",
    status: "working",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
]);
store.saveNow();
for (const k of Object.keys(stats)) stats[k] = 0;
timed.serializeMs = 0;
timed.serializeCalls = 0;
timed.shardStringifyMs = 0;

const runId = randomUUID();
const appendMessage = (role, text, tool) => {
  const msg = { id: randomUUID(), role, text, createdAt: Date.now(), runId };
  if (tool) msg.tool = tool;
  store.appendMessage(threadId, msg);
  return msg.id;
};

let assistantId = null;
let assistantText = "";
let partialTimer = null;
const timers = [];
const every = (ms, fn) => timers.push(setInterval(fn, ms));

// Text delta, coalesced the way schedulePartialPush does (250 ms).
every(25, () => {
  assistantText += "lorem ipsum dolor sit amet ";
  if (!assistantId) assistantId = appendMessage("assistant", assistantText);
  else store.updateMessage(threadId, assistantId, { text: assistantText });
  if (!partialTimer) {
    partialTimer = setTimeout(() => {
      partialTimer = null;
      store.save();
    }, 250);
  }
});
// Full assistant message: the next delta opens a new one.
every(1800, () => {
  assistantId = null;
  assistantText = "";
  store.save();
});
// Tool call, its work-log step, then the result.
every(2000, () => {
  const toolId = randomUUID();
  const msgId = appendMessage("tool", "Bash: ls", {
    id: toolId, name: "Bash", input: "ls -la", output: null, isError: false, done: false,
  });
  const stepId = randomUUID();
  store.appendWorkLog(threadId, { id: stepId, runId, label: "Bash", done: false, timestamp: Date.now() });
  store.save();
  setTimeout(() => {
    store.updateMessage(threadId, msgId, {
      tool: { id: toolId, name: "Bash", input: "ls -la", output: "total 0\n".repeat(20), isError: false, done: true },
    });
    store.updateWorkLogItem(threadId, stepId, { done: true });
    store.save();
  }, 300);
});

const started = performance.now();
setTimeout(async () => {
  for (const t of timers) clearInterval(t);
  if (partialTimer) clearTimeout(partialTimer);
  await store.flushPending();
  const wall = (performance.now() - started) / 1000;
  const mib = (b) => (b / 1024 / 1024).toFixed(2);
  const envelopeSize = fs.statSync(filePath).size;
  console.log(`stream ${wall.toFixed(1)} s, envelope ${mib(envelopeSize)} MiB, ${store.getMessages(threadId).length} messages`);
  console.log(`coder-store.json writes: ${stats.envelopeWrites}, ${mib(stats.envelopeBytes)} MiB (${mib(stats.envelopeBytes / wall)} MiB/s)`);
  console.log(`shard writes:            ${stats.shardWrites}, ${mib(stats.shardBytes)} MiB`);
  console.log(`envelope stringify:      ${timed.serializeMs.toFixed(0)} ms over ${timed.serializeCalls} calls (${(timed.serializeMs / Math.max(1, timed.serializeCalls)).toFixed(1)} ms each)`);
  console.log(`shard stringify:         ${timed.shardStringifyMs.toFixed(0)} ms`);
  fs.renameSync = realRename;
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 10 });
}, seconds * 1000);
