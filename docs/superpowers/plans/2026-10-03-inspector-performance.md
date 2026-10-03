# Inspector panel performance implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the inspector panel from blocking the Electron main process. Remove the crew-integration git refresh loop, scope `threads:summaries`, make `memo(AgentsPanel)` effective, and drop a duplicate lane heartbeat.

**Architecture:**
- Main process: `threads:summaries` gains an optional `{ projectId, threadIds }` filter, applied before any message read. `crewIntegration` moves from blocking `gitTry` to `gitTryAsync`.
- Renderer: callers pass the narrowest scope. The crew-integration effect stops depending on the churning `summaries` array.

**Tech stack:** Electron main (CommonJS, `node:test`), React renderer (TypeScript, `node:test` + the `test/support/dom.ts` harness).

Spec: `docs/superpowers/specs/2026-10-03-inspector-tabs-design.md`, section "Performance changes".

## Global constraints

- No IPC contract break. `threads:summaries` with no argument returns exactly what it returns today.
- `lastActivity.text` is capped at 200 characters.
- No new dependencies.
- Run electron tests with the app's inherited env removed: `env -u CODER_GUARDRAILS_PATH`.
- Worktree setup before any test: clone `node_modules`, `core/node_modules` and `memory-server/node_modules` from the main checkout with `cp -Rc`, then `(cd core && npm run build)`.

---

### Task 1: Scope `threads:summaries` in the main process

**Files:**
- Modify: `electron/services.js` (`threadSummaries`, around line 4586)
- Modify: `electron/ipc.js:503-505`
- Test: `electron/test/threads-summaries.test.js`

**Interfaces:**
- Produces: `services.threadSummaries(store, input?)`, where `input` is `{ projectId?: string, threadIds?: string[] }`. Same row shape as today. `lastActivity.text` is capped at 200 characters.

- [ ] **Step 1: Write the failing tests.** Append inside `describe("threads summaries", ...)`:

```js
  it("filters by projectId and threadIds before reading messages", () => {
    store.setThreads([
      makeThread({ id: "a", projectId: "p1" }),
      makeThread({ id: "b", projectId: "p1" }),
      makeThread({ id: "c", projectId: "p2" }),
    ]);
    const read = [];
    const orig = store.getLastAssistantMessage.bind(store);
    store.getLastAssistantMessage = (id) => {
      read.push(id);
      return orig(id);
    };
    assert.deepEqual(
      services.threadSummaries(store, { projectId: "p1" }).map((r) => r.id),
      ["a", "b"],
    );
    assert.deepEqual(read, ["a", "b"], "other projects' messages are not read");
    read.length = 0;
    assert.deepEqual(
      services.threadSummaries(store, { threadIds: ["c"] }).map((r) => r.id),
      ["c"],
    );
    assert.deepEqual(read, ["c"]);
    assert.equal(services.threadSummaries(store).length, 3, "no filter = all rows");
  });

  it("caps lastActivity text at 200 characters", () => {
    store.setThreads([makeThread({ id: "a" })]);
    store.getLastAssistantMessage = () => ({ text: "x".repeat(500), createdAt: 5 });
    const [row] = services.threadSummaries(store);
    assert.equal(row.lastActivity.text.length, 200);
  });
```

- [ ] **Step 2: Run them to make sure they fail.**
Run: `env -u CODER_GUARDRAILS_PATH node --test electron/test/threads-summaries.test.js`
Expected: FAIL. The first test gets all 3 rows; the second gets length 500.

- [ ] **Step 3: Implement.** In `electron/services.js`, replace the `threadSummaries` signature and filter:

```js
/**
 * ...existing doc...
 * Optional input scopes the walk BEFORE any message read (#1398): projectId
 * keeps one project's rows, threadIds keeps exact ids. Omitted = all rows.
 * @param {import('./store').Store} store
 * @param {{ projectId?: string, threadIds?: string[] }} [input]
 */
function threadSummaries(store, input) {
  const projectId = input && typeof input.projectId === "string" ? input.projectId : null;
  const ids = input && Array.isArray(input.threadIds) ? new Set(input.threadIds) : null;
  return store
    .getThreads()
    .filter(
      (t) =>
        !(t && t.memoryConsolidate === true) &&
        !isTrashed(t) &&
        (!projectId || t.projectId === projectId) &&
        (!ids || ids.has(t.id)),
    )
    .map((t) => {
      const last = store.getLastAssistantMessage(t.id);
```

In the same function, change the `lastActivity.text` line to:

