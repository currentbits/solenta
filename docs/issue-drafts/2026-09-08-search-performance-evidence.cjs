#!/usr/bin/env node
/**
 * #1122 evidence: sidebar search must not hydrate archived transcripts.
 *
 * Default is a CI-safe fixture (20 archived threads). The audit-sized
 * run from the issue is SCALE=audit (100 threads, ~1 MiB each).
 *
 *   node --expose-gc docs/issue-drafts/2026-09-08-search-performance-evidence.cjs
 *   SCALE=audit node --expose-gc docs/issue-drafts/2026-09-08-search-performance-evidence.cjs
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { monitorEventLoopDelay } = require("node:perf_hooks");
const { Store } = require("../../electron/store.js");

const audit = process.env.SCALE === "audit";
const THREADS = audit ? 100 : 20;
const PAD = audit ? 1024 * 1024 : 32 * 1024;

function heapUsed() {
  if (typeof global.gc === "function") global.gc();
  return process.memoryUsage().heapUsed;
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-search-ev-"));
  const filePath = path.join(tmpDir, "coder-store.json");
  let store = new Store(filePath);
  const threads = [];
  for (let i = 0; i < THREADS; i++) {
    const id = `arch-${i}`;
    threads.push({
      id,
      projectId: "p1",
      title: `Archived ${i}`,
      branch: null,
      prNumber: null,
      status: "idle",
      createdAt: 1,
      updatedAt: i,
      runStartedAt: null,
      archived: true,
      provider: "claude",
      model: null,
      sessionId: null,
      permissionMode: "default",
      worktreePath: null,
    });
    store.setMessages(id, [
      {
        id: `m-${i}`,
        role: "assistant",
        text: `pad-${i} ${"x".repeat(PAD)}`,
        createdAt: i,
      },
    ]);
  }
  store.setThreads(threads);
  store.saveNow();
  store._cancelSearchWorker();
  store = new Store(filePath);

  const beforeHydrated = Object.keys(store._messagesHydrated).length;
  const beforeHeap = heapUsed();
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  const t0 = process.hrtime.bigint();
  const hits = await store.searchThreads("no-such-token-zz");
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  histogram.disable();
  const afterHydrated = Object.keys(store._messagesHydrated).length;
  const afterHeap = heapUsed();
  const p95Ms = histogram.percentile(95) / 1e6;
  const p99Ms = histogram.percentile(99) / 1e6;
  const heapDeltaMiB = (afterHeap - beforeHeap) / (1024 * 1024);

  const report = {
    threads: THREADS,
    padBytes: PAD,
    hits: hits.length,
    hydratedBefore: beforeHydrated,
    hydratedAfter: afterHydrated,
    searchMs: Number(elapsedMs.toFixed(2)),
    loopP95Ms: Number(p95Ms.toFixed(2)),
    loopP99Ms: Number(p99Ms.toFixed(2)),
    heapDeltaMiB: Number(heapDeltaMiB.toFixed(2)),
    gc: typeof global.gc === "function",
  };
  console.log(JSON.stringify(report, null, 2));

  store._cancelSearchWorker();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  if (hits.length !== 0) {
    throw new Error("expected no-match search to return []");
  }
  if (beforeHydrated !== 0 || afterHydrated !== 0) {
    throw new Error(
      `search hydrated transcripts: before=${beforeHydrated} after=${afterHydrated}`,
    );
  }
  if (p99Ms >= 50) {
    throw new Error(`main-loop p99 ${p99Ms.toFixed(1)}ms exceeds 50ms target`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
