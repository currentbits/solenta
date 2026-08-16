# Orchestrator Threads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A third thread mode whose first prompt is deterministically forked to a worker thread that holds the worktree, after which the thread is an ordinary orchestrator.

**Architecture:** One lazy thread flag, `pendingFork`, mirroring the existing `pendingWorktree`. `runner.startRun` consumes it: instead of running the thread's own LLM, it forks a worker (via a helper shared with `orchServer.thread_fork`) and dispatches the prompt there. The existing `orchWorker` / `handoffFrom` machinery — wake-ups, budget ceiling, crew sweep, auto-archive — then applies unchanged. A `defaultOrchestrate` setting makes plain "New thread" create one; the sidebar caret and a Planboard header selector choose explicitly.

**Tech Stack:** Electron main (CommonJS, `electron/*.js`), React 19 + TypeScript renderer (`src/`), `node:test` for both sides.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-16-orchestrator-threads-design.md`. Tracking issue: #202.
- Thread flag name is exactly `pendingFork`. Settings key is exactly `defaultOrchestrate`. `threads.create` input key is exactly `orchestrate`.
- Orchestrator threads NEVER hold a worktree of their own: `orchestrate` wins over `worktree`, and `defaultOrchestrate` wins over `defaultWorktree`.
- `defaultOrchestrate` normalizes like `defaultWorktree`: absent or non-boolean → `false`; `setSettings` throws `"defaultOrchestrate must be a boolean"` on a non-boolean patch value.
- Electron tests: `npm run test:electron`. Renderer tests: `npm run test:renderer`. Typecheck: `npm run typecheck`.
- Follow the surrounding comment style: explain *why*, cite issue numbers where an existing comment nearby does.

---

## File Structure

**Modified**
- `electron/services.js` — new `canHostWorktree` + `forkWorkerThread` (moved in from `orchServer.js`), both exported.
- `electron/orchServer.js` — `thread_fork` delegates to `forkWorkerThread`; its local `canHostWorktree` is deleted.
- `electron/runner.js` — the `pendingFork` branch at the top of `startRun`.
- `electron/ipc.js` — `threads:create` honours `orchestrate`.
- `electron/store.js` — `defaultOrchestrate` in the settings default, `normalizeSettings`, and `setSettings`.
- `src/shared/ipc.ts` — `ThreadInfo.pendingFork`, `SettingsInfo.defaultOrchestrate`, `threads.create` input.
- `src/devCoder.ts` — browser-demo mirror of all of the above.
- `src/useCoder.ts` — `createThread` mode resolution.
- `src/components/Sidebar.tsx` — three-mode caret menu.
- `src/components/SettingsModal.tsx` — `defaultOrchestrate` checkbox.
- `src/components/PlanboardView.tsx` + `.module.css` — "Start as" selector.
- `src/App.tsx` — passes the chosen mode into `handleCreateThreadFromIssue`.

**Created**
- `electron/test/orchestrator-threads.test.js` — the runner dispatch behaviour.
- `test/orchestratorCreate.test.tsx` — the sidebar caret menu.

**Extended**
- `electron/test/services.test.js` — `forkWorkerThread`.
- `electron/test/auto-settle-settings.test.js` — `defaultOrchestrate` normalization.
- `electron/test/worktree-create.test.js` — `threads:create` with `orchestrate`.
- `test/planboardView.test.tsx` — the "Start as" selector.

---

### Task 1: Shared worker-fork helper

Today `orchServer.thread_fork` is the only place that knows what an orchestration worker is (`orchWorker` + an isolated worktree). The runner is about to need the same thing; extract it once so the two cannot drift.

**Files:**
- Modify: `electron/services.js` (add near `forkThread`, ~line 638; export in the `module.exports` block ~line 1900)
- Modify: `electron/orchServer.js:41-58` (delete local `canHostWorktree`), `electron/orchServer.js:268-293` (`thread_fork` body)
- Test: `electron/test/services.test.js` (append a new `describe`)

**Interfaces:**
- Consumes: `forkThread(store, input)` — already in `services.js`.
- Produces:
  - `canHostWorktree(project) => boolean`
  - `forkWorkerThread(store, input, forkImpl?) => thread` where `input` is `{ threadId: string, provider?: string, worktree?: boolean }` and `forkImpl` defaults to `forkThread` (injection seam for `orchServer`'s existing fake). Applies `{ orchWorker: true }` plus `{ pendingWorktree: true }` when the project can host one and `worktree !== false`, saves, and returns the fork. Does NOT start a run.

- [ ] **Step 1: Write the failing test**

Append to `electron/test/services.test.js`:

```js
describe("forkWorkerThread", () => {
  let tmpDir;
  let store;
  let repo;
  let project;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-forkworker-"));
    store = new Store(path.join(tmpDir, "store.json"));
    repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    fs.mkdirSync(path.join(repo, ".git"));
    project = services.addProject(store, repo);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("marks the fork an orchWorker isolated in its own worktree", () => {
    const source = services.createThread(store, {
      projectId: project.id,
      title: "Orchestrator",
    });
    const worker = services.forkWorkerThread(store, { threadId: source.id });
    const stored = store.getThread(worker.id);
    assert.equal(stored.orchWorker, true);
    assert.equal(stored.pendingWorktree, true);
    assert.equal(stored.handoffFrom, source.id);
    // The source is never modified.
    assert.equal(store.getThread(source.id).orchWorker, undefined);
  });

  it("shares the checkout when the caller opts out or the project cannot host one", () => {
    const source = services.createThread(store, {
      projectId: project.id,
      title: "Orchestrator",
    });
    const optedOut = services.forkWorkerThread(store, {
      threadId: source.id,
      worktree: false,
    });
    assert.equal(store.getThread(optedOut.id).pendingWorktree, undefined);

    fs.rmSync(path.join(repo, ".git"), { recursive: true, force: true });
    const nonRepo = services.forkWorkerThread(store, { threadId: source.id });
    assert.equal(store.getThread(nonRepo.id).pendingWorktree, undefined);
  });

  it("canHostWorktree rejects remote projects and non-repos", () => {
    assert.equal(services.canHostWorktree({ path: repo }), true);
    assert.equal(
      services.canHostWorktree({ path: repo, remoteHost: "box" }),
      false,
    );
    assert.equal(services.canHostWorktree({ path: "/nope/nowhere" }), false);
    assert.equal(services.canHostWorktree(null), false);
  });
});
```

If `electron/test/services.test.js` does not already import `fs`, `os`, `path`, and `Store`, add the missing ones at the top of the file:

```js
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../store.js");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:electron -- --test-name-pattern="forkWorkerThread"`
Expected: FAIL — `services.forkWorkerThread is not a function`.

