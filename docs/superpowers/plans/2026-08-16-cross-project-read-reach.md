# Cross-Project Read Reach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a thread read other projects' checkouts — opted in per thread — without ever writing to them.

**Architecture:** A new thread field `readProjectIds` holds the opted-in project ids. `services.readRootsFor` resolves them to on-disk roots. Those roots do two things: they are named in the prompt note every dispatch already carries, and — on claude, the only provider with a permission channel — they let the runner auto-answer `allow` to read-shaped tool prompts instead of stopping for the user. Writes are untouched everywhere, so no git/diff/PR/worktree code changes.

**Tech Stack:** Electron main process (CommonJS, `electron/*.js`), React 18 + TypeScript renderer (`src/`), `node:test` for every suite.

Spec: `docs/superpowers/specs/2026-08-16-cross-project-read-reach-design.md`. Issue: #109.

## Global Constraints

- **Never grant writes.** No `--add-dir`, no sandbox flag, no provider argv change anywhere in this plan. If a task tempts you into `providers.js`, you have gone wrong.
- **New pure helpers are CommonJS modules under `electron/`**, next to their caller (`links.js`, `pathEnv.js` are the precedent). `core/` is the TypeScript workflow engine and is not touched.
- **Every file keeps `"use strict";`** at the top if its neighbours have it (`electron/services.js`, `electron/store.js` do; `electron/links.js` does not — match the file you are editing).
- **JSDoc type annotations on every exported function**, matching the density of the surrounding file. This repo runs `tsc --noEmit` over the renderer; `npm run typecheck` must stay clean.
- **Never bump `updatedAt` for config changes.** `store.updateThread(id, patch)` without `{ touch: true }` is the config path; `{ touch: true }` is for real activity only. Read-access toggles are config.
- Test commands, verbatim:
  - electron: `npm run test:electron`
  - renderer: `npm run test:renderer`
  - one electron file: `node --import=./test/support/render.mjs --experimental-strip-types --test electron/test/<file>.test.js`
  - one renderer file: `CODER_GROK_MCP_DISABLE=1 node --import=./test/support/render.mjs --experimental-strip-types --test --test-timeout=20000 test/<file>.test.tsx`
- Commit after every task. Message style: imperative subject, no scope prefix, e.g. `Add read-reach path policy helper (#109)`.

## File Structure

| File | Responsibility |
|---|---|
| `electron/readReach.js` (new) | Pure policy: is this tool call a read under one of these roots? No I/O, no store. |
| `electron/test/read-reach.test.js` (new) | The policy matrix. |
| `electron/services.js` (modify) | `readProjectIds` default in `createThread`, `setReadProjects`, `readRootsFor`, fork inheritance, read-roots sentence in `selfIdNoteFor`. |
| `electron/ipc.js` (modify) | `threads:setReadProjects` channel. |
| `electron/preload.js` (modify) | Bridge the channel. |
| `electron/runner.js` (modify) | Consult the policy in the `can_use_tool` branch; pass roots into `selfIdNoteFor`. |
| `electron/test/read-reach-services.test.js` (new) | Field, setter, `readRootsFor`, note text, fork inheritance. |
| `electron/test/claude.test.js` (modify) | Auto-allow through the real control protocol. |
| `src/shared/ipc.ts` (modify) | `ThreadInfo.readProjectIds`, the API signature. |
| `src/wireClient.ts` (modify) | Renderer-side call. |
| `src/useCoder.ts` (modify) | `setReadProjects` action. |
| `src/App.tsx` (modify) | Pass `projects` + handler to `ThreadView`. |
| `src/components/ThreadView.tsx` (modify) | "Read access" submenu. |
| `test/readAccessMenu.test.tsx` (new) | The submenu renders, checks and calls back. |

---

### Task 1: Read policy helper

**Files:**
- Create: `electron/readReach.js`
- Test: `electron/test/read-reach.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `isUnderRoot(candidate: string, root: string): boolean`
  - `autoAllowRead(toolName: string, input: object, roots: Array<{name: string, path: string}>): boolean`

- [ ] **Step 1: Write the failing test**

Create `electron/test/read-reach.test.js`:

```js
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { autoAllowRead, isUnderRoot } = require("../readReach.js");

const ROOTS = [
  { name: "docs", path: "/tmp/docs-repo" },
  { name: "site", path: "/tmp/site-repo" },
];

describe("isUnderRoot", () => {
  it("accepts the root itself and anything inside it", () => {
    assert.equal(isUnderRoot("/tmp/docs-repo", "/tmp/docs-repo"), true);
    assert.equal(isUnderRoot("/tmp/docs-repo/a/b.md", "/tmp/docs-repo"), true);
  });

  it("rejects a sibling whose name merely shares the prefix", () => {
    // The separator anchor: /tmp/docs-repo-secrets is NOT under /tmp/docs-repo.
    assert.equal(isUnderRoot("/tmp/docs-repo-secrets/x", "/tmp/docs-repo"), false);
  });

  it("rejects a path that climbs out with ..", () => {
    assert.equal(isUnderRoot("/tmp/docs-repo/../other/x", "/tmp/docs-repo"), false);
  });

  it("resolves a relative candidate against cwd, so it is not under an absolute root", () => {
    assert.equal(isUnderRoot("notes.md", "/tmp/docs-repo"), false);
  });
});