```js
              text: String(last.text).split(/\r?\n/, 1)[0].trim().slice(0, 200),
```

In `electron/ipc.js`, replace the handler:

```js
  "threads:summaries": async (ctx, input) => {
    return services.threadSummaries(ctx.store, input || undefined);
  },
```

- [ ] **Step 4: Run the tests to make sure they pass.**
Run: `env -u CODER_GUARDRAILS_PATH node --test electron/test/threads-summaries.test.js electron/test/thread-trash.test.js`
Expected: PASS.

- [ ] **Step 5: Commit.**
`git add electron/services.js electron/ipc.js electron/test/threads-summaries.test.js && git commit -m "Scope threads:summaries by project or thread ids (#1398)"`

### Task 2: Pass the scope from the renderer

**Files:**
- Modify: `src/shared/ipc.ts:3854`
- Modify: `src/useCoder.ts:747`, `src/useCoder.ts:3607-3609`
- Modify: `src/devCoder.ts` (`summaries`, around line 3770)
- Modify: `test/support/fakeCoder.ts:1747`
- Modify: `src/components/AgentsPanel.tsx`: the `listThreadSummaries` prop types at lines 207, 1533, 2212 and 2901; `RecapCard` around line 1547; the `AgentsContent` summaries effect around lines 2930-2957.
- Modify: `src/App.tsx` (new `panelRosterKey`, and the AgentsPanel prop at line 2477)
- Test: `test/teamView.test.tsx`, `test/environmentCards.test.tsx`

**Interfaces:**
- Consumes: Task 1's `threads:summaries` input.
- Produces: `ThreadSummariesInput = { projectId?: string; threadIds?: string[] }`, exported from `src/shared/ipc.ts`. `listThreadSummaries: (input?: ThreadSummariesInput) => Promise<ThreadSummaryInfo[]>`.

- [ ] **Step 1: Write the failing tests.**

In `test/environmentCards.test.tsx`, add a test that mounts the Environment tab's `RecapCard` path. Use the same pattern as the file's existing Recap test (`grep -n "Recap" test/environmentCards.test.tsx`), with a recording fetcher:

```tsx
it("Recap asks only for its own thread's summary (#1398)", async () => {
  const calls: unknown[] = [];
  const m = await mountEnvironmentWithRecap({
    listThreadSummaries: async (input?: unknown) => {
      calls.push(input);
      return [];
    },
  });
  await m.flush();
  assert.deepEqual(calls, [{ threadIds: ["t1"] }]);
  m.unmount();
});
```

`mountEnvironmentWithRecap` is the file's existing mount helper for the Recap card. If there isn't one, inline the same `<GitTab ...>` element the existing Recap test mounts, with `thread={thread({ id: "t1" })}`.

In `test/teamView.test.tsx`, add:

```tsx
it("team view fetches only its project's summaries (#1398)", async () => {
  const calls: unknown[] = [];
  const m = await mount(
    <AgentsContent
      workflow={null}
      thread={thread({ id: "t-orch", projectId: "p1" })}
      usage={null}
      providers={PROVIDERS}
      rosterKey="t-orch:idle"
      listThreadSummaries={async (input?: unknown) => {
        calls.push(input);
        return [];
      }}
    />,
  );
  await m.flush();
  assert.deepEqual(calls, [{ projectId: "p1" }]);
  m.unmount();
});
```

(`thread()` and `PROVIDERS` already exist in `teamView.test.tsx`. Check with `grep -n "^function thread\|PROVIDERS" test/teamView.test.tsx` and reuse them.)

- [ ] **Step 2: Run them to make sure they fail.**
Run: `node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test test/teamView.test.tsx test/environmentCards.test.tsx`
Expected: FAIL. `calls` is `[undefined]`.

- [ ] **Step 3: Implement.**

`src/shared/ipc.ts`: above the `summaries()` method declaration, add the exported type near `ThreadSummaryInfo` (line 1088):

```ts
/** Scope for threads:summaries (#1398). Omitted = every thread. */
export type ThreadSummariesInput = { projectId?: string; threadIds?: string[] };
```

and change the method:

```ts
    summaries(input?: ThreadSummariesInput): Promise<ThreadSummaryInfo[]>;
```

`src/useCoder.ts`, line 747:

```ts
  listThreadSummaries: (input?: ThreadSummariesInput) => Promise<ThreadSummaryInfo[]>;
```

and lines 3607-3609:

```ts
  const listThreadSummaries = useCallback(
    async (input?: ThreadSummariesInput) => api.threads.summaries(input),
    [api],
  );
```

(add `ThreadSummariesInput` to the existing `./shared/ipc` type import).

`src/devCoder.ts` and `test/support/fakeCoder.ts`: give `summaries` an `input` parameter and filter the `threads` array before mapping. In `fakeCoder.ts`, also record the input:

```ts
      summaries: (input?: ThreadSummariesInput) =>
        rec(
          "threads.summaries",
          [input],
          threads
            .filter((t) => !input?.projectId || t.projectId === input.projectId)
            .filter((t) => !input?.threadIds || input.threadIds.includes(t.id))
            .map((t): ThreadSummaryInfo => {
```

(devCoder: the same two `.filter` calls before `.map`, and `async summaries(input?: ThreadSummariesInput)`.)

`src/components/AgentsPanel.tsx`:
- Change all four prop types from `() => Promise<ThreadSummaryInfo[]>` to `(input?: ThreadSummariesInput) => Promise<ThreadSummaryInfo[]>`, and add the type to the existing `../shared/ipc` import.
- In `RecapCard`, change `listThreadSummaries()` to `listThreadSummaries({ threadIds: [threadId] })`.
- In the `AgentsContent` summaries effect:

```tsx
  const summaryProjectId = thread?.projectId ?? null;
  useEffect(() => {
    if (!listThreadSummaries || !summaryProjectId) {
      setSummaries(null);
      return;
    }
    let cancelled = false;
    const fetch = () => {
      if (document.hidden) return;
      // Same-project rows cover the team, the wait line and lead detection.
      listThreadSummaries({ projectId: summaryProjectId })
        .then((list) => {
          if (!cancelled) setSummaries(list);
        })
        .catch(() => {
          if (!cancelled) setSummaries(null);
        });
    };
    void fetch();
    const working = rosterKey.includes(":working");
    const id = working
      ? window.setInterval(() => void fetch(), SUMMARY_POLL_MS)
      : null;
    return () => {
      cancelled = true;
      if (id !== null) window.clearInterval(id);
    };
  }, [listThreadSummaries, rosterKey, summaryProjectId]);
```

`src/App.tsx`: after the existing `rosterKey` memo (line 1469), add a project-scoped key, and pass it to `AgentsPanel` instead of `rosterKey` (line 2477: `rosterKey={panelRosterKey}`). Leave `rosterKey` itself unchanged; the divergence memo at line 1482 uses it.

```tsx
  /** Agents panel refetch key: only the selected thread's project, so a
   *  working thread elsewhere does not keep the team poll alive (#1398). */
  const panelRosterKey = useMemo(() => {
    const pid = visibleDetail?.thread.projectId;
    if (!pid) return "";
    return threads
      .filter((t) => t.projectId === pid)
      .map((t) => `${t.id}:${t.status}`)
      .join(",");
  }, [threads, visibleDetail?.thread.projectId]);
```

- [ ] **Step 4: Run the tests to make sure they pass.**
Run: `npx tsc --noEmit && node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test test/teamView.test.tsx test/environmentCards.test.tsx test/crewIntegration.test.tsx test/appWiring.test.tsx`
Expected: PASS, and tsc clean.

- [ ] **Step 5: Commit.**
`git add -A src test && git commit -m "Fetch only the needed thread summaries from the inspector (#1398)"`

### Task 3: Stop the crew-integration effect from re-running on every poll

**Files:**
- Modify: `src/components/AgentsPanel.tsx` (the crew-integration effect around lines 2998-3041)
- Test: `test/crewIntegration.test.tsx`

**Interfaces:**
- Consumes: the `summaries` state from Task 2.

- [ ] **Step 1: Write the failing test.** Append inside `describe("AgentsContent Integration section", ...)`:

```tsx
  it("does not refetch crew integration when only the summaries array changes", async () => {
    const rows: ThreadSummaryInfo[] = [
      { id: "t-orch", title: "Lead", provider: "claude", status: "idle", handoffFrom: null, runStartedAt: null, lastActivity: null },
      { id: "t-work", title: "Worker A", provider: "claude", status: "done", handoffFrom: "t-orch", orchWorker: true, projectId: "p1", runStartedAt: null, lastActivity: null },
    ];
    let calls = 0;
    const integration = async () => {
      calls += 1;
      return view();
    };
    const el = (fetcher: () => Promise<ThreadSummaryInfo[]>) => (
      <AgentsContent
        workflow={null}
        thread={thread()}
        usage={null}
        providers={PROVIDERS}
        rosterKey="t-orch:idle,t-work:done"
        listThreadSummaries={fetcher}
        crewIntegration={integration}
        onIntegrateWorker={async () => {}}
      />
    );
    const m = await mount(el(async () => rows.map((r) => ({ ...r }))));
    await m.flush();
    assert.equal(calls, 1);
    // A new fetcher identity refetches summaries: same data, new array.
    await m.rerender(el(async () => rows.map((r) => ({ ...r }))));
    await m.flush();
    assert.equal(calls, 1, "a summaries-only change must not rerun blocking git");
    m.unmount();
  });

  it("debounces threads:changed reloads to one crewIntegration call", async () => {
    const listeners: Array<() => void> = [];
    const w = window as unknown as { coder?: unknown };
    const prev = w.coder;
    w.coder = {
      on: (_ch: string, cb: () => void) => {
        listeners.push(cb);
        return () => {};
      },
    };
    let calls = 0;
    try {
      const m = await mount(
        <AgentsContent
          workflow={null}
          thread={thread()}
          usage={null}
          providers={PROVIDERS}
          rosterKey="t-orch:idle,t-work:done"
          listThreadSummaries={async () => [
            { id: "t-work", title: "W", provider: "claude", status: "done", handoffFrom: "t-orch", orchWorker: true, projectId: "p1", runStartedAt: null, lastActivity: null },
          ]}
          crewIntegration={async () => {
            calls += 1;
            return view();
          }}
        />,
      );
      await m.flush();
      const base = calls;
      for (let i = 0; i < 5; i++) for (const cb of listeners) cb();
      await new Promise((r) => setTimeout(r, 1_200));
      await m.flush();
      assert.equal(calls - base, 1, "five pushes inside 1s collapse into one reload");
      m.unmount();
    } finally {
      w.coder = prev;
    }
  });
```

- [ ] **Step 2: Run them to make sure they fail.**
Run: `node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test test/crewIntegration.test.tsx`
Expected: FAIL. In the first test `calls` is 2. In the second, `calls - base` is 5.

- [ ] **Step 3: Implement.** Replace the effect's opening and closing. Keep the existing `load` body exactly as it is.

```tsx
  // Lead detection as a boolean so a new summaries array (every 5s poll)
  // does not rerun ~6+3×workers git calls in main.
  const isCrewLead = useMemo(
    () => Boolean(thread && summaries?.some((s) => isDirectCrewChild(s, thread))),
    [thread?.id, thread?.projectId, summaries],
  );
  useEffect(() => {
    if (!thread || !crewIntegration || !isCrewLead) {
      setIntegration(null);
      return;
    }
    let cancelled = false;
    let timer: number | null = null;
    const load = () => {
      /* unchanged body: crewIntegration(thread.id).then(...).catch(...) */
    };
    void load();
    const api = (
      window as unknown as {
        coder?: { on?: (channel: "threads:changed", cb: () => void) => () => void };
      }
    ).coder;
    // threads:changed fires dozens of times a minute in a crew run; one
    // reload per second is plenty for a review surface.
    const off = api?.on?.("threads:changed", () => {
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        void load();
      }, 1_000);
    });
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      off?.();
    };
  }, [thread?.id, crewIntegration, isCrewLead, rosterKey]);
```

(`useMemo` is already imported in this file.)

- [ ] **Step 4: Run the tests to make sure they pass.**
Run: the Step 2 command.
Expected: PASS.

- [ ] **Step 5: Commit.**
`git add src/components/AgentsPanel.tsx test/crewIntegration.test.tsx && git commit -m "Run crew integration only on real crew changes, debounced"`

### Task 4: Make `crewIntegration` non-blocking

**Files:**
- Modify: `electron/worktrees.js`: extract the `diffBaseCandidates` helper from `resolveDiffBase` (around line 2171); add `resolveDiffBaseAsync` and `listChangedPathsAsync`; export `repoDefaultBranchAsync`, `listChangedPathsAsync` and `gitTryAsync` (`gitTryAsync` is already exported, so check first).
- Modify: `electron/crewIntegration.js` (`crewIntegration`, around lines 393-500, plus the imports at lines 10-17)
- Modify: `electron/test/crew-integration.test.js` (lines 212, 266, 301, 324, 336, 346, 369, 378) and `electron/test/worker-snapshot.test.js` (lines 278, 607): add `await`, and make the enclosing `it` callbacks `async`.
- Test: new cases in `electron/test/crew-integration.test.js`