- [ ] **Step 3: Add the helper to `electron/services.js`**

Insert directly above `function forkThread(store, input) {`:

```js
/**
 * Can this project host a git worktree? Remote projects are excluded (same
 * rule as threads:create) and so are non-repos, where `git worktree add`
 * would just fail the worker's run.
 * @param {{ path?: string, remoteHost?: string | null } | null | undefined} project
 * @returns {boolean}
 */
function canHostWorktree(project) {
  return Boolean(
    project &&
      !project.remoteHost &&
      project.path &&
      fs.existsSync(path.join(project.path, ".git")),
  );
}
```

Insert directly BELOW the closing brace of `forkThread`:

```js
/**
 * Fork a thread into an orchestration WORKER: flagged orchWorker (the runner
 * auto-archives it when its run lands, issue #14) and isolated in its own
 * worktree so N parallel workers never edit the same checkout (issue #30).
 * Lazy like threads:create — startRun materializes the worktree.
 *
 * Shared by orchServer's thread_fork tool and the runner's pendingFork
 * dispatch so the two definitions of "a worker" cannot drift apart. Starting
 * the run is the caller's job: services must not depend on the runner.
 *
 * @param {any} store
 * @param {{ threadId: string, provider?: string, worktree?: boolean }} input
 * @param {(store: any, input: any) => any} [forkImpl] seam for tests
 * @returns {any} the new worker thread
 */
function forkWorkerThread(store, input, forkImpl = forkThread) {
  /** @type {{ threadId: string, provider?: string }} */
  const forkInput = { threadId: input.threadId };
  if (input.provider != null) forkInput.provider = input.provider;
  const fork = forkImpl(store, forkInput);

  const patch = { orchWorker: true };
  const source = store.getThread(input.threadId);
  const projectId = fork.projectId ?? (source ? source.projectId : null);
  const project =
    typeof store.getProject === "function" && projectId != null
      ? store.getProject(projectId)
      : null;
  if (input.worktree !== false && canHostWorktree(project)) {
    patch.pendingWorktree = true;
  }
  store.updateThread(fork.id, patch);
  store.save();
  return fork;
}
```

Add both names to the `module.exports` object at the bottom of the file, next to `forkThread`:

```js
  canHostWorktree,
  forkWorkerThread,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:electron -- --test-name-pattern="forkWorkerThread"`
Expected: PASS (3 tests).

- [ ] **Step 5: Point orchServer at the helper**

In `electron/orchServer.js`, delete the local `canHostWorktree` function (the one whose JSDoc reads "Can this project host a git worktree?") and add to the requires at the top of the file:

```js
const { forkWorkerThread } = require("./services.js");
```

Replace the body of `thread_fork` between `assertSameProject(source, args.projectId);` and `await runner.startRun(...)` with:

```js
    /** @type {{ threadId: string, provider?: string, worktree?: boolean }} */
    const input = { threadId: args.threadId };
    if (args.provider != null) {
      if (!getProvider(String(args.provider))) {
        throw new Error(`Unknown provider: ${args.provider}`);
      }
      input.provider = String(args.provider);
    }
    if (args.worktree === false) input.worktree = false;
    // orchWorker + lazy worktree live in services.forkWorkerThread, shared
    // with the runner's pendingFork dispatch.
    const fork = forkWorkerThread(store, input, forkThread);
```

`fs` and `path` may now be unused in `orchServer.js`; drop those requires only if nothing else in the file uses them (`grep -n "fs\.\|path\." electron/orchServer.js`).

- [ ] **Step 6: Run the orch-server tests to verify nothing regressed**

Run: `npm run test:electron -- --test-name-pattern="orch-server"`
Expected: PASS — including "thread_fork isolates the worker in its own worktree by default" and "thread_fork omits provider key when not given", both unchanged.

- [ ] **Step 7: Commit**

```bash
git add electron/services.js electron/orchServer.js electron/test/services.test.js
git commit -m "refactor: share the orchestration worker fork between orchServer and services"
```

---

### Task 2: The `pendingFork` dispatch branch