describe("autoAllowRead", () => {
  it("allows read-shaped tools whose path is inside a root", () => {
    for (const tool of ["Read", "Grep", "Glob", "NotebookRead"]) {
      assert.equal(
        autoAllowRead(tool, { file_path: "/tmp/site-repo/index.html" }, ROOTS),
        true,
        tool,
      );
    }
  });

  it("reads the path from file_path, path or notebook_path", () => {
    assert.equal(autoAllowRead("Grep", { path: "/tmp/docs-repo/src" }, ROOTS), true);
    assert.equal(
      autoAllowRead("NotebookRead", { notebook_path: "/tmp/docs-repo/a.ipynb" }, ROOTS),
      true,
    );
  });

  it("refuses a read outside every root", () => {
    assert.equal(autoAllowRead("Read", { file_path: "/etc/passwd" }, ROOTS), false);
  });

  it("refuses when ANY path input escapes the roots", () => {
    assert.equal(
      autoAllowRead(
        "Grep",
        { path: "/tmp/docs-repo/src", file_path: "/etc/passwd" },
        ROOTS,
      ),
      false,
    );
  });

  it("refuses write-shaped and shell tools even inside a root", () => {
    for (const tool of ["Edit", "Write", "Bash", "NotebookEdit", "WebFetch"]) {
      assert.equal(
        autoAllowRead(tool, { file_path: "/tmp/docs-repo/a.md" }, ROOTS),
        false,
        tool,
      );
    }
  });

  it("refuses a read tool with no path input — that is the run's own cwd", () => {
    assert.equal(autoAllowRead("Grep", { pattern: "TODO" }, ROOTS), false);
  });

  it("refuses when there are no roots", () => {
    assert.equal(autoAllowRead("Read", { file_path: "/tmp/docs-repo/a.md" }, []), false);
    assert.equal(autoAllowRead("Read", { file_path: "/tmp/docs-repo/a.md" }, null), false);
  });

  it("tolerates junk input without throwing", () => {
    assert.equal(autoAllowRead("Read", null, ROOTS), false);
    assert.equal(autoAllowRead(null, { file_path: "/tmp/docs-repo/a.md" }, ROOTS), false);
    assert.equal(autoAllowRead("Read", { file_path: 42 }, ROOTS), false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import=./test/support/render.mjs --experimental-strip-types --test electron/test/read-reach.test.js`
Expected: FAIL — `Cannot find module '../readReach.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `electron/readReach.js`:

```js
"use strict";

const path = require("node:path");

/**
 * Tools that only ever READ. Anything absent from this set prompts as usual,
 * which is what keeps a write into another repo a decision the user makes.
 */
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "NotebookRead"]);

/** Input keys that carry a filesystem path across the read tools. */
const PATH_KEYS = ["file_path", "path", "notebook_path"];

/**
 * Is `candidate` the root itself or something inside it?
 *
 * ponytail: path.resolve only, no realpath — a symlink inside a root that
 * points outside it reads as inside. Swap in fs.realpathSync.native on both
 * sides if a run is ever given a root it does not fully control.
 *
 * @param {string} candidate
 * @param {string} root
 * @returns {boolean}
 */
function isUnderRoot(candidate, root) {
  if (typeof candidate !== "string" || !candidate) return false;
  if (typeof root !== "string" || !root) return false;
  const abs = path.resolve(candidate);
  const base = path.resolve(root);
  if (abs === base) return true;
  // Separator anchor: without it "/tmp/repo-secrets" passes for "/tmp/repo".
  return abs.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}

/**
 * May this can_use_tool request be auto-allowed as a read inside one of the
 * thread's opted-in project roots?
 *
 * True only when the tool is read-shaped AND at least one path input is
 * present AND every path input resolves inside a root. Anything else is
 * false, so the caller falls through to prompting the user.
 *
 * @param {string} toolName
 * @param {Record<string, unknown> | null | undefined} input
 * @param {Array<{ name: string, path: string }> | null | undefined} roots
 * @returns {boolean}
 */
function autoAllowRead(toolName, input, roots) {
  if (typeof toolName !== "string" || !READ_TOOLS.has(toolName)) return false;
  if (!Array.isArray(roots) || roots.length === 0) return false;
  if (!input || typeof input !== "object") return false;

  const paths = PATH_KEYS.map((k) => /** @type {any} */ (input)[k]).filter(
    (v) => v !== undefined && v !== null,
  );
  if (paths.length === 0) return false;

  return paths.every(
    (p) =>
      typeof p === "string" &&
      roots.some((r) => r && isUnderRoot(p, r.path)),
  );
}

module.exports = { autoAllowRead, isUnderRoot, READ_TOOLS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import=./test/support/render.mjs --experimental-strip-types --test electron/test/read-reach.test.js`
Expected: PASS, all assertions.

- [ ] **Step 5: Commit**

```bash
git add electron/readReach.js electron/test/read-reach.test.js
git commit -m "Add read-reach path policy helper (#109)"
```

---

### Task 2: Thread field, setter and root resolution

**Files:**
- Modify: `electron/services.js` (`createThread` thread literal ~`:294`; `forkThread` patch ~`:684`; new exports near the other thread helpers; export list ~`:1846`)
- Modify: `electron/ipc.js` (next to `threads:setPinned` ~`:279`)
- Modify: `electron/preload.js` (next to `setPinned` ~`:99`)
- Test: `electron/test/read-reach-services.test.js` (new)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `services.setReadProjects(store, { threadId: string, projectIds: string[] }): Thread`
  - `services.readRootsFor(store, thread): Array<{ id: string, name: string, path: string }>`
  - thread field `readProjectIds: string[]`
  - IPC channel `threads:setReadProjects`, preload method `threads.setReadProjects`

- [ ] **Step 1: Write the failing test**

Create `electron/test/read-reach-services.test.js`:

```js
"use strict";

/**
 * Cross-project read reach (issue #109): the readProjectIds field, its
 * setter, root resolution and fork inheritance.
 *
 * Run: npm run test:electron
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../store.js");
const services = require("../services.js");

let tmpDir;
let store;
let appProject;
let docsProject;

/** addProject(store, absolutePath) — takes an existing directory. */
function project(name) {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir, { recursive: true });
  return services.addProject(store, dir);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "read-reach-"));
  store = new Store(path.join(tmpDir, "store.json"));
  appProject = project("app");
  docsProject = project("docs");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("readProjectIds", () => {
  it("defaults to an empty list on a new thread", () => {
    const t = services.createThread(store, { projectId: appProject.id });
    assert.deepEqual(t.readProjectIds, []);
  });

  it("sets and clears the list", () => {
    const t = services.createThread(store, { projectId: appProject.id });
    const set = services.setReadProjects(store, {
      threadId: t.id,
      projectIds: [docsProject.id],
    });
    assert.deepEqual(set.readProjectIds, [docsProject.id]);
    const cleared = services.setReadProjects(store, {
      threadId: t.id,
      projectIds: [],
    });
    assert.deepEqual(cleared.readProjectIds, []);
  });

  it("dedupes and rejects unknown ids and the thread's own project", () => {
    const t = services.createThread(store, { projectId: appProject.id });
    assert.throws(
      () =>
        services.setReadProjects(store, {
          threadId: t.id,
          projectIds: ["nope"],
        }),
      /Unknown project/,
    );
    assert.throws(
      () =>
        services.setReadProjects(store, {
          threadId: t.id,
          projectIds: [appProject.id],
        }),
      /own project/,
    );
    const set = services.setReadProjects(store, {
      threadId: t.id,
      projectIds: [docsProject.id, docsProject.id],
    });
    assert.deepEqual(set.readProjectIds, [docsProject.id]);
  });

  it("is config, not activity: updatedAt does not move", () => {
    const t = services.createThread(store, { projectId: appProject.id });
    const before = store.getThread(t.id).updatedAt;
    services.setReadProjects(store, {
      threadId: t.id,
      projectIds: [docsProject.id],
    });
    assert.equal(store.getThread(t.id).updatedAt, before);
  });
});

describe("readRootsFor", () => {
  it("resolves ids to name + path", () => {
    const t = services.createThread(store, { projectId: appProject.id });
    services.setReadProjects(store, {
      threadId: t.id,
      projectIds: [docsProject.id],
    });
    assert.deepEqual(services.readRootsFor(store, store.getThread(t.id)), [
      { id: docsProject.id, name: docsProject.name, path: docsProject.path },
    ]);
  });

  it("drops ids whose project was deleted, without a migration", () => {
    const t = services.createThread(store, { projectId: appProject.id });
    store.updateThread(t.id, { readProjectIds: ["gone-id"] });
    assert.deepEqual(services.readRootsFor(store, store.getThread(t.id)), []);
  });

  it("drops remote-host projects — their checkout is not on this disk", () => {
    const dir = path.join(tmpDir, "remote");
    fs.mkdirSync(dir, { recursive: true });
    const remote = services.addProject(store, dir, {
      remoteHost: "user@host",
      remotePath: "/srv/remote",
    });
    const t = services.createThread(store, { projectId: appProject.id });
    store.updateThread(t.id, { readProjectIds: [remote.id] });
    assert.deepEqual(services.readRootsFor(store, store.getThread(t.id)), []);
  });

  it("returns [] for a thread with no list at all (legacy threads)", () => {
    const t = services.createThread(store, { projectId: appProject.id });
    store.updateThread(t.id, { readProjectIds: undefined });
    assert.deepEqual(services.readRootsFor(store, store.getThread(t.id)), []);
  });
});

describe("fork inheritance", () => {
  it("carries readProjectIds to the fork, like permissionMode", () => {
    const t = services.createThread(store, { projectId: appProject.id });
    services.setReadProjects(store, {
      threadId: t.id,
      projectIds: [docsProject.id],
    });
    const fork = services.forkThread(store, { threadId: t.id });
    assert.deepEqual(fork.readProjectIds, [docsProject.id]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import=./test/support/render.mjs --experimental-strip-types --test electron/test/read-reach-services.test.js`
Expected: FAIL — `services.setReadProjects is not a function`.

`services.addProject(store, absolutePath, opts?)` is the fixture entry point — `createProject` is the other one, and it *creates and git-inits* a new folder under `parentDir`, which these tests do not want.

- [ ] **Step 3: Write minimal implementation**

In `electron/services.js`, add to the thread literal in `createThread`, directly after `worktreePath: null,`:

```js
    /**
     * Project ids this thread may READ (issue #109). Writes always stay in
     * projectId — this list never widens where a run can write.
     */
    readProjectIds: [],
```

Add the two functions next to `setProvider`:

```js
/**
 * Set the projects this thread may read from. Config, not activity: no touch.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, projectIds: string[] }} input
 */
function setReadProjects(store, input) {
  const { threadId } = input || {};
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const raw = Array.isArray(input.projectIds) ? input.projectIds : [];
  /** @type {string[]} */
  const next = [];
  for (const value of raw) {
    const id = String(value || "");
    if (!id || next.includes(id)) continue;
    if (id === thread.projectId) {
      throw new Error(
        "A thread already reads and writes its own project; " +
          "readProjectIds is for OTHER projects only",
      );
    }
    if (!store.getProject(id)) {
      throw new Error(`Unknown project: ${id}`);
    }
    next.push(id);
  }
  const updated = store.updateThread(threadId, { readProjectIds: next });
  store.save();
  return updated ? { ...updated } : { ...thread, readProjectIds: next };
}

/**
 * The thread's readable roots, resolved fresh on every call.
 *
 * Filtered at read time rather than migrated: deleting a project must not
 * leave a thread pointing at a root that is gone. Remote-host projects are
 * dropped — their checkout is not on this disk, so neither the prompt note
 * nor the claude auto-allow can say anything true about it.
 *
 * @param {import('./store').Store} store
 * @param {{ readProjectIds?: string[] } | null | undefined} thread
 * @returns {Array<{ id: string, name: string, path: string }>}
 */
function readRootsFor(store, thread) {
  const ids =
    thread && Array.isArray(thread.readProjectIds) ? thread.readProjectIds : [];
  /** @type {Array<{ id: string, name: string, path: string }>} */
  const out = [];
  for (const id of ids) {
    const project = store.getProject(String(id || ""));
    if (!project || project.remoteHost || !project.path) continue;
    out.push({
      id: project.id,
      name: String(project.name || project.slug || project.path),
      path: String(project.path),
    });
  }
  return out;
}
```

In `forkThread`, add one line to the `store.updateThread(created.id, {...})` patch, right after `permissionMode: source.permissionMode,`:

```js
    // A worker sent to do the looking needs the same reach as its parent.
    readProjectIds: Array.isArray(source.readProjectIds)
      ? [...source.readProjectIds]
      : [],
```

Add both names to the `module.exports` list at the bottom of the file, alphabetically among the existing entries:

```js
  readRootsFor,
  setReadProjects,
```

In `electron/ipc.js`, after the `"threads:setPinned"` handler:

```js
  "threads:setReadProjects": async (ctx, input) => {
    const thread = services.setReadProjects(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return thread;
  },
```

In `electron/preload.js`, after the `setPinned` line:

```js
    setReadProjects: (input) => invoke("threads:setReadProjects", input),
```

- [ ] **Step 4: Run the tests**

Run: `npm run test:electron`
Expected: PASS, including `read-reach-services` and the existing `ipc-seam` test (which fails if the preload method has no handler).

- [ ] **Step 5: Commit**

```bash
git add electron/services.js electron/ipc.js electron/preload.js electron/test/read-reach-services.test.js
git commit -m "Add per-thread readProjectIds with setter and root resolution (#109)"
```

---

### Task 3: Tell the agent about its read roots

**Files:**
- Modify: `electron/services.js` (`selfIdNoteFor` ~`:511`)
- Modify: `electron/runner.js` (the `services.selfIdNoteFor(...)` call ~`:3494`)
- Test: `electron/test/read-reach-services.test.js` (append)

**Interfaces:**
- Consumes: `services.readRootsFor` (Task 2).
- Produces: `services.selfIdNoteFor(thread, project, cwd, readRoots?)` — a fourth optional parameter. Existing three-argument callers keep working and emit no read-roots sentence.

- [ ] **Step 1: Write the failing test**

Append to `electron/test/read-reach-services.test.js`:

```js
describe("selfIdNoteFor read roots", () => {
  it("names each root's path and forbids writing there", () => {
    const t = services.createThread(store, { projectId: appProject.id });
    const note = services.selfIdNoteFor(
      store.getThread(t.id),
      appProject,
      appProject.path,
      [{ id: docsProject.id, name: "docs", path: docsProject.path }],
    );
    assert.match(note, /\[Read access\]/);
    assert.match(note, new RegExp(docsProject.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(note, /"docs"/);
    assert.match(note, /read/i);
    assert.match(note, /never write/i);
  });

  it("says nothing when there are no roots", () => {
    const t = services.createThread(store, { projectId: appProject.id });
    const note = services.selfIdNoteFor(
      store.getThread(t.id),
      appProject,
      appProject.path,
      [],
    );
    assert.equal(note.includes("[Read access]"), false);
  });

  it("emits read roots even with the coder-threads server down", () => {
    // The thread-id half is gated on coder-threads; read roots are not, and
    // in this test process no MCP server is registered.
    const t = services.createThread(store, { projectId: appProject.id });
    const note = services.selfIdNoteFor(
      store.getThread(t.id),
      appProject,
      appProject.path,
      [{ id: docsProject.id, name: "docs", path: docsProject.path }],
    );
    assert.match(note, /\[Read access\]/);
    assert.equal(note.includes("[Thread]"), false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import=./test/support/render.mjs --experimental-strip-types --test electron/test/read-reach-services.test.js`
Expected: FAIL — the note has no `[Read access]` section.

- [ ] **Step 3: Write minimal implementation**

Replace `selfIdNoteFor` in `electron/services.js` with a two-part version. Keep the existing doc comment above it and extend it; the body becomes:

```js
function selfIdNoteFor(thread, project, cwd, readRoots) {
  const parts = [];

  // Part 1: who am I. Gated on coder-threads being registered — with no
  // thread tools in the run, ids are noise.
  if (thread && thread.id && thread.projectId) {
    let orchUp = false;
    try {
      const { activeServers } = require("./memory-sup.js");
      orchUp = activeServers().some((s) => s.name === "coder-threads");
    } catch {
      orchUp = false;
    }
    if (orchUp) {
      const name = project && project.name ? String(project.name) : "this project";
      const where = cwd ? `, checked out at ${cwd}` : "";
      parts.push(
        `\n\n[Thread] You are thread ${thread.id} in project "${name}" ` +
          `(projectId ${thread.projectId})${where}. Pass these ids to the ` +
          `coder-threads tools; never guess another thread's id from its title. ` +
          `Threads in other projects are off limits.`,
      );
    }
  }

  // Part 2: what else may I read. Ungated: read roots matter whether or not
  // the orchestrator is running.
  //
  // ponytail: instruction, not enforcement. Only claude has a permission
  // channel (runner.js can_use_tool); grok, kimi and opencode run tools
  // unprompted, so on those providers this sentence IS the mechanism. Same
  // ceiling as assertSameProject in orchServer.js. Upgrade path: a provider
  // that can express a read-only root, or a post-run dirt check on each root.
  const roots = Array.isArray(readRoots) ? readRoots : [];
  if (roots.length > 0) {
    const list = roots.map((r) => `"${r.name}" at ${r.path}`).join(", ");
    parts.push(
      `\n\n[Read access] You may READ these other checkouts: ${list}. ` +
        `They are read-only: never write, edit, create or delete files there, ` +
        `never run builds or installs in them, and never run a git command ` +
        `that changes their state. Everything you produce belongs in your own ` +
        `project. This grants files only — threads in other projects remain ` +
        `off limits.`,
    );
  }

  return parts.join("");
}
```

In `electron/runner.js`, pass the roots at the call site:

```js
      services.selfIdNoteFor(
        dispatchThread,
        projectForGate,
        dispatchThread.worktreePath ||
          (projectForGate && projectForGate.path) ||
          null,
        services.readRootsFor(store, dispatchThread),
      );
```

- [ ] **Step 4: Run the tests**

Run: `npm run test:electron`
Expected: PASS. The existing self-id note assertions live in `electron/test/orch-server.test.js` and `electron/test/claude.test.js` — both must still pass unchanged, since part 1's text and gate are byte-identical.

- [ ] **Step 5: Commit**

```bash
git add electron/services.js electron/runner.js electron/test/read-reach-services.test.js
git commit -m "Name read roots in the dispatched prompt (#109)"
```

---

### Task 4: Auto-allow reads under a root on claude

**Files:**
- Modify: `electron/runner.js` (the `can_use_tool` branch, ~`:1669`)
- Test: `electron/test/claude.test.js` (new fake-CLI scenario + one test)

**Interfaces:**
- Consumes: `autoAllowRead` (Task 1), `services.readRootsFor` (Task 2).
- Produces: no new exports. Behaviour: a `can_use_tool` request that satisfies `autoAllowRead` is answered `{ behavior: "allow", updatedInput: <the original input> }` immediately and never becomes a pending permission.

- [ ] **Step 1: Write the failing test**

In `electron/test/claude.test.js`, add a scenario to the fake CLI script, next to the `permission` scenario (~`:698`). Note the escaped `\\n` — this script is written out as a JS string:

```js
  // Ask permission for one Read whose path comes from the environment, then
  // finish according to the answer. Used by the read-reach auto-allow test.
  if (scenario === "auto-read") {
    emit({ type: "system", subtype: "init", session_id: "sess-autoread", model: "m" });
    await delay(20);
    emit({
      type: "control_request",
      request_id: "req-autoread-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Read",
        input: { file_path: process.env.CODER_FAKE_CLAUDE_READ_PATH || "/nope" },
      },
    });
    let buf = "";
    process.stdin.on("data", (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf("\\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type !== "control_response") continue;
        if (process.env.CODER_FAKE_CLAUDE_CTRL_FILE) {
          fs.writeFileSync(process.env.CODER_FAKE_CLAUDE_CTRL_FILE, JSON.stringify(msg), "utf8");
        }
        const inner = (msg.response && msg.response.response) || {};
        emit({
          type: "result",
          subtype: "success",
          result: inner.behavior === "allow" ? "read allowed" : "read denied",
          usage: { input_tokens: 1, output_tokens: 1 },
          total_cost_usd: 0,
          num_turns: 1,
          session_id: "sess-autoread",
        });
        process.exit(0);
      }
    });
    await delay(30000);
    process.exit(1);
    return;
  }