**Interfaces:**
- Produces:
  - `listChangedPathsAsync(cwd: string, base: string): Promise<{ ok: boolean, paths: string[], reason?: string }>`
  - `crewIntegration(store, input)` now returns a `Promise` with the same value. Its only production caller (`electron/ipc.js:510`) is already async.

- [ ] **Step 1: Write the failing test.** In `electron/test/crew-integration.test.js`, add (it reuses the file's existing git fixture helpers):

```js
  it("crewIntegration yields to the event loop while it runs git", async () => {
    const pending = crewIntegration(store, { threadId: lead.id });
    assert.ok(pending && typeof pending.then === "function", "returns a promise");
    // A sync body wrapped in a promise resolves before any setImmediate.
    // Real async git (execFile callbacks) lets the immediate run first.
    let yielded = false;
    setImmediate(() => {
      yielded = true;
    });
    const view = await pending;
    assert.ok(Array.isArray(view.workers));
    assert.equal(yielded, true, "main kept serving events during the git reads");
  });
```

Put it in the same `describe` as the existing test at line 266, so `store` and `lead` with a live worktree exist. Today's code fails at "returns a promise". A version that is only marked `async` but still calls `execFileSync` fails at "main kept serving events".

- [ ] **Step 2: Run it to make sure it fails.**
Run: `env -u CODER_GUARDRAILS_PATH node --test electron/test/crew-integration.test.js`
Expected: FAIL with "returns a promise".

- [ ] **Step 3: Implement.**

`electron/worktrees.js`: replace the candidate list in `resolveDiffBase` with a shared helper, and add the async pair right after `resolveDiffBase`:

```js
/** Refs tried, in order, for a diff base name (#760). */
function diffBaseCandidates(base) {
  const name = String(base || "").trim();
  if (!name || name.includes("...")) return [];
  const out = [name];
  if (!name.startsWith("refs/") && !name.includes("://")) {
    out.push(`refs/heads/${name}`, `origin/${name}`, `refs/remotes/origin/${name}`);
  }
  return [...new Set(out)];
}

function resolveDiffBase(cwd, base) {
  for (const ref of diffBaseCandidates(base)) {
    const probe = gitTry(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
    if (probe.ok && probe.stdout) return ref;
  }
  return "";
}

async function resolveDiffBaseAsync(cwd, base) {
  for (const ref of diffBaseCandidates(base)) {
    const probe = await gitTryAsync(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
    if (probe.ok && probe.stdout) return ref;
  }
  return "";
}

/**
 * Async committed-diff variant of listChangedPaths for read models that
 * must not block main (crew integration). Working tree is not included.
 * @param {string} cwd
 * @param {string} base
 * @returns {Promise<{ ok: boolean, paths: string[], reason?: string }>}
 */
async function listChangedPathsAsync(cwd, base) {
  const name = String(base || "").trim();
  const ref = await resolveDiffBaseAsync(cwd, name);
  if (!ref) return { ok: false, paths: [], reason: `unknown revision '${name}'` };
  const res = await gitTryAsync(cwd, ["diff", "--name-only", `${ref}...HEAD`]);
  if (!res.ok) {
    return {
      ok: false,
      paths: [],
      reason: (res.stderr || res.combined || "").split("\n")[0].trim(),
    };
  }
  const paths = [...new Set(String(res.stdout || "").split("\n").map((l) => l.trim()).filter(Boolean))];
  return { ok: true, paths };
}
```

Add `listChangedPathsAsync` and `repoDefaultBranchAsync` to `module.exports` (around line 6653).

`electron/crewIntegration.js`: keep the existing destructured imports (`mergeWorktree` and the others are still used elsewhere in the file) and add `const worktrees = require("./worktrees.js");`. Add:

```js
async function revParseAsync(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  const res = await worktrees.gitTryAsync(cwd, ["rev-parse", "HEAD"]);
  const sha = res.ok ? String(res.stdout || "").trim() : "";
  return sha || null;
}
```

and change `crewIntegration` to `async function crewIntegration(store, input)`, replacing each blocking call:
- `repoDefaultBranch(projectPath)` → `await worktrees.repoDefaultBranchAsync(projectPath)`
- `revParse(lead.worktreePath)` → `await revParseAsync(lead.worktreePath)`
- `gitTry(lead.worktreePath, ["branch", "--show-current"])` → `await worktrees.gitTryAsync(lead.worktreePath, ["branch", "--show-current"])`. Hoist this into a `let` before `leadBranch`, because `await` can't sit inside the `||` chain as written.
- `gitTry(projectPath, ["remote", "get-url", "origin"])` → `await worktrees.gitTryAsync(projectPath, ["remote", "get-url", "origin"])`
- The `.map((worker) => { ... })` becomes `await Promise.all(store.getThreads().filter(...).map(async (worker) => { ... }))`. Inside it, use `await revParseAsync(worker.worktreePath)` and `await worktrees.listChangedPathsAsync(worker.worktreePath, base)`.
- The lead's `listChangedPaths(lead.worktreePath, { base: finalTarget })` → `await worktrees.listChangedPathsAsync(lead.worktreePath, finalTarget)`.

Keep the sync `revParse` and `hasUnmerged`; other integrate functions in this file still use them.

Then update the ten test call sites listed under **Files** to `await crewIntegration(...)` inside `async` `it` callbacks.

- [ ] **Step 4: Run the tests to make sure they pass.**
Run: `env -u CODER_GUARDRAILS_PATH node --test electron/test/crew-integration.test.js electron/test/worker-snapshot.test.js electron/test/merge-issue-lifecycle.test.js`
Expected: PASS.

- [ ] **Step 5: Commit.**
`git add electron && git commit -m "Read crew integration with async git so it never blocks main"`

### Task 5: Make `memo(AgentsPanel)` effective and drop the duplicate heartbeat

**Files:**
- Modify: `src/App.tsx`: the inline `onIntegrateWorker` / `onVerifyLead` / `onLandLead` props at lines 2481-2505, and the `<LaneHeartbeat …/>` element at line 2462 together with its import, if that becomes unused.
- Test: `test/appWiring.test.tsx` (existing; must stay green)

**Interfaces:** none new.

- [ ] **Step 1: Implement.** Near the other App callbacks, before the JSX return, add:

```tsx
  const integrateSelectedWorker = useCallback(
    async (workerThreadId: string) => {
      if (selectedThreadId) await integrateWorker(selectedThreadId, workerThreadId);
    },
    [selectedThreadId, integrateWorker],
  );
  const verifySelectedLead = useCallback(async () => {
    if (selectedThreadId) await runVerify(selectedThreadId);
  }, [selectedThreadId, runVerify]);
  const leadTitle = visibleDetail?.thread.title;
  const landSelectedLead = useCallback(async () => {
    if (!selectedThreadId) return;
    const view = await crewIntegration(selectedThreadId);
    if (view.finalAction === "pr") {
      await createPr({ title: leadTitle || "Lead integration" });
      return;
    }
    await mergeWorktree();
  }, [selectedThreadId, crewIntegration, createPr, mergeWorktree, leadTitle]);
```

and pass them:

```tsx
        onIntegrateWorker={selectedThreadId ? integrateSelectedWorker : undefined}
        onVerifyLead={selectedThreadId ? verifySelectedLead : undefined}
        onLandLead={selectedThreadId ? landSelectedLead : undefined}
```

Delete the `<LaneHeartbeat threadId=… claimed=… heartbeatLane=… />` element at line 2462. `ClaimedLanesHeartbeat` (#1114) already beats every claimed lane in local projects every 15s, including the selected one. Remove `LaneHeartbeat` from the App import if nothing else uses it. Keep the component and `test/laneHeartbeat.test.tsx`; they are still valid units.

- [ ] **Step 2: Run the tests.**
Run: `npx tsc --noEmit && node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test test/appWiring.test.tsx test/claimedLanesHeartbeat.test.tsx test/crewIntegration.test.tsx`
Expected: PASS.

- [ ] **Step 3: Commit.**
`git add src/App.tsx && git commit -m "Stable crew handlers for AgentsPanel memo; drop duplicate lane heartbeat"`

### Task 6: Full verification and PR

- [ ] **Step 1: Run everything.**
`npm run typecheck && npm run test:renderer && env -u CODER_GUARDRAILS_PATH npm run test:electron && npx vite build`
Expected:
- typecheck clean
- renderer 0 fail
- electron 0 fail. Known load flakes: `fetchCodex process lifecycle` and `guardrails-runner`. Rerun those files alone to confirm.
- vite ok

- [ ] **Step 2: Push and open the PR.** Title: "Inspector performance: scoped summaries, non-blocking crew integration". The body lists P1–P4 with the before/after evidence from the spec, links #1398, and ends with the Claude Code footer.