**Files:**
- Modify: `electron/runner.js:3416-3430` (inside `startRun`, straight after the thread lookup)
- Create: `electron/test/orchestrator-threads.test.js`

**Interfaces:**
- Consumes: `services.forkWorkerThread` (Task 1); the runner's own `appendMessage(threadId, role, text, runId)`, `pushDetail(threadId)`, `pushThreadsChanged()`, `services.clearSettledOnActivity(thread)`, `services.deleteThread(store, { threadId })`, `services.THREAD_TITLE_MAX`.
- Produces: `startRun` on a thread with `pendingFork: true` returns the WORKER's `{ runId: string }` and never spawns a CLI for the orchestrator.

- [ ] **Step 1: Write the failing test**

Create `electron/test/orchestrator-threads.test.js`:

```js
/**
 * Orchestrator threads: the first prompt is forked to a worker instead of
 * running here (issue #202).
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createRunner } = require("../runner.js");

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function loadCore() {
  const corePath = path.join(__dirname, "../../core/dist/index.js");
  return import(pathToFileURL(corePath).href);
}

describe("orchestrator threads", () => {
  let tmpDir;
  let store;
  let core;
  let runner;
  let thread;
  let prevSimulate;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    process.env.CODER_SIMULATE = "1";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-orchthread-"));
    store = new Store(path.join(tmpDir, "store.json"));
    core = await loadCore();

    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "init"]);

    const project = services.addProject(store, repo);
    thread = services.createThread(store, {
      projectId: project.id,
      title: "New Thread",
    });
    store.updateThread(thread.id, { pendingFork: true });
    store.saveNow();
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    runner = null;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
  });

  /** @param {string} [userDataPath] omit to make the worker's worktree fail */
  function makeRunner(userDataPath) {
    runner = createRunner({
      store,
      core,
      pushFn: () => {},
      tickMs: 15,
      userDataPath: userDataPath ?? "",
    });
    return runner;
  }

  const workersOf = (id) =>
    store.getThreads().filter((t) => t.handoffFrom === id);

  it("forks the first prompt to a worker instead of running here", async () => {
    await makeRunner(tmpDir).startRun({
      threadId: thread.id,
      prompt: "build the thing",
    });

    const workers = workersOf(thread.id);
    assert.equal(workers.length, 1);
    const worker = workers[0];
    assert.equal(worker.orchWorker, true);
    // The prompt reached the worker verbatim.
    const workerMsgs = store.getMessages(worker.id) || [];
    assert.ok(
      workerMsgs.some((m) => m.role === "user" && m.text === "build the thing"),
    );
    // The orchestrator never ran itself.
    const parent = store.getThread(thread.id);
    assert.equal(parent.pendingFork, false);
    assert.equal(parent.status, "idle");
    // Its transcript still records the prompt and names the worker.
    const parentMsgs = store.getMessages(thread.id) || [];
    assert.ok(
      parentMsgs.some((m) => m.role === "user" && m.text === "build the thing"),
    );
    assert.ok(
      parentMsgs.some(
        (m) => m.role === "event" && String(m.text).includes(worker.id),
      ),
    );
  });

  it("promotes the title before forking so the worker is not 'Fork: New Thread'", async () => {
    await makeRunner(tmpDir).startRun({
      threadId: thread.id,
      prompt: "build the thing",
    });
    assert.equal(store.getThread(thread.id).title, "build the thing");
    assert.equal(workersOf(thread.id)[0].title, "Fork: build the thing");
  });

  it("clears the flag: the second prompt runs the orchestrator itself", async () => {
    const r = makeRunner(tmpDir);
    await r.startRun({ threadId: thread.id, prompt: "build the thing" });
    assert.equal(workersOf(thread.id).length, 1);

    await r.startRun({ threadId: thread.id, prompt: "status?" });
    assert.equal(store.getThread(thread.id).status, "working");
    // No second worker: forking again is now the LLM's call, not the runner's.
    assert.equal(workersOf(thread.id).length, 1);
  });

  it("keeps pendingFork and leaves no orphan when the worker cannot start", async () => {
    // No userDataPath: the worker's lazy worktree cannot be materialized.
    await assert.rejects(
      makeRunner().startRun({ threadId: thread.id, prompt: "build the thing" }),
      /worktreeBase is not configured/,
    );
    assert.equal(store.getThread(thread.id).pendingFork, true);
    assert.equal(workersOf(thread.id).length, 0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:electron -- --test-name-pattern="orchestrator threads"`
Expected: FAIL — the first test reports `workers.length` 0 (the orchestrator ran itself).

- [ ] **Step 3: Add the branch to `startRun`**

In `electron/runner.js`, insert immediately after the thread-not-found guard (`throw new Error(\`Unknown thread: ${threadId}\`);` and its closing brace) and BEFORE `services.assertUnderDailyBudget(store)`:

```js
    // Orchestrator thread (issue #202): the first prompt is not run here. It
    // is forked to a worker that holds the worktree and does the work; from
    // the second prompt on the flag is gone and this thread runs its own LLM,
    // supervising the crew through the coder-threads tools. The gates below
    // belong to the run that actually happens — the worker's — so they are
    // deliberately skipped on this hop.
    if (thread.pendingFork) {
      // Promote the title BEFORE forking so the worker is "Fork: <task>"
      // rather than "Fork: New Thread".
      let forkTitle = thread.title;
      if (forkTitle === "New Thread") {
        const firstLine = String(prompt).split(/\r?\n/)[0].trim();
        forkTitle =
          firstLine.slice(0, services.THREAD_TITLE_MAX || 60) || "New Thread";
      }
      if (forkTitle !== thread.title) {
        store.updateThread(threadId, { title: forkTitle }, { touch: true });
      }

      const worker = services.forkWorkerThread(store, { threadId });
      let started;
      try {
        started = await startRun({
          threadId: worker.id,
          prompt,
          attachments,
        });
      } catch (err) {
        // The worker could not start (missing CLI, budget gate, worktree
        // setup): drop the orphan and keep pendingFork so the next prompt
        // retries the fork, the same contract as a failed lazy worktree.
        try {
          services.deleteThread(store, { threadId: worker.id });
        } catch {
          /* best effort */
        }
        pushThreadsChanged();
        throw err;
      }

      const forkRunId = randomUUID();
      appendMessage(threadId, "user", prompt, forkRunId, null, attachments);
      appendMessage(
        threadId,
        "event",
        `[orchestration] Forked worker ${worker.id} for this prompt; it works in its own worktree and wakes this thread when it lands.`,
        forkRunId,
      );
      store.updateThread(
        threadId,
        { pendingFork: false, ...services.clearSettledOnActivity(thread) },
        { touch: true },
      );
      pushDetail(threadId);
      pushThreadsChanged();
      return started;
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:electron -- --test-name-pattern="orchestrator threads"`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full electron suite for regressions**

Run: `npm run test:electron`
Expected: PASS — no change in the runner, worktree, or orch-server suites.

- [ ] **Step 6: Commit**

```bash
git add electron/runner.js electron/test/orchestrator-threads.test.js
git commit -m "feat: orchestrator threads fork their first prompt to a worker"
```

---

### Task 3: Create orchestrator threads over IPC

**Files:**
- Modify: `electron/ipc.js:198-230` (`threads:create`)
- Modify: `src/shared/ipc.ts:156-163` (`ThreadInfo`), `src/shared/ipc.ts:939-943` (`threads.create`)
- Modify: `src/devCoder.ts:2295-2303` (`create`)
- Test: `electron/test/worktree-create.test.js` (append to the existing `describe`)