```

Then add this test next to the existing permission test (~`:1183`):

```js
  it("auto-allows a read inside an opted-in project without asking the user", async () => {
    process.env.CODER_FAKE_CLAUDE_SCENARIO = "auto-read";
    const ctrlFile = path.join(tmpDir, "ctrl-autoread.json");
    process.env.CODER_FAKE_CLAUDE_CTRL_FILE = ctrlFile;
    const otherRepo = fs.mkdtempSync(path.join(os.tmpdir(), "other-repo-"));
    const readPath = path.join(otherRepo, "README.md");
    fs.writeFileSync(readPath, "# other\n", "utf8");
    process.env.CODER_FAKE_CLAUDE_READ_PATH = readPath;
    try {
      const other = services.addProject(store, otherRepo);
      const thread = store.getThreads()[0];
      services.setReadProjects(store, {
        threadId: thread.id,
        projectIds: [other.id],
      });

      await runner.startRun({ threadId: thread.id, prompt: "go look at other" });
      await waitFor(() => store.getThread(thread.id).status === "done");

      // Answered allow, by us, without a prompt ever reaching the user.
      const ctrl = JSON.parse(fs.readFileSync(ctrlFile, "utf8"));
      assert.equal(ctrl.response.response.behavior, "allow");
      assert.deepEqual(ctrl.response.response.updatedInput, {
        file_path: readPath,
      });
      assert.equal(ctrl.response.response.updatedPermissions, undefined);
      assert.equal(runner.getPendingPermission(thread.id), null);
      assert.equal(store.getThread(thread.id).awaitingInput, false);
      assert.ok(
        !pushes.some(
          (p) =>
            p.channel === "threads:changed" &&
            p.payload.some((t) => t.id === thread.id && t.awaitingInput === true),
        ),
      );
      // No "Allowed: ..." event — an auto-allow is not a user decision.
      assert.ok(
        !store
          .getMessages(thread.id)
          .some((m) => m.role === "event" && /^Allowed/.test(String(m.text))),
      );
    } finally {
      delete process.env.CODER_FAKE_CLAUDE_CTRL_FILE;
      delete process.env.CODER_FAKE_CLAUDE_READ_PATH;
      fs.rmSync(otherRepo, { recursive: true, force: true });
    }
  });

  it("still prompts for a read outside every opted-in project", async () => {
    process.env.CODER_FAKE_CLAUDE_SCENARIO = "auto-read";
    const ctrlFile = path.join(tmpDir, "ctrl-autoread-outside.json");
    process.env.CODER_FAKE_CLAUDE_CTRL_FILE = ctrlFile;
    process.env.CODER_FAKE_CLAUDE_READ_PATH = "/etc/hosts";
    try {
      const thread = store.getThreads()[0];
      await runner.startRun({ threadId: thread.id, prompt: "read /etc/hosts" });

      await waitFor(() => runner.getPendingPermission(thread.id) != null);
      const pending = runner.getPendingPermission(thread.id);
      assert.equal(pending.toolName, "Read");
      runner.respondPermission({
        threadId: thread.id,
        requestId: pending.requestId,
        decision: "deny",
      });
      await waitFor(() => store.getThread(thread.id).status === "done");
    } finally {
      delete process.env.CODER_FAKE_CLAUDE_CTRL_FILE;
      delete process.env.CODER_FAKE_CLAUDE_READ_PATH;
    }
  });
```

If `services` is not already required at the top of `claude.test.js`, it is — check line ~28 before adding an import.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import=./test/support/render.mjs --experimental-strip-types --test electron/test/claude.test.js`
Expected: FAIL on the first new test — the run stalls on a pending permission and `waitFor(status === "done")` times out.

- [ ] **Step 3: Write minimal implementation**

In `electron/runner.js`, require the helper at the top with the other requires:

```js
const { autoAllowRead } = require("./readReach.js");
```

In the `can_use_tool` branch, immediately after `rawInput` is computed and before `inputStr` is built, insert:

```js
            // Reads inside a project this thread opted into (issue #109) are
            // answered here instead of stopping the run. Write-shaped tools
            // and Bash always fall through to the user, so a write into
            // another repo is still a decision someone makes.
            if (
              autoAllowRead(
                toolName,
                rawInput,
                services.readRootsFor(store, store.getThread(threadId)),
              )
            ) {
              handle.respond(String(requestId), {
                behavior: "allow",
                updatedInput: rawInput,
              });
              return;
            }
```

- [ ] **Step 4: Run the tests**

Run: `npm run test:electron`
Expected: PASS, including both new claude tests and every pre-existing permission test (Bash, AskUserQuestion, ExitPlanMode all still prompt).

- [ ] **Step 5: Commit**