**Interfaces:**
- Consumes: `ThreadInfo.pendingFork` (written by Task 2's runner branch).
- Produces: `threads.create({ projectId, title, worktree?, orchestrate? })`. With `orchestrate: true` the thread gets `pendingFork: true`, no worktree of its own, and `worktree` is ignored. Remote projects reject with `"Orchestrator threads are not available for remote projects"`.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe("threads:create with worktree", ...)` in `electron/test/worktree-create.test.js`:

```js
  it("orchestrate marks pendingFork and never a worktree of its own", async () => {
    const thread = await IPC_HANDLERS["threads:create"](ctx, {
      projectId: project.id,
      title: "New Thread",
      orchestrate: true,
      // Ignored: the WORKER holds the worktree, never the orchestrator.
      worktree: true,
    });

    assert.equal(thread.pendingFork, true);
    assert.equal(thread.pendingWorktree, undefined);
    assert.equal(thread.worktreePath, null);
    assert.ok(!fs.existsSync(worktreeBase));
  });

  it("orchestrate is rejected for remote projects, atomically", async () => {
    const remote = services.addProject(store, repo);
    store.updateProject(remote.id, {
      remoteHost: "box",
      remotePath: "/srv/app",
    });
    const before = store.getThreads().length;

    await assert.rejects(
      IPC_HANDLERS["threads:create"](ctx, {
        projectId: remote.id,
        title: "New Thread",
        orchestrate: true,
      }),
      /not available for remote projects/,
    );
    assert.equal(store.getThreads().length, before);
  });
```

If `store.updateProject` is not the project-patch method in this codebase, check `grep -n "updateProject\|setProjects" electron/store.js` and use the equivalent; the test only needs `remoteHost` set on the project.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:electron -- --test-name-pattern="orchestrate"`
Expected: FAIL — `thread.pendingFork` is `undefined`.

- [ ] **Step 3: Handle `orchestrate` in `threads:create`**

In `electron/ipc.js`, inside `"threads:create"`, insert between `const thread = services.createThread(ctx.store, input);` and `if (input && input.worktree === true) {`:

```js
    // Orchestrator thread (issue #202): the first prompt is forked to a
    // worker, which is what gets the worktree — so this branch wins over
    // `worktree` and never touches the filesystem itself.
    if (input && input.orchestrate === true) {
      try {
        const project = ctx.store.getProject(thread.projectId);
        if (project && project.remoteHost) {
          throw new Error(
            "Orchestrator threads are not available for remote projects",
          );
        }
        ctx.store.updateThread(thread.id, { pendingFork: true });
        ctx.store.save();
      } catch (err) {
        // Atomic create, same as the worktree path below.
        try {
          services.deleteThread(ctx.store, { threadId: thread.id });
        } catch {
          /* best effort */
        }
        ctx.broadcast("threads:changed", services.listThreads(ctx.store));
        throw err;
      }
      ctx.broadcast("threads:changed", services.listThreads(ctx.store));
      return ctx.store.getThread(thread.id);
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:electron -- --test-name-pattern="orchestrate"`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the shared types**

In `src/shared/ipc.ts`, add to `ThreadInfo` directly after the `pendingWorktree` field:

```ts
  /**
   * Orchestrator thread: the first prompt is forked to a worker that holds
   * the worktree and does the work, instead of running here (issue #202).
   * Cleared once that fork happens; later prompts run this thread's own LLM.
   */
  pendingFork?: boolean;
```

Replace the `create` signature and its doc comment in the `threads` block:

```ts
    /**
     * Create a thread. With `worktree: true` the thread immediately gets its
     * own git worktree + `coder/<slug>-<id>` branch (local projects only);
     * creation fails atomically when the worktree cannot be created.
     *
     * With `orchestrate: true` the thread is an ORCHESTRATOR: its first
     * prompt is forked to a worker thread which holds the worktree and does
     * the work. Wins over `worktree` — an orchestrator never holds one
     * itself — and rejects on remote projects. Also fails atomically.
     */
    create(input: {
      projectId: string;
      title: string;
      worktree?: boolean;
      orchestrate?: boolean;
    }): Promise<ThreadInfo>;
```

- [ ] **Step 6: Mirror it in `devCoder`**

In `src/devCoder.ts`, replace the body of `async create(input)`:

```ts
      async create(input) {
        const t = newThread({
          projectId: input.projectId,
          title: input.title || "New Thread",
          // Lazy worktree: only the intent is recorded, the fake worktree
          // materializes at first run. An orchestrator holds neither — its
          // worker does.
          pendingWorktree: input.orchestrate !== true && input.worktree === true,
          pendingFork: input.orchestrate === true,
        });
        return registerThread(t);
      },
```

If `newThread` does not accept arbitrary overrides, check its signature (`grep -n "function newThread" -A 20 src/devCoder.ts`) and add `pendingFork` alongside `pendingWorktree` the same way. Also add `pendingFork: false` to the thread literal at `src/devCoder.ts:1499`, next to `pendingWorktree: false`.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add electron/ipc.js electron/test/worktree-create.test.js src/shared/ipc.ts src/devCoder.ts
git commit -m "feat: threads.create accepts orchestrate"
```

---

### Task 4: The `defaultOrchestrate` setting

**Files:**
- Modify: `electron/store.js:52` (defaults), `:265-268` (normalize defaults), `:311-312` (normalize), `:834-853` (getSettings JSDoc + return), `:862-863` (setSettings JSDoc), `:922-928` (setSettings validation), `:1234` (the remaining defaults literal)
- Modify: `src/shared/ipc.ts:729-734` (`SettingsInfo`)
- Modify: `src/devCoder.ts:1289`, `:1856`, `:1871-1876`, `:1895` (settings mirror)
- Modify: `src/components/SettingsModal.tsx:341-365` (the Threads section)
- Test: `electron/test/auto-settle-settings.test.js`

**Interfaces:**
- Produces: `SettingsInfo.defaultOrchestrate: boolean`, saved via the existing `settings.set` path.

- [ ] **Step 1: Write the failing test**

In `electron/test/auto-settle-settings.test.js`, add after the existing `defaultWorktree` test:

```js
  it("defaultOrchestrate: absent/junk → false, boolean kept, persists", () => {
    assert.equal(normalizeSettings({}).defaultOrchestrate, false);
    assert.equal(
      normalizeSettings({ defaultOrchestrate: "yes" }).defaultOrchestrate,
      false,
    );
    assert.equal(
      normalizeSettings({ defaultOrchestrate: 1 }).defaultOrchestrate,
      false,
    );
    assert.equal(
      normalizeSettings({ defaultOrchestrate: true }).defaultOrchestrate,
      true,
    );

    const store = new Store(path.join(tmpDir, "orch-settings.json"));
    assert.equal(store.getSettings().defaultOrchestrate, false);
    store.setSettings({ defaultOrchestrate: true });
    assert.equal(store.getSettings().defaultOrchestrate, true);
    assert.throws(
      () => store.setSettings({ defaultOrchestrate: "yes" }),
      /defaultOrchestrate must be a boolean/,
    );
  });
```

Match the surrounding tests for how `tmpDir`/`Store` are obtained in that file — reuse the exact idiom used by the `defaultWorktree` test directly above.

Every existing settings-shape assertion in this file that spells out the full object (e.g. `{ dailyBudgetUsd: null, orchestrationBudgetUsd: null, autoSettleAfterDays: 7, mcpServers: [], defaultWorktree: false, updateChannel: null, notifications: true }`) needs `defaultOrchestrate: false` added. Find them with `grep -n "defaultWorktree" electron/test/auto-settle-settings.test.js`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:electron -- --test-name-pattern="defaultOrchestrate"`
Expected: FAIL — `undefined !== false`.

- [ ] **Step 3: Add the setting to `electron/store.js`**

Add `defaultOrchestrate: false,` next to every `defaultWorktree: false,` in the defaults literals (lines ~52, ~268, ~840, ~872, ~1234 — `grep -n "defaultWorktree: false" electron/store.js` finds them all).

In `normalizeSettings`, directly under the `settings.defaultWorktree = …` assignment:

```js
  settings.defaultOrchestrate =
    /** @type {{ defaultOrchestrate?: unknown }} */ (obj).defaultOrchestrate ===
    true;
```

In `setSettings`, directly under the `defaultWorktree` block:

```js
    if (Object.prototype.hasOwnProperty.call(patch, "defaultOrchestrate")) {
      const v = patch.defaultOrchestrate;
      if (typeof v !== "boolean") {
        throw new Error("defaultOrchestrate must be a boolean");
      }
      this.data.settings.defaultOrchestrate = v;
    }
```

Add `defaultOrchestrate: boolean` to the JSDoc `@returns`/`@param` type literals in this file wherever `defaultWorktree: boolean` already appears (`grep -n "defaultWorktree: boolean" electron/store.js`), and copy `n.defaultWorktree`'s line in `getSettings` as `defaultOrchestrate: n.defaultOrchestrate,`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:electron -- --test-name-pattern="defaultOrchestrate"`
Expected: PASS.

Then: `npm run test:electron` — expected PASS (the settings-shape assertions you updated in Step 1 now match).

- [ ] **Step 5: Add the renderer type and the devCoder mirror**

In `src/shared/ipc.ts`, add to `SettingsInfo` directly after `defaultWorktree`:

```ts
  /**
   * When true, plain "New thread" creates an ORCHESTRATOR thread: its first
   * prompt is forked to a worker that holds the worktree (issue #202). Wins
   * over defaultWorktree — an orchestrator never holds one itself. Local
   * projects only; remote projects always get plain threads.
   */
  defaultOrchestrate: boolean;
```

In `src/devCoder.ts`, mirror every `defaultWorktree` occurrence:

```ts
  let defaultOrchestrate = false;
```

in the settings getter/setter payloads add `defaultOrchestrate,`, and in the patch handler add, next to the `defaultWorktree` block:

```ts
        if (Object.prototype.hasOwnProperty.call(patch, "defaultOrchestrate")) {
          if (typeof patch.defaultOrchestrate !== "boolean") {
            throw new Error("defaultOrchestrate must be a boolean");
          }
          defaultOrchestrate = patch.defaultOrchestrate;
        }
```

- [ ] **Step 6: Add the Settings checkbox**

In `src/components/SettingsModal.tsx`, inside the `Threads` section, directly after the `defaultWorktree` `<label>`/note block, add:

```tsx
              <label className={styles.fieldRow}>
                <input
                  type="checkbox"
                  data-default-orchestrate=""
                  checked={settings?.defaultOrchestrate ?? false}
                  disabled={saving || settings == null}
                  onChange={(e) => {
                    setError(null);
                    void onSaveSettings({
                      defaultOrchestrate: e.target.checked,
                    }).catch((err) => {
                      setError(
                        err instanceof Error && err.message
                          ? err.message
                          : "Failed to save settings",
                      );
                    });
                  }}
                />
                <span>Delegate new threads to a worker</span>
              </label>
              <p className={styles.note}>
                The thread&apos;s first prompt is handed to a worker thread in
                its own worktree; the thread itself supervises. Wins over the
                worktree option above.
              </p>
```

- [ ] **Step 7: Typecheck and run the renderer suite**

Run: `npm run typecheck && npm run test:renderer`
Expected: PASS. If `test/settingsModal.test.tsx` asserts an exact settings object, add `defaultOrchestrate: false` to its fixture.

- [ ] **Step 8: Commit**

```bash
git add electron/store.js electron/test/auto-settle-settings.test.js src/shared/ipc.ts src/devCoder.ts src/components/SettingsModal.tsx
git commit -m "feat: defaultOrchestrate setting"
```

---

### Task 5: Sidebar mode menu

**Files:**
- Modify: `src/useCoder.ts:769-790` (`createThread`)
- Modify: `src/components/Sidebar.tsx:120-128` (props), `:1020` (default), `:1673-1706` (the caret menu)
- Create: `test/orchestratorCreate.test.tsx`

**Interfaces:**
- Consumes: `settings.defaultOrchestrate`, `threads.create({ orchestrate })`.
- Produces: `onCreateThread(projectId, opts?: { worktree?: boolean; orchestrate?: boolean })`. Sidebar prop `defaultOrchestrate?: boolean` (mirrors `defaultWorktree`).

- [ ] **Step 1: Write the failing test**

Create `test/orchestratorCreate.test.tsx`. Copy the fixtures (`project`, `remoteProject`, `providers`, `FRESH`, `thread`, and the `mount` render helper) verbatim from `test/sidebarWorktreeCreate.test.tsx`, then:

```tsx
describe("Sidebar thread-mode menu", () => {
  it("offers all three modes and passes the chosen one through", async () => {
    const calls: Array<[string, unknown]> = [];
    const { container, click } = mount(
      <Sidebar
        {...baseProps}
        onCreateThread={(projectId, opts) => calls.push([projectId, opts])}
      />,
    );

    await click(
      container.querySelector(`[data-create-menu-btn="p1"]`) as HTMLElement,
    );

    for (const attr of [
      "data-create-worktree-thread",
      "data-create-orchestrator-thread",
      "data-create-plain-thread",
    ]) {
      assert.ok(
        container.querySelector(`[${attr}="p1"]`),
        `menu is missing ${attr}`,
      );
    }

    await click(
      container.querySelector(
        `[data-create-orchestrator-thread="p1"]`,
      ) as HTMLElement,
    );
    assert.deepEqual(calls, [["p1", { orchestrate: true }]]);
  });

  it("hides the menu for remote projects", async () => {
    const { container } = mount(
      <Sidebar {...baseProps} projects={[remoteProject]} threads={[]} />,
    );
    assert.equal(container.querySelector(`[data-create-menu-btn="p2"]`), null);
  });
});
```

Build `baseProps` from the props `test/sidebarWorktreeCreate.test.tsx` already passes to `<Sidebar>` — read that file and reuse its exact prop set, and its exact `mount`/click idiom (it may use `inAct` rather than a `click` helper; match whatever it does).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:renderer -- --test-name-pattern="thread-mode menu"`
Expected: FAIL — `menu is missing data-create-orchestrator-thread`.

- [ ] **Step 3: Widen `useCoder.createThread`**

In `src/useCoder.ts`, replace the signature and the mode resolution:

```ts
  const createThread = useCallback(
    async (
      title = "New Thread",
      projectId?: string,
      opts?: { worktree?: boolean; orchestrate?: boolean },
    ) => {
      const pid = projectId ?? selectedProjectId;
      if (!pid) return null;
      // Settings can default new threads into a worktree or into an
      // orchestrator; explicit opts win. Both are local-only, so remote
      // projects always get plain threads. An orchestrator never holds a
      // worktree itself — its worker does — so it wins over `worktree`.
      const project = projects.find((p) => p.id === pid);
      const local = !project?.remoteHost;
      const orchestrate =
        opts?.orchestrate ?? (settings?.defaultOrchestrate === true && local);
      const worktree =
        !orchestrate &&
        (opts?.worktree ?? (settings?.defaultWorktree === true && local));
```

and the create call:

```ts
        t = await api.threads.create({
          projectId: pid,
          title,
          ...(worktree ? { worktree: true } : {}),
          ...(orchestrate ? { orchestrate: true } : {}),
        });
```

Add `settings?.defaultOrchestrate` to this `useCallback`'s dependency array alongside `settings?.defaultWorktree` if the array lists them individually.

- [ ] **Step 4: Replace the Sidebar caret menu**

In `src/components/Sidebar.tsx`, widen the prop type of `onCreateThread` to accept `{ worktree?: boolean; orchestrate?: boolean }`, and add next to the `defaultWorktree` prop:

```tsx
  /**
   * Mirrors SettingsInfo.defaultOrchestrate. Only affects which mode plain
   * "New thread" uses; the caret always offers all three explicitly.
   */
  defaultOrchestrate?: boolean;
```

destructure it with `defaultOrchestrate = false,` next to `defaultWorktree = false,` (it is unused in the menu below — keep it only if a `title` or badge uses it; otherwise skip this prop entirely and delete it from the type).

Replace the whole `{createOpen && !remote && (...)}` block's menu items with the three unconditional entries:

```tsx
              <button
                type="button"
                className={styles.snoozeMenuItem}
                role="menuitem"
                data-create-worktree-thread={project.id}
                title="New thread in an isolated git worktree + branch"
                onClick={() => {
                  setCreateMenuFor(null);
                  onCreateThread(project.id, { worktree: true });
                }}
              >
                New worktree thread
              </button>
              <button
                type="button"
                className={styles.snoozeMenuItem}
                role="menuitem"
                data-create-orchestrator-thread={project.id}
                title="New thread that hands its first prompt to a worker in its own worktree"
                onClick={() => {
                  setCreateMenuFor(null);
                  onCreateThread(project.id, { orchestrate: true });
                }}
              >
                New orchestrator thread
              </button>
              <button
                type="button"
                className={styles.snoozeMenuItem}
                role="menuitem"
                data-create-plain-thread={project.id}
                title="New thread directly in the project checkout (no worktree)"
                onClick={() => {
                  setCreateMenuFor(null);
                  onCreateThread(project.id, { worktree: false });
                }}
              >
                New plain thread
              </button>
```

Note the `defaultWorktree &&` conditional around the last item is gone: the menu now always lists all three modes, so the plain option is reachable whatever the default is.

In `src/App.tsx`, pass the new prop next to `defaultWorktree` only if you kept it:

```tsx
        defaultOrchestrate={settings?.defaultOrchestrate ?? false}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test:renderer -- --test-name-pattern="thread-mode menu"`
Expected: PASS (2 tests).

Then: `npm run test:renderer` — expected PASS. `test/sidebarWorktreeCreate.test.tsx` may assert that `data-create-plain-thread` is ABSENT when `defaultWorktree` is false; that assertion is now wrong by design — update it to assert the item is present and drop the `defaultWorktree`-conditional case.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/useCoder.ts src/components/Sidebar.tsx src/App.tsx test/orchestratorCreate.test.tsx test/sidebarWorktreeCreate.test.tsx
git commit -m "feat: sidebar caret offers all three thread modes"
```

---

### Task 6: Planboard "Start as" selector

**Files:**
- Modify: `src/components/PlanboardView.tsx:24-31` (props), `:69-89` (`startTask`), `:113-139` (header controls)
- Modify: `src/components/PlanboardView.module.css` (one class)
- Modify: `src/App.tsx:343-382` (`handleCreateThreadFromIssue`), `:547-559` (the `onStartTask` prop)
- Test: `test/planboardView.test.tsx`

**Interfaces:**
- Consumes: `createThread(title, projectId, opts)` from Task 5.
- Produces: `onStartTask(input: { projectId; projectPath; ref; mode: ThreadStartMode })` where `type ThreadStartMode = "default" | "plain" | "worktree" | "orchestrator"`, exported from `src/components/PlanboardView.tsx`.

- [ ] **Step 1: Write the failing test**

Append to `test/planboardView.test.tsx`, inside the existing `describe("PlanboardView", …)`:

```tsx
  it("Start task passes the header's mode", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { container } = await mount(
      <PlanboardView
        projects={projects}
        listIssues={async () => okResult}
        onStartTask={async (input) => {
          calls.push(input);
          return { ok: true as const };
        }}
      />,
    );

    const select = container.querySelector(
      "[data-plan-start-mode]",
    ) as HTMLSelectElement;
    assert.ok(select, "the board has a start-mode selector");
    // Defaults to the app setting, i.e. no explicit override.
    assert.equal(select.value, "default");

    await inAct(() => {
      select.value = "orchestrator";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await inAct(() => {
      (
        container.querySelector("[data-plan-start='1']") as HTMLElement
      ).click();
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].ref, "1");
    assert.equal(calls[0].mode, "orchestrator");
  });
```

Match the file's existing mount/await idiom exactly (read the tests above it — `mount` may not be awaited, and issue loading may need an `inAct` flush before the card exists).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:renderer -- --test-name-pattern="Start task passes"`
Expected: FAIL — the board has no start-mode selector.

- [ ] **Step 3: Add the selector to `PlanboardView`**

Export the mode type and widen the prop:

```tsx
/** How the Planboard's Start task button creates its thread. */
export type ThreadStartMode = "default" | "plain" | "worktree" | "orchestrator";
```

```tsx
  onStartTask?: (input: {
    projectId: string;
    projectPath: string;
    ref: string;
    mode: ThreadStartMode;
  }) => Promise<{ ok: true; warning?: string } | { ok: false; reason: string }>;
```

Add the state next to the other `useState` calls:

```tsx
  /** Thread mode for Start task; "default" follows the app setting. */
  const [startMode, setStartMode] = useState<ThreadStartMode>("default");
```

Pass it in `startTask`:

```tsx
      const res = await onStartTask({
        projectId: project.id,
        projectPath: project.path,
        ref: String(issueNumber),
        mode: startMode,
      });
```

and add `startMode` to that `useCallback`'s dependency array.

Add the control in the header's `<div className={styles.controls}>`, directly before the Refresh button, rendered only when the button itself is available:

```tsx
          {onStartTask ? (
            <select
              className={styles.startMode}
              value={startMode}
              onChange={(e) =>
                setStartMode(e.target.value as ThreadStartMode)
              }
              data-plan-start-mode=""
              aria-label="Start tasks as"
              title="How Start task creates its thread"
            >
              <option value="default">Start as: Default</option>
              <option value="plain">Start as: Plain</option>
              <option value="worktree">Start as: Worktree</option>
              <option value="orchestrator">Start as: Orchestrator</option>
            </select>
          ) : null}
```

In `src/components/PlanboardView.module.css`, add `.startMode` as a copy of the existing `.projectSelect` rule (same block, comma-joined selector is fine).

- [ ] **Step 4: Thread the mode through `App.tsx`**

Change `handleCreateThreadFromIssue`'s signature and its `createThread` call:

```tsx
  const handleCreateThreadFromIssue = useCallback(
    async (input: {
      projectId: string;
      projectPath: string;
      ref: string;
      mode?: ThreadStartMode;
    }) => {
      const fetched = await fetchIssue(input.projectPath, input.ref);
      if (!fetched.ok) return fetched;
      const issue = fetched.issue;
      let thread;
      try {
        // "default" (and the sidebar's issue button, which sends no mode)
        // follows the app setting; the rest are explicit overrides.
        const opts =
          input.mode === "orchestrator"
            ? { orchestrate: true }
            : input.mode === "worktree"
              ? { worktree: true }
              : input.mode === "plain"
                ? { worktree: false, orchestrate: false }
                : undefined;
        thread = await createThread(issue.title, input.projectId, opts);
      } catch (err) {
```

Import the type: `import { PlanboardView, type ThreadStartMode } from "./components/PlanboardView";`

The `onStartTask` prop already forwards its whole input, so it needs no change beyond typechecking.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test:renderer -- --test-name-pattern="Start task passes"`
Expected: PASS.

Then: `npm run typecheck && npm run test:renderer`
Expected: PASS. The sidebar's issue button calls `handleCreateThreadFromIssue` without `mode`, which is now optional, so it keeps following the setting.

- [ ] **Step 6: Full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/PlanboardView.tsx src/components/PlanboardView.module.css src/App.tsx test/planboardView.test.tsx
git commit -m "feat: planboard Start task chooses the thread mode"
```

---

## Self-Review Notes

Spec coverage check:

| Spec section | Task |
|---|---|
| `pendingFork` flag, `startRun` branch, no LLM turn on the parent | 2 |
| Shared fork helper (`forkWorkerThread`) | 1 |
| Reporting via existing `orchNotices` | none needed — `forkWorkerThread` sets `orchWorker` and `forkThread` sets `handoffFrom`, which is exactly what `queueOrchNotice` keys on. Task 2's first test asserts both. |
| Failure keeps `pendingFork` | 2 (fourth test) |
| Orchestrator never holds a worktree | 3 (IPC), 5 (`useCoder` precedence) |
| `threads.create({ orchestrate })` + remote rejection | 3 |
| `defaultOrchestrate` setting + normalization | 4 |
| Sidebar three-mode menu | 5 |
| Settings checkbox | 4 |
| Planboard "Start as" selector | 6 |
| devCoder mirror | 3 (threads), 4 (settings) |