```bash
git add electron/runner.js electron/test/claude.test.js
git commit -m "Auto-allow claude reads inside an opted-in project (#109)"
```

---

### Task 5: Read access submenu

**Files:**
- Modify: `src/shared/ipc.ts` (`ThreadInfo` ~`:52`; the threads API block ~`:972`)
- Modify: `src/wireClient.ts` (~`:296`)
- Modify: `src/useCoder.ts` (action type ~`:190`, callback ~`:1166`, return object ~`:1825`)
- Modify: `src/App.tsx` (`<ThreadView>` props ~`:488`)
- Modify: `src/components/ThreadView.tsx` (props interface; overflow menu ~`:2246`)
- Test: `test/readAccessMenu.test.tsx` (new)

**Interfaces:**
- Consumes: `threads:setReadProjects` / `api.threads.setReadProjects` (Task 2).
- Produces: `ThreadView` props `projects: ProjectInfo[]` and `onSetReadProjects: (projectIds: string[]) => void | Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `test/readAccessMenu.test.tsx`. `mount` is **async** and returns a `Mounted` (`test/support/dom.ts`): use `m.query(sel)`, `await m.click(el)`, `m.unmount()` — there is no synchronous `{ container }` destructure.

```tsx
/**
 * Read access submenu (issue #109): a thread's opted-in readable projects.
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { mount, unmountAll } from "./support/dom.ts";
import { ThreadView } from "../src/components/ThreadView";
import type {
  ProjectInfo,
  ProviderInfo,
  ThreadDetail,
  ThreadInfo,
  WorkflowTemplateInfo,
} from "../src/shared/ipc";

const project: ProjectInfo = {
  id: "p1",
  slug: "owner/repo",
  name: "repo",
  path: "/tmp/repo",
};

const docs: ProjectInfo = {
  id: "p2",
  slug: "owner/docs",
  name: "docs",
  path: "/tmp/docs",
};

const remote: ProjectInfo = {
  id: "p3",
  slug: "owner/remote",
  name: "remote",
  path: "/tmp/remote",
  remoteHost: "user@host",
  remotePath: "/srv/remote",
};

const providers: ProviderInfo[] = [
  {
    id: "claude",
    name: "Claude Code",
    available: true,
    supportsResume: true,
    models: [],
    modelInfo: [],
    efforts: [],
  },
];

function thread(over: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id: "t1",
    projectId: "p1",
    title: "read access",
    branch: null,
    prNumber: null,
    prUrl: null,
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
    runStartedAt: null,
    archived: false,
    settledOverride: null,
    settledAt: null,
    handoffFrom: null,
    pinnedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    muted: false,
    lastVisitedAt: null,
    prState: null,
    provider: "claude",
    model: null,
    sessionId: null,
    permissionMode: "default",
    reasoningEffort: null,
    worktreePath: null,
    ...over,
  };
}

function detail(over: Partial<ThreadInfo> = {}): ThreadDetail {
  return {
    thread: thread(over),
    messages: [],
    workLog: [],
    workflow: null,
    usage: null,
  };
}

const noopSave = async () =>
  ({ id: "wf", name: "standard", phases: [] }) as WorkflowTemplateInfo;

function view(props: {
  threadOver?: Partial<ThreadInfo>;
  projects?: ProjectInfo[];
  onSetReadProjects?: (ids: string[]) => void;
}) {
  return (
    <ThreadView
      detail={detail(props.threadOver)}
      project={project}
      projects={props.projects ?? [project, docs, remote]}
      providers={providers}
      workflows={[]}
      hasProjects={true}
      onAddProject={() => {}}
      onStartRun={() => {}}
      onStartWorkflow={() => {}}
      onSaveWorkflow={noopSave}
      onRemoveWorkflow={async () => {}}
      onStopRun={() => {}}
      onSetPermissionMode={() => {}}
      onRespondPermission={() => {}}
      onSetProvider={() => {}}
      onSetReasoningEffort={() => {}}
      onSetArchived={() => {}}
      onDeleteThread={() => {}}
      onSetReadProjects={props.onSetReadProjects ?? (() => {})}
      changesOpen={false}
      changesNonce={0}
      onCloseChanges={() => {}}
      onFetchDiff={async () => ({ files: [], patch: "", truncated: false })}
      onCommitChanges={async () => ({ subject: "x" })}
      onRevertFile={async (path) => ({ path })}
      onSuggestCommitMessage={async () => ({ message: "feat: x" })}
      onPush={async () => ({ remote: "origin", branch: "main" })}
    />
  );
}

afterEach(unmountAll);

describe("read access submenu", () => {
  it("lists other local projects and reports a toggle", async () => {
    const calls: string[][] = [];
    const m = await mount(view({ onSetReadProjects: (ids) => calls.push(ids) }));
    await m.click(m.query("[aria-label='Thread actions']"));
    const entry = m.query("[data-read-access-menu]");
    assert.ok(entry, "Read access entry is in the overflow menu");
    await m.click(entry);

    // Own project and remote projects are not offered.
    assert.equal(m.query("[data-read-project='p1']"), null);
    assert.equal(m.query("[data-read-project='p3']"), null);

    const docsItem = m.query("[data-read-project='p2']");
    assert.ok(docsItem);
    assert.equal(docsItem.getAttribute("aria-checked"), "false");
    await m.click(docsItem);
    assert.deepEqual(calls, [["p2"]]);
    m.unmount();
  });

  it("shows an already-granted project as checked and toggles it off", async () => {
    const calls: string[][] = [];
    const m = await mount(
      view({
        threadOver: { readProjectIds: ["p2"] },
        onSetReadProjects: (ids) => calls.push(ids),
      }),
    );
    await m.click(m.query("[aria-label='Thread actions']"));
    await m.click(m.query("[data-read-access-menu]"));
    const docsItem = m.query("[data-read-project='p2']");
    assert.equal(docsItem?.getAttribute("aria-checked"), "true");
    await m.click(docsItem);
    assert.deepEqual(calls, [[]]);
    m.unmount();
  });
});
```

If `tsc` rejects the `view()` prop list because `ThreadView` requires a prop not listed here, add it with a no-op value — do not make the real prop optional to satisfy the test.

- [ ] **Step 2: Run test to verify it fails**

Run: `CODER_GROK_MCP_DISABLE=1 node --import=./test/support/render.mjs --experimental-strip-types --test --test-timeout=20000 test/readAccessMenu.test.tsx`
Expected: FAIL — `[data-read-access-menu]` is null.

- [ ] **Step 3: Write minimal implementation**

`src/shared/ipc.ts` — in `ThreadInfo`, after `worktreePath`:

```ts
  /**
   * Projects this thread may READ (issue #109). Writes always stay in
   * projectId. Absent on threads created before the field existed.
   */
  readProjectIds?: string[];
```

and in the threads API interface, after `setPinned`:

```ts
    setReadProjects(input: {
      threadId: string;
      projectIds: string[];
    }): Promise<ThreadInfo>;
```

`src/wireClient.ts`, after `setPinned`:

```ts
      setReadProjects: (input) =>
        call<ThreadInfo>("threads:setReadProjects", input),
```

`src/useCoder.ts` — action type next to `setPinned`:

```ts
  setReadProjects: (threadId: string, projectIds: string[]) => Promise<void>;
```

callback next to the `setPinned` callback (match its exact shape, including how it refreshes thread state after the call):

```ts
  const setReadProjects = useCallback(
    async (threadId: string, projectIds: string[]) => {
      const thread = await api.threads.setReadProjects({ threadId, projectIds });
      patchThread(thread);
    },
    [api, patchThread],
  );
```

Use whatever the neighbouring `setPinned` callback uses to apply the returned thread — if it calls something other than `patchThread`, call that instead. Add `setReadProjects` to the returned object next to `setPinned`.

`src/App.tsx` — pull `setReadProjects` from the `useCoder` destructure at `:32` alongside the other actions, and add two props to `<ThreadView>`:

```tsx
        projects={projects}
        onSetReadProjects={(projectIds) =>
          selectedThreadId
            ? setReadProjects(selectedThreadId, projectIds)
            : undefined
        }
```

`src/components/ThreadView.tsx` — in `ThreadViewProps`, after `project`:

```tsx
  /** Every project in the workspace; the Read access submenu lists the others. */
  projects: ProjectInfo[];
  /** Replace the thread's readable-project list (issue #109). */
  onSetReadProjects: (projectIds: string[]) => void | Promise<void>;
```

Destructure both in the component signature. Add state next to `handoffMenuOpen`:

```tsx
  const [readMenuOpen, setReadMenuOpen] = useState(false);
```

Close it in the same outside-click effect that closes `menuOpen` (add `setReadMenuOpen(false)` beside `setMenuOpen(false)`).

Add the entry inside the overflow menu, directly after the "Copy thread ID" button:

```tsx
                    {readableProjects.length > 0 && (
                      <div className={styles.menuWrap}>
                        <button
                          type="button"
                          className={styles.menuItem}
                          role="menuitem"
                          data-read-access-menu=""
                          aria-haspopup="menu"
                          aria-expanded={readMenuOpen}
                          onClick={() => setReadMenuOpen((v) => !v)}
                        >
                          Read access
                          {granted.length > 0 ? ` (${granted.length})` : ""}
                        </button>
                        {readMenuOpen && (
                          <div className={styles.menu} role="menu">
                            {readableProjects.map((p) => {
                              const on = granted.includes(p.id);
                              return (
                                <button
                                  key={p.id}
                                  type="button"
                                  className={styles.menuItem}
                                  role="menuitemcheckbox"
                                  aria-checked={on}
                                  data-read-project={p.id}
                                  title={`${p.name} — ${p.path}`}
                                  onClick={() => {
                                    void onSetReadProjects(
                                      on
                                        ? granted.filter((id) => id !== p.id)
                                        : [...granted, p.id],
                                    );
                                  }}
                                >
                                  {on ? "✓ " : ""}
                                  {p.name}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
```

with these two derivations near the other `useMemo`s in the component body:

```tsx
  const granted = useMemo(
    () => thread?.readProjectIds ?? [],
    [thread?.readProjectIds],
  );
  // Own project: already writable. Remote projects: not on this disk, so
  // neither the prompt note nor the auto-allow can say anything true.
  const readableProjects = useMemo(
    () =>
      projects.filter((p) => p.id !== thread?.projectId && !p.remoteHost),
    [projects, thread?.projectId],
  );
```

If `thread` is not already in scope at that point in the component, use the same expression the surrounding code uses for it (`detail?.thread`).

- [ ] **Step 4: Run the tests**

Run: `npm run test:renderer && npm run typecheck`
Expected: PASS both. `typecheck` catches any missed prop on the other `ThreadView` render sites.

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc.ts src/wireClient.ts src/useCoder.ts src/App.tsx src/components/ThreadView.tsx test/readAccessMenu.test.tsx
git commit -m "Add Read access submenu to the thread menu (#109)"
```

---

### Task 6: Full suite and issue update

**Files:**
- Modify: `docs/superpowers/specs/2026-08-16-cross-project-read-reach-design.md` (only if implementation diverged)

- [ ] **Step 1: Run every suite**

Run: `npm test`
Expected: PASS across core, renderer, electron and memory. Record the total test count and failure count — the number goes in the issue comment.

- [ ] **Step 2: Run the typecheck and build**

Run: `npm run build`
Expected: PASS (`tsc --noEmit` then `vite build`).

- [ ] **Step 3: Reconcile the spec**

Read `docs/superpowers/specs/2026-08-16-cross-project-read-reach-design.md` against what was built. If anything diverged (a different helper name, a different menu placement), edit the spec to match reality. If nothing diverged, skip to step 4.

- [ ] **Step 4: Commit any spec fix and update the issue**

```bash
git add -A
git commit -m "Reconcile read-reach spec with implementation (#109)" || true
gh issue comment 109 --body "<summary: what shipped, the per-provider ceiling, test count>"
gh issue edit 109 --remove-label plan:doing --add-label plan:done
```

Leave the issue OPEN until the branch merges; close it in the merge PR.

---

## Notes for the implementer

- **The thing that will bite you:** `handle.respond` in Task 4 must be called with the same `requestId` string the CLI sent, and the branch must `return` immediately after — falling through queues a pending permission the user then has to answer for a request already answered, and the CLI will reject the second response.
- **What this feature is NOT:** it does not stop grok, kimi or opencode writing to another repo. They have no permission channel; they could already do that before this change. The prompt sentence is the only lever there, and that is stated in the spec's ceiling section. Do not add a provider flag to "fix" this.
- **Do not touch** `electron/worktrees.js`, `electron/providers.js`, or any diff/commit/PR path. Nothing writes outside the owning project, so nothing there changes.
