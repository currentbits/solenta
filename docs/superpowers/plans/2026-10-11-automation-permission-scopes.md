# Automation Permission Scopes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a project share automation definitions in `solenta.json` while each machine opts in before those automations auto-fire.

**Architecture:** Definitions live in `solenta.json` under `automations` with their own trust hash (`automationsTrust` on the project). Runtime state stays in the local store as overlay rows id’d `shared:<projectId>:<slug>`. `listAutomations` merges file + overlay. The ticker and GitHub poller use that merge and skip a project-scoped row unless it is trusted and `enabled` on this machine.

**Tech Stack:** Electron main (CommonJS `electron/*.js`), React 18 + TypeScript renderer, `node:test`. No new dependency.

Spec: `docs/superpowers/specs/2026-10-11-automation-permission-scopes-design.md`. Issue: #1590.

## Global Constraints

- **Firing model is local opt-in.** Shared file = definition. Auto-fire only when `enabled === true` on this machine and, for `scope === "project"`, `project.automationsTrust ===` the current automations hash. Creator auto-trusts and `enabled: true`. Teammates start `enabled: false` and untrusted.
- **Shared home is `solenta.json`, not `.solenta/`.** `.solenta/` is gitignored.
- **Separate hash from commands.** `automationsTrust` is independent of `repoConfigTrust`. Approving `npm test` must not approve a new agent prompt.
- **`enabled` is never written to the file.** It means auto-fire on this machine for both scopes.
- **Approve-and-run does not flip `enabled`.** `runNow({ id, hash })` on an untrusted shared row trusts, fires once, leaves `enabled` as-is.
- **Slug:** `^[a-z][a-z0-9-]{0,47}$`. At most 16 automations. Prompt cap 4000. `MAX_BYTES` 256 KB.
- **No auto-commit. No private ↔ project convert. No SSH file read/write.**
- **There is no `projects:changed` push today.** `trustFile` stores the hash; the renderer re-lists projects with the existing `api.projects.list()` path. Do not add a new push channel.
- Every new `electron/` file starts with `"use strict";`. JSDoc on exported functions.
- After editing `src/shared/ipcChannels.ts`, run `node --experimental-strip-types scripts/sync-ipc-preload.js`.
- Test commands, verbatim:
  - one electron file: `node --import=./test/support/render.mjs --experimental-strip-types --test electron/test/<file>.test.js`
  - one renderer file: `CODER_GROK_MCP_DISABLE=1 node --import=./test/support/render.mjs --experimental-strip-types --test --test-timeout=20000 test/<file>.test.tsx`
  - typecheck: `npm run typecheck`
- Commit after every task. Message style: imperative subject, include `(#1590)`.

## File Structure

| File | Responsibility |
|---|---|
| `electron/automations-file.js` (new) | Parse/hash/write the `automations` key; slugs; shared ids; merge; `canAutoFire`; orphan GC; cache invalidation hook. |
| `electron/repoConfig.js` | Raise `MAX_BYTES` to 256 KB; export `invalidateRepoConfigCache(root)`; `presentAutomationsFile(project)`. |
| `electron/store-migrate.js` | `scope` default `"private"`; normalize `automationsTrust`. |
| `electron/services-settings.js` | Merged `listAutomations`; project-scope add/update/remove; `trustFile`. |
| `electron/automations.js` | Ticker uses merged list + `canAutoFire`; `runNow` accepts `{ id, hash? }`; ensure overlay before fire. |
| `electron/automation-triggers.js` | `pollTriggers` uses merged list + `canAutoFire`. |
| `electron/projectIcon.js` `presentProject` | Attach `automationsFile`. |
| `electron/ipc-runs.js` | `automations:trustFile`; pass `hash` into `runNow`. |
| `src/shared/ipc.ts` | `scope`, `automationsFile`, `trustFile`, `runNow` hash. |
| `src/shared/ipcChannels.ts` + preload | New `trustFile` row. |
| `src/components/AutomationsView.tsx` | Scope select, badge, approve card, write note, enable copy. |
| `src/coder/useCoderWorkflows.ts` | `runNow` may pass `hash`; `trustAutomationsFile`. |
| `src/dev/automations.ts` + `test/support/fakeCoder.ts` | Same semantics / stub. |
| `electron/test/automations-file.test.js` (new) | Parse, hash, write, merge, fire gate, trust, orphan GC. |
| `electron/test/automations.test.js` | Ticker / `runNow` hash / private unchanged. |
| `test/automationsView.test.tsx` | Scope, badge, approve card, write note. |

---

### Task 1: Parse, hash, and present the automations section

**Files:**
- Create: `electron/automations-file.js`
- Modify: `electron/repoConfig.js` (`MAX_BYTES`, cache invalidate, `presentAutomationsFile`)
- Modify: `electron/projectIcon.js` (`presentProject` attaches `automationsFile`)
- Test: `electron/test/automations-file.test.js`

**Interfaces:**
- Consumes: `electron/repoConfig.js` `readRepoConfig` cache (via a new `readRepoJson` or by reading the same file); `normalizeTrigger` from `electron/automation-triggers.js`; `normalizeRoute` from `electron/routing.js`; `isKnownProviderId` from `electron/services-notes.js`.
- Produces:
  - `SLUG_RE`, `MAX_SHARED_AUTOMATIONS` (16), `sharedId(projectId, slug)`, `slugFromName(name, taken)`
  - `parseAutomations(data) → { automations, hash } | { error, automations: [] }`
  - `automationsHash(rows)`, `readAutomations(root)`, `presentAutomationsFile(project)`
  - `invalidateRepoConfigCache(absFileOrRoot)` exported from `repoConfig.js`

- [ ] **Step 1: Write the failing test**

Create `electron/test/automations-file.test.js`:

```js
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  parseAutomations,
  automationsHash,
  readAutomations,
  presentAutomationsFile,
  slugFromName,
  sharedId,
  MAX_SHARED_AUTOMATIONS,
} = require("../automations-file.js");
const { parseRepoConfig } = require("../repoConfig.js");

const ROW = {
  id: "pr-triage",
  name: "PR triage",
  prompt: "Triage the new pull request.",
  provider: "claude",
  model: null,
  preset: "hourly",
  hour: null,
  trigger: { type: "github", event: "pr_opened" },
  tier: null,
};

describe("parseAutomations", () => {
  it("accepts a valid row and hashes independently of commands", () => {
    const section = parseAutomations({ setup: "npm ci", automations: [ROW] });
    assert.equal(section.error, undefined);
    assert.equal(section.automations.length, 1);
    assert.equal(section.automations[0].id, "pr-triage");
    assert.match(section.hash, /^[0-9a-f]{64}$/);
    const commands = parseRepoConfig({ setup: "npm ci", automations: [ROW] });
    assert.notEqual(section.hash, commands.hash);
    const tweaked = parseAutomations({
      setup: "npm ci",
      automations: [{ ...ROW, prompt: "Different" }],
    });
    assert.notEqual(section.hash, tweaked.hash);
    const sameAuto = parseAutomations({
      setup: "evil",
      automations: [ROW],
    });
    assert.equal(section.hash, sameAuto.hash);
  });

  it("one bad row fails only the automations section", () => {
    const data = {
      setup: "npm ci",
      automations: [{ ...ROW, id: "BAD" }],
    };
    const section = parseAutomations(data);
    assert.match(section.error, /id/);
    assert.deepEqual(section.automations, []);
    const commands = parseRepoConfig(data);
    assert.equal(commands.setup, "npm ci");
    assert.equal(commands.error, undefined);
  });

  it("rejects a 17th row, a duplicate id, and a too-long prompt", () => {
    const many = Array.from({ length: MAX_SHARED_AUTOMATIONS + 1 }, (_, i) => ({
      ...ROW,
      id: `job-${i}`,
    }));
    assert.match(parseAutomations({ automations: many }).error, /16/);
    assert.match(
      parseAutomations({ automations: [ROW, { ...ROW, name: "Other" }] }).error,
      /duplicate/i,
    );
    assert.match(
      parseAutomations({ automations: [{ ...ROW, prompt: "x".repeat(4001) }] })
        .error,
      /4000/,
    );
  });

  it("an automations-only file still presents", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-auto-"));
    fs.writeFileSync(
      path.join(dir, "solenta.json"),
      JSON.stringify({ automations: [ROW] }),
    );
    assert.equal(parseRepoConfig({ automations: [ROW] }), null);
    const section = readAutomations(dir);
    assert.equal(section.automations[0].id, "pr-triage");
    const presented = presentAutomationsFile({ path: dir });
    assert.equal(presented.count, 1);
    assert.equal(presented.trusted, false);
    assert.equal(presentAutomationsFile({ remoteHost: "h", path: dir }), null);
  });
});

describe("slugFromName", () => {
  it("derives pr-triage and falls back to auto", () => {
    assert.equal(slugFromName("PR triage", []), "pr-triage");
    assert.equal(slugFromName("PR triage", ["pr-triage"]), "pr-triage-2");
    assert.equal(slugFromName("!!!", []), "auto");
    assert.equal(slugFromName("!!!", ["auto"]), "auto-2");
  });
});

describe("sharedId", () => {
  it("is shared:project:slug", () => {
    assert.equal(sharedId("p1", "pr-triage"), "shared:p1:pr-triage");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import=./test/support/render.mjs --experimental-strip-types --test electron/test/automations-file.test.js`

Expected: FAIL — `Cannot find module '../automations-file.js'`

- [ ] **Step 3: Write minimal implementation**

`electron/automations-file.js`:

- `SLUG_RE = /^[a-z][a-z0-9-]{0,47}$/`
- `MAX_SHARED_AUTOMATIONS = 16`
- `PROMPT_MAX = 4000`
- `sharedId(projectId, slug)` → `` `shared:${projectId}:${slug}` ``
- `slugFromName(name, taken)`: lower-case, replace `[^a-z0-9]+` with `-`, trim hyphens; if it fails `SLUG_RE` use `auto`; while taken, append `-2`, `-3`, …
- `parseAutomations(data)`: if `data.automations` is undefined, return `{ automations: [], hash: null }`. If not an array, `{ error, automations: [] }`. Validate each row (slug, unique, name, prompt ≤ 4000, `isKnownProviderId`, preset, hour, `normalizeTrigger` / `parseTriggerInput` for trigger, `normalizeRoute` for tier). On any failure return `{ error, automations: [] }` and **no** hash. Success: `{ automations: normalizedRows, hash: automationsHash(rows) }`.
- `automationsHash(rows)`: `createHash("sha256").update(JSON.stringify(rows.map(canonical))).digest("hex")` where canonical is `{ id, name, prompt, provider, model, preset, hour, trigger, tier }` in that key order.
- `readAutomations(root)`: read `<root>/solenta.json` (reuse `readRepoConfig`’s file read or a shared `readRepoJson` so mtime cache is one). Missing file → `{ automations: [], hash: null }`. Invalid JSON → `{ error: "solenta.json is not valid JSON", automations: [] }`. Else `parseAutomations(json)`.
- `presentAutomationsFile(project)`: null when `!project || project.remoteHost || !project.path`. Else `readAutomations(project.path)`; if no hash and no error, return null (no automations key). Else `{ hash, trusted: project.automationsTrust === hash, error, count }`.

`electron/repoConfig.js`:

- `MAX_BYTES = 256 * 1024` and change the oversize error string from
  `larger than 64 KB` to `larger than 256 KB`.
- Export `invalidateRepoConfigCache(root)` that `cache.delete(path.join(root, REPO_CONFIG_FILE))`.
- Keep `parseRepoConfig` command-only. An automations-only object still returns `null` (no commands). Do not let automations poison the commands parse.

`electron/projectIcon.js` `presentProject`: after `repoConfig`,

```js
const automationsFile = require("./automations-file.js").presentAutomationsFile(next);
if (automationsFile) next = { ...next, automationsFile };
```

- [ ] **Step 4: Run the tests**

Run: `node --import=./test/support/render.mjs --experimental-strip-types --test electron/test/automations-file.test.js electron/test/project-setup-h3.test.js`

Expected: PASS. Existing command tests still pass; `MAX_BYTES` change must not break the “larger than 64 KB” test — update that assertion in `project-setup-h3.test.js` to 256 KB if it mentions 64.

- [ ] **Step 5: Commit**

```bash
git add electron/automations-file.js electron/repoConfig.js electron/projectIcon.js electron/test/automations-file.test.js electron/test/project-setup-h3.test.js
git commit -m "$(cat <<'EOF'
Parse shared automations from solenta.json (#1590)

EOF
)"
```

---

### Task 2: Store migration for `scope` and `automationsTrust`

**Files:**
- Modify: `electron/store-migrate.js` (`migrateAutomation`, `migrateProject`)
- Test: `electron/test/store.test.js` (existing automation migrate case) and `electron/test/project-setup-h3.test.js` (trust hash normalize)

**Interfaces:**
- Consumes: `normalizeTrustHash` (already required).
- Produces: every loaded automation has `scope: "private" | "project"`; `automationsTrust` is 64 hex or absent.

- [ ] **Step 1: Write the failing test**

Add to `electron/test/store.test.js` next to the existing automations migrate test:

```js
it("migrates missing automation scope to private", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-store-"));
  const file = path.join(dir, "store.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      projects: [],
      threads: [],
      automations: [
        {
          id: "a1",
          projectId: "p",
          name: "Old",
          prompt: "x",
          provider: "claude",
          preset: "hourly",
        },
      ],
    }),
  );
  const store = new Store(file);
  const [auto] = store.getAutomations();
  assert.equal(auto.scope, "private");
});
```

Add to `electron/test/project-setup-h3.test.js` beside the `repoConfigTrust` normalize cases:

```js
it("drops a non-hex automationsTrust", () => {
  const n = migrateProject({ id: "p", path: "/tmp/p", automationsTrust: "nothex" });
  assert.equal(n.automationsTrust, undefined);
});

it("keeps a hex automationsTrust", () => {
  const ok = migrateProject({
    id: "p",
    path: "/tmp/p",
    automationsTrust: "a".repeat(64),
  });
  assert.equal(ok.automationsTrust, "a".repeat(64));
});
```

- [ ] **Step 2: Run to verify fail**

Run: `node --import=./test/support/render.mjs --experimental-strip-types --test electron/test/store.test.js electron/test/project-setup-h3.test.js`

Expected: FAIL on `scope` / `automationsTrust`.

- [ ] **Step 3: Implement**

In `migrateAutomation`, add:

```js
scope: a.scope === "project" ? "project" : "private",
```

In `migrateProject`, after `repoConfigTrust`:

```js
const autoTrust = normalizeTrustHash(next.automationsTrust);
if (autoTrust) next.automationsTrust = autoTrust;
else delete next.automationsTrust;
```

- [ ] **Step 4: Re-run those two files**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/store-migrate.js electron/test/store.test.js electron/test/project-setup-h3.test.js
git commit -m "$(cat <<'EOF'
Migrate automation scope and automationsTrust (#1590)

EOF
)"
```

---

### Task 3: Merged list

**Files:**
- Modify: `electron/automations-file.js` (`mergeAutomations`, `gcOrphanOverlays`, `canAutoFire`)
- Modify: `electron/services-settings.js` (`listAutomations`)
- Test: `electron/test/automations-file.test.js`

**Interfaces:**
- Consumes: `Store.getAutomations`, `Store.getProjects`, `nextFire` from `electron/automations.js`.
- Produces:
  - `mergeAutomations(store, nowMs) → AutomationInfo[]`
  - `gcOrphanOverlays(store) → boolean` (true if it mutated)
  - `canAutoFire(store, auto) → boolean`
  - `listAutomations(store)` returns the merge (no save)

- [ ] **Step 1: Write the failing test**

Append to `electron/test/automations-file.test.js`. Use a real `Store` + temp repo with `solenta.json`:

```js
const { Store } = require("../store.js");
const { mergeAutomations, gcOrphanOverlays, canAutoFire } = require("../automations-file.js");
const services = require("../services.js");

function tempRepo(automations) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-auto-"));
  fs.writeFileSync(
    path.join(dir, "solenta.json"),
    JSON.stringify({ automations }, null, 2),
  );
  return dir;
}

describe("mergeAutomations", () => {
  it("lists private store rows plus file rows with overlay defaults", () => {
    const dir = tempRepo([ROW]);
    const store = new Store(path.join(dir, "store.json"));
    store.setProjects([{ id: "p1", name: "p", path: dir }]);
    store.setAutomations([
      {
        id: "uuid-1",
        projectId: "p1",
        name: "Local",
        prompt: "x",
        provider: "claude",
        preset: "hourly",
        hour: null,
        enabled: true,
        scope: "private",
        lastRunAt: null,
        nextRunAt: 1,
        lastError: null,
      },
    ]);
    const listed = mergeAutomations(store, Date.now());
    assert.equal(listed.length, 2);
    const shared = listed.find((a) => a.scope === "project");
    assert.equal(shared.id, "shared:p1:pr-triage");
    assert.equal(shared.enabled, false);
    assert.equal(shared.prompt, ROW.prompt);
    assert.equal(shared.memory, "");
    assert.equal(shared.triggerCursor, null);
    assert.equal(canAutoFire(store, shared), false);
  });

  it("file definition wins; overlay keeps enabled/cursor/memory", () => {
    const dir = tempRepo([{ ...ROW, prompt: "From file" }]);
    const store = new Store(path.join(dir, "store.json"));
    store.setProjects([{ id: "p1", name: "p", path: dir, automationsTrust: "dead".repeat(16) }]);
    store.setAutomations([
      {
        id: "shared:p1:pr-triage",
        projectId: "p1",
        scope: "project",
        name: "Stale",
        prompt: "Stale",
        provider: "claude",
        preset: "hourly",
        hour: null,
        enabled: true,
        memory: "keep me",
        triggerCursor: 9,
        lastRunAt: 1,
        nextRunAt: 2,
        lastError: null,
      },
    ]);
    const shared = mergeAutomations(store, Date.now()).find((a) => a.scope === "project");
    assert.equal(shared.prompt, "From file");
    assert.equal(shared.name, "PR triage");
    assert.equal(shared.enabled, true);
    assert.equal(shared.memory, "keep me");
    assert.equal(shared.triggerCursor, 9);
    assert.equal(canAutoFire(store, shared), false); // trust mismatch
  });

  it("gc drops overlays whose slug left the file", () => {
    const dir = tempRepo([]);
    const store = new Store(path.join(dir, "store.json"));
    store.setProjects([{ id: "p1", name: "p", path: dir }]);
    store.setAutomations([
      {
        id: "shared:p1:gone",
        projectId: "p1",
        scope: "project",
        name: "Gone",
        prompt: "x",
        provider: "claude",
        preset: "hourly",
        hour: null,
        enabled: true,
        lastRunAt: null,
        nextRunAt: 0,
        lastError: null,
      },
    ]);
    assert.equal(gcOrphanOverlays(store), true);
    assert.equal(store.getAutomations().length, 0);
  });
});
```

Also add: `services.listAutomations(store)` equals `mergeAutomations(store, …)` (same ids).

- [ ] **Step 2: Run to verify fail**

Expected: FAIL — `mergeAutomations` not exported / `listAutomations` still raw store.

- [ ] **Step 3: Implement**

`mergeAutomations(store, nowMs)`:

1. `privates` = store rows with `scope !== "project"`.
2. For each local project, `readAutomations(project.path)`. Skip `error` / empty.
3. For each file row, id = `sharedId(project.id, row.id)`. Overlay = store row with that id, else defaults (`enabled: false`, `memory: ""`, `triggerCursor: null`, `lastRunAt: null`, `lastError: null`, `consecutiveFailures: 0`, `pendingRunThreadId: null`, `nextRunAt: nextFire(preset, hour, nowMs)`).
4. Definition fields from the file always.
5. Return `[...privates, ...shared]`.

`canAutoFire(store, auto)`: `auto.enabled` and (if `scope === "project"`, `presentAutomationsFile(project)?.trusted`).

`gcOrphanOverlays(store)`: valid ids = every `sharedId` currently in files; drop store rows with `scope === "project"` whose id is not valid. Return whether the list changed. **Do not save.**

`listAutomations`: `return mergeAutomations(store, Date.now()).map((a) => ({ ...a }))`.

Avoid a require cycle: `automations-file.js` should require `nextFire` lazily inside `mergeAutomations` (`require("./automations.js").nextFire`).

- [ ] **Step 4: Re-run `electron/test/automations-file.test.js` and `electron/test/automations.test.js`**

Expected: PASS. Existing `listAutomations` tests still see private-only stores.

- [ ] **Step 5: Commit**

```bash
git add electron/automations-file.js electron/services-settings.js electron/test/automations-file.test.js
git commit -m "$(cat <<'EOF'
Merge solenta.json automations with local overlays (#1590)

EOF
)"
```

---

### Task 4: Project-scope writes

**Files:**
- Modify: `electron/automations-file.js` (`writeAutomations`, `ensureOverlay`)
- Modify: `electron/services-settings.js` (`addAutomation`, `updateAutomation`, `removeAutomation`)
- Test: `electron/test/automations-file.test.js`

**Interfaces:**
- Consumes: `parseAutomations`, `invalidateRepoConfigCache`, `normalizeAutomationInput`.
- Produces: add/update/remove with `scope: "project"` mutate `<project.path>/solenta.json` and the overlay; auto-set `automationsTrust`; `gcOrphanOverlays` on those writes then `store.save()`.

- [ ] **Step 1: Write the failing test**

```js
describe("project-scope writes", () => {
  it("add writes solenta.json, trusts, and enables", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-auto-"));
    const store = new Store(path.join(dir, "store.json"));
    store.setProjects([{ id: "p1", name: "p", path: dir }]);
    const created = services.addAutomation(store, {
      projectId: "p1",
      name: "PR triage",
      prompt: "Triage",
      provider: "claude",
      preset: "hourly",
      scope: "project",
    });
    assert.equal(created.scope, "project");
    assert.equal(created.id, "shared:p1:pr-triage");
    assert.equal(created.enabled, true);
    const file = JSON.parse(fs.readFileSync(path.join(dir, "solenta.json"), "utf8"));
    assert.equal(file.automations[0].id, "pr-triage");
    assert.equal(file.automations[0].enabled, undefined);
    const hash = parseAutomations(file).hash;
    assert.equal(store.getProject("p1").automationsTrust, hash);
    assert.equal(canAutoFire(store, created), true);
  });

  it("teammate overlay defaults disabled; memory update does not rewrite prompt", () => {
    const dir = tempRepo([ROW]);
    const store = new Store(path.join(dir, "store.json"));
    store.setProjects([{ id: "p1", name: "p", path: dir }]);
    const listed = services.listAutomations(store).find((a) => a.scope === "project");
    assert.equal(listed.enabled, false);
    services.updateAutomation(store, { id: listed.id, memory: "notes" });
    const file = JSON.parse(fs.readFileSync(path.join(dir, "solenta.json"), "utf8"));
    assert.equal(file.automations[0].prompt, ROW.prompt);
    assert.equal(services.listAutomations(store)[0].memory, "notes");
  });

  it("remove drops the slug; invalid JSON is not clobbered; remote is rejected", () => {
    const dir = tempRepo([ROW]);
    const store = new Store(path.join(dir, "store.json"));
    store.setProjects([{ id: "p1", name: "p", path: dir }]);
    const id = "shared:p1:pr-triage";
    services.removeAutomation(store, { id });
    const file = JSON.parse(fs.readFileSync(path.join(dir, "solenta.json"), "utf8"));
    assert.deepEqual(file.automations, []);

    fs.writeFileSync(path.join(dir, "solenta.json"), "{ nope");
    store.setProjects([{ id: "p1", name: "p", path: dir }]);
    assert.throws(
      () =>
        services.addAutomation(store, {
          projectId: "p1",
          name: "X",
          prompt: "x",
          provider: "claude",
          preset: "hourly",
          scope: "project",
        }),
      /not valid JSON/,
    );
    assert.equal(fs.readFileSync(path.join(dir, "solenta.json"), "utf8"), "{ nope");

    store.setProjects([{ id: "r1", name: "r", path: dir, remoteHost: "h" }]);
    assert.throws(
      () =>
        services.addAutomation(store, {
          projectId: "r1",
          name: "X",
          prompt: "x",
          provider: "claude",
          preset: "hourly",
          scope: "project",
        }),
      /remote/i,
    );
  });

  it("rejects changing scope and a private id that starts with shared:", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-auto-"));
    const store = new Store(path.join(dir, "store.json"));
    store.setProjects([{ id: "p1", name: "p", path: dir }]);
    const priv = services.addAutomation(store, {
      projectId: "p1",
      name: "Local",
      prompt: "x",
      provider: "claude",
      preset: "hourly",
    });
    assert.equal(priv.scope, "private");
    assert.throws(
      () => services.updateAutomation(store, { id: priv.id, scope: "project" }),
      /scope/,
    );
  });
});
```

Preserve unknown keys: start with `{ setup: "npm ci", extra: true }` and after add, `setup` and `extra` remain.

- [ ] **Step 2: Run to verify fail**

Expected: FAIL — add ignores `scope`.

- [ ] **Step 3: Implement**

`writeAutomations(projectPath, rows)`:

1. Read file. Missing → `doc = {}`. Exists + invalid JSON → throw `solenta.json is not valid JSON`.
2. `doc.automations = rows` (definition fields only). If `rows` is empty, write `automations: []` (do not delete the key).
3. `fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n")`.
4. `invalidateRepoConfigCache(projectPath)`.
5. Return `parseAutomations(doc)`.

`addAutomation`: after `normalizeAutomationInput`, if `scope === "project"` (from input; existing is null):

- Reject `remoteHost` / missing path.
- Reject an explicit `id` that fails `SLUG_RE`.
- Slug = input.id or `slugFromName(name, existingFileIds)`.
- Append definition to file via `writeAutomations`.
- `store.updateProject` / setProjects field `automationsTrust = hash`.
- Push overlay `{ id: sharedId(...), scope: "project", enabled: input.enabled !== false, …runtime defaults }`.
- `gcOrphanOverlays`; save; return merged row.

Private add: if someone passed `id` starting with `shared:`, throw. Default `scope: "private"`. Current UUID path unchanged.

`updateAutomation`:

- If existing.scope === "project": `scope` in input that differs → throw.
- Definition fields changed (name, prompt, provider, model, preset, hour, trigger, tier) → rewrite that slug in the file, refresh `automationsTrust`.
- `enabled` / `memory` only → overlay only.
- Ensure overlay exists before patch.

`removeAutomation`:

- Project: rewrite file without that slug, drop overlay, refresh hash (empty array hash is still stored if the key remains).
- Private: current path.

`normalizeAutomationInput`: pass through `scope` from existing; on create default `"private"`; reject unknown values.

- [ ] **Step 4: Re-run automations-file + automations tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/automations-file.js electron/services-settings.js electron/test/automations-file.test.js
git commit -m "$(cat <<'EOF'
Write project-scoped automations to solenta.json (#1590)

EOF
)"
```

---

### Task 5: Fire gates, `trustFile`, and `runNow` hash

**Files:**
- Modify: `electron/services-settings.js` (`trustFile`)
- Modify: `electron/automations.js` (`dueAutomations` or its caller; `runNow`; ticker; `gcOrphanOverlays` on tick)
- Modify: `electron/automation-triggers.js` (`pollTriggers`)
- Modify: `electron/services.js` exports if `trustFile` is re-exported
- Test: `electron/test/automations-file.test.js`, `electron/test/automations.test.js`, `electron/test/automation-triggers.test.js`

**Interfaces:**
- Consumes: `mergeAutomations`, `canAutoFire`, `presentAutomationsFile`.
- Produces:
  - `trustFile(store, { projectId, hash })`
  - `runNow(ctx, { id, hash? })` — keep a string `id` overload if existing tests pass a string; prefer object from IPC.
  - Ticker: `gcOrphanOverlays` then `dueAutomations(merge…)` filtered by `canAutoFire`.
  - Poller: iterate merge, skip `!canAutoFire`.

- [ ] **Step 1: Write the failing tests**

Fire gates (new describe in `automations-file.test.js` or `automations.test.js`):

```js
it("untrusted shared is never due", () => {
  const now = Date.now();
  const auto = {
    id: "shared:p1:pr-triage",
    scope: "project",
    enabled: true,
    nextRunAt: now - 1,
  };
  // Build a store+file whose hash !== automationsTrust, enabled true.
  assert.equal(dueAutomations([auto], now).length, 1); // still filters enabled+due
  // canAutoFire is the real gate — assert false, and the ticker uses it.
});
```

Do not change `dueAutomations`’s existing contract (enabled + no trigger + nextRunAt). Put the trust gate in the ticker:

```js
const due = dueAutomations(mergeAutomations(ctx.store, now), now)
  .filter((a) => canAutoFire(ctx.store, a));
```

`trustFile`:

```js
it("trustFile persists a matching hash and rejects a stale one", () => {
  const dir = tempRepo([ROW]);
  const store = new Store(path.join(dir, "store.json"));
  store.setProjects([{ id: "p1", name: "p", path: dir }]);
  const hash = readAutomations(dir).hash;
  assert.throws(() => services.trustFile(store, { projectId: "p1", hash: "a".repeat(64) }), /hash/);
  services.trustFile(store, { projectId: "p1", hash });
  assert.equal(store.getProject("p1").automationsTrust, hash);
});
```

`runNow`:

```js
it("runNow on untrusted shared rejects; hash trusts and fires once without enabling", async () => {
  // create file+overlay enabled:false, no automationsTrust
  // runNow(ctx, { id }) throws /not trusted/
  // runNow(ctx, { id, hash }) starts a run; overlay.enabled stays false
});
```

Reuse the existing `startScheduler` fake-runner pattern in `electron/test/automations.test.js`.

Poller: add a case in `electron/test/automation-triggers.test.js` — enabled shared + untrusted → `fireRun` not called.

Before `runAutomation`, if the id is shared and no store row exists, write a default overlay so `patchAutomation` can stamp `lastRunAt`.

- [ ] **Step 2: Run to verify fail**

Expected: FAIL — `trustFile` missing; ticker still uses `store.getAutomations()`.

- [ ] **Step 3: Implement**

`trustFile(store, { projectId, hash })`:

- `requireProject`.
- `section = readAutomations(project.path)`.
- If `!section.hash` throw `No automations in solenta.json`.
- If `hash !== section.hash` throw `Automations file is not trusted` or `Automations file hash does not match`.
- Set `automationsTrust`, save.

`runNow(ctx, input)`:

```js
const id = typeof input === "string" ? input : String(input && input.id || "");
const hash = typeof input === "object" && input ? input.hash : undefined;
let auto = mergeAutomations(ctx.store, Date.now()).find((a) => a.id === id);
if (!auto) throw new Error(`Unknown automation: ${id}`);
if (auto.scope === "project" && !canAutoFire(ctx.store, { ...auto, enabled: true })) {
  // trusted check only — runNow may run while enabled is false
  const project = ctx.store.getProject(auto.projectId);
  const file = presentAutomationsFile(project);
  if (!file || !file.trusted) {
    if (!hash || hash !== file?.hash) {
      throw new Error("Automations file is not trusted");
    }
    services.trustFile(ctx.store, { projectId: auto.projectId, hash });
  }
}
ensureOverlay(ctx.store, auto);
await runAutomation(ctx, ctx.store.getAutomation(id) || auto, Date.now(), { rethrow: true });
return mergeAutomations(ctx.store, Date.now()).find((a) => a.id === id);
```

Careful: `canAutoFire` requires `enabled`. For the trust check on runNow, compare `file.trusted` / hash only. Enabled is irrelevant for manual run.

Ticker `tick`:

```js
if (gcOrphanOverlays(ctx.store)) ctx.store.save();
const due = dueAutomations(mergeAutomations(ctx.store, now), now)
  .filter((a) => canAutoFire(ctx.store, a));
```

`pollTriggers`: `for (const auto of mergeAutomations(ctx.store, Date.now()))` and `if (!canAutoFire(ctx.store, auto) || !auto.trigger || …) continue`.

Export `trustFile` from `services-settings.js` and `services.js`.

- [ ] **Step 4: Re-run electron automations suites**

```
node --import=./test/support/render.mjs --experimental-strip-types --test \
  electron/test/automations-file.test.js \
  electron/test/automations.test.js \
  electron/test/automation-triggers.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/services-settings.js electron/services.js electron/automations.js electron/automation-triggers.js electron/automations-file.js electron/test
git commit -m "$(cat <<'EOF'
Gate shared automation fires on trust and local enable (#1590)

EOF
)"
```

---

### Task 6: IPC types, channel, and clients

**Files:**
- Modify: `src/shared/ipc.ts` (`AutomationInfo.scope`, `AutomationWrite.scope` + optional `id`, `ProjectInfo.automationsFile`, `automations.trustFile`, `runNow` input)
- Modify: `src/shared/ipcChannels.ts` (add `{ ns: "automations", method: "trustFile" }`)
- Modify: `electron/ipc-runs.js`
- Modify: `electron/preload.js` via `scripts/sync-ipc-preload.js`
- Modify: `src/coder/useCoderWorkflows.ts` (`runAutomationNow(id, hash?)`, `trustAutomationsFile`)
- Modify: `src/useCoder.ts` (surface the new action)
- Modify: `test/support/fakeCoder.ts` (`trustFile` stub)
- Modify: `src/dev/automations.ts` (in-memory trust + scope; file write is best-effort against `project.path` if present)

**Interfaces:**
- Consumes: Task 5 functions.
- Produces: renderer can call `api.automations.trustFile` and `runNow({ id, hash })`.

- [ ] **Step 1: Write the failing type / wiring check**

Add `scope?: "private" | "project"` on `AutomationInfo` (required on listed rows — use `scope: "private" | "project"` required, migrate in store). Prefer required on `AutomationInfo` and optional on `AutomationWrite`.

```ts
export type AutomationScope = "private" | "project";

// AutomationInfo
scope: AutomationScope;

// AutomationWrite
scope?: AutomationScope;
id?: string; // slug, project-scope create only

// ProjectInfo
automationsFile?: {
  hash: string;
  trusted: boolean;
  error?: string;
  count: number;
};

// CoderApi.automations
trustFile(input: { projectId: string; hash: string }): Promise<void>;
runNow(input: { id: string; hash?: string }): Promise<AutomationInfo>;
```

Add the ipcChannels row. Do **not** hand-edit preload; run the sync script.

Add a small electron IPC test only if this repo already tests handler names; otherwise the typecheck lock (`IPC_CHANNEL_LOCK`) is the failing test.

- [ ] **Step 2: Run typecheck to see it fail**

Run: `npm run typecheck`

Expected: FAIL — `trustFile` missing on fakeCoder / devCoder / preload lock.

- [ ] **Step 3: Implement**

`electron/ipc-runs.js`:

```js
"automations:trustFile": async (ctx, input) => {
  services.trustFile(ctx.store, input);
},
"automations:runNow": async (ctx, input) => {
  return automations.runNow(ctx, input);
},
```

`node --experimental-strip-types scripts/sync-ipc-preload.js`

`fakeCoder.ts`: `trustFile: (input) => rec("automations.trustFile", [input], undefined)`

`useCoderWorkflows.ts`:

```ts
const runAutomationNow = useCallback(
  async (automationId: string, hash?: string) => {
    try {
      return await api.automations.runNow({
        id: automationId,
        ...(hash ? { hash } : {}),
      });
    } finally {
      await refreshAutomations();
    }
  },
  [api, refreshAutomations],
);

const trustAutomationsFile = useCallback(
  async (projectId: string, hash: string) => {
    await api.automations.trustFile({ projectId, hash });
    await api.projects.list().then(/* caller refreshes projects */);
  },
  [api],
);
```

Thread `trustAutomationsFile` through `useCoder` the same way `runAutomationNow` is threaded. After trust, also refresh projects (the hook that already calls `api.projects.list()`).

`src/dev/automations.ts`: keep an in-memory `trustByProject: Record<string, string>`. `add` with `scope: "project"` uses `shared:${projectId}:${slug}` ids and sets trust. If `project.path` exists, write `solenta.json` the same way as main (optional for the harness; at minimum honor scope/trust in memory so the UI can be exercised). `trustFile` sets the map. `list` sets `enabled` defaults as spec’d.

- [ ] **Step 4: `npm run typecheck` and renderer automations tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc.ts src/shared/ipcChannels.ts electron/preload.js electron/ipc-runs.js src/coder/useCoderWorkflows.ts src/useCoder.ts src/dev/automations.ts test/support/fakeCoder.ts
git commit -m "$(cat <<'EOF'
Expose automations.trustFile over IPC (#1590)

EOF
)"
```

---

### Task 7: Automations UI

**Files:**
- Modify: `src/components/AutomationsView.tsx`
- Modify: `src/components/AutomationsView.module.css` (badge + approve card; reuse existing permission-card classes if they are already global, otherwise copy the ThreadView approve-card structure into this module)
- Modify: `src/App.tsx` (pass `trustFile` / `hash` into the view if not already via props)
- Test: `test/automationsView.test.tsx`

**Interfaces:**
- Consumes: `AutomationInfo.scope`, `ProjectInfo.automationsFile`, `onTrustFile`, `onRunNow(id, hash?)`.
- Produces: Scope select, Private/Project badge, “run on this machine” copy, approve card, write note.

- [ ] **Step 1: Write the failing renderer tests**

In `test/automationsView.test.tsx`:

```tsx
it("create form has a Scope select; Project is disabled for a remote project", async () => {
  const m = await mount(
    <AutomationsView
      automations={[]}
      projects={[p1, { ...p1, id: "p2", slug: "acme/ssh", remoteHost: "h", path: "/tmp/ssh" }]}
      providers={providers}
      onCreate={async () => {}}
      onUpdate={async () => {}}
      onRemove={async () => {}}
      onRunNow={async () => {}}
    />,
  );
  assert.ok(m.el.querySelector("[data-automation-scope]"));
  // select p2 → Project option disabled
});

it("badges a project row and labels the toggle run-on-this-machine", async () => {
  const m = await mount(
    <AutomationsView
      automations={[auto({ id: "shared:p1:pr-triage", scope: "project", name: "PR triage" })]}
      projects={[p1]}
      providers={providers}
      onCreate={async () => {}}
      onUpdate={async () => {}}
      onRemove={async () => {}}
      onRunNow={async () => {}}
    />,
  );
  assert.match(m.el.textContent || "", /Project/);
  const toggle = m.el.querySelector("[data-automation-toggle]");
  assert.match(toggle.getAttribute("aria-label") || "", /this machine/i);
});

it("shows one approve card per untrusted project and calls onTrustFile", async () => {
  let trusted = null;
  const m = await mount(
    <AutomationsView
      automations={[auto({ id: "shared:p1:pr-triage", scope: "project" })]}
      projects={[{
        ...p1,
        automationsFile: { hash: "a".repeat(64), trusted: false, count: 1 },
      }]}
      providers={providers}
      onCreate={async () => {}}
      onUpdate={async () => {}}
      onRemove={async () => {}}
      onRunNow={async () => {}}
      onTrustFile={async (projectId, hash) => {
        trusted = { projectId, hash };
      }}
    />,
  );
  assert.ok(m.el.querySelector("[data-automations-approve]"));
  assert.match(m.el.textContent || "", /solenta\.json/);
  await inAct(() => {
    m.el.querySelector("[data-automations-approve-run]").click();
  });
  assert.deepEqual(trusted, { projectId: "p1", hash: "a".repeat(64) });
});

it("after a project-scope create, shows the write-and-commit note", async () => {
  const m = await mount(
    <AutomationsView
      automations={[]}
      projects={[p1]}
      providers={providers}
      onCreate={async () => {}}
      onUpdate={async () => {}}
      onRemove={async () => {}}
      onRunNow={async () => {}}
    />,
  );
  // fill name/prompt, set scope project, submit
  // assert data-automation-wrote=""
});
```

`auto()` helper must set `scope: over.scope ?? "private"`.

Untrusted enable/Run now: toggle disabled; Run now calls `onRunNow(id, hash)` (approve-and-run). Trusted Run now calls `onRunNow(id)`.

- [ ] **Step 2: Run renderer test to verify fail**

Run: `CODER_GROK_MCP_DISABLE=1 node --import=./test/support/render.mjs --experimental-strip-types --test --test-timeout=20000 test/automationsView.test.tsx`

Expected: FAIL — no `data-automation-scope`.

- [ ] **Step 3: Implement the view**

- State: `scope: "private" | "project"`, default `"private"`.
- Select `data-automation-scope`. Disable Project when `projectById.get(projectId)` has `remoteHost` or no `path`.
- Pass `scope` on create. Do not send `scope` on update.
- After successful project-scope create/update-of-definition, set a `wroteFile` note: “Wrote solenta.json — commit it to share.” `data-automation-wrote=""`.
- Row: `<span data-automation-scope-badge="">Private|Project</span>`.
- Toggle aria-label: project → “Run on this machine” / “Stop running on this machine”; private stays Enable/Disable. Disable the toggle when `project.automationsFile && !project.automationsFile.trusted`.
- Approve card per project in `projects` where `automationsFile && (automationsFile.error || !automationsFile.trusted)` and `count > 0` (or error). Copy from the spec. Buttons: `data-automations-approve-run` → `onTrustFile(projectId, hash)`; cancel hides the card for this session only (local React state).
- Run now on untrusted project row: `onRunNow(auto.id, project.automationsFile.hash)`.

Wire `onTrustFile` from `App.tsx` / the automations screen props. After trust, refresh projects + automations.

- [ ] **Step 4: Re-run renderer automations tests + typecheck**

```
CODER_GROK_MCP_DISABLE=1 node --import=./test/support/render.mjs --experimental-strip-types --test --test-timeout=20000 \
  test/automationsView.test.tsx test/automationsCreateWiring.test.tsx
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/AutomationsView.tsx src/components/AutomationsView.module.css src/App.tsx test/automationsView.test.tsx
git commit -m "$(cat <<'EOF'
Add private vs project scope to the Automations UI (#1590)

EOF
)"
```

---

### Task 8: Final regression sweep

**Files:** none new. Re-run the suites this plan touched.

- [ ] **Step 1: Electron**

```
node --import=./test/support/render.mjs --experimental-strip-types --test \
  electron/test/automations-file.test.js \
  electron/test/automations.test.js \
  electron/test/automation-triggers.test.js \
  electron/test/store.test.js \
  electron/test/project-setup-h3.test.js
```

Expected: PASS.

- [ ] **Step 2: Renderer + types**

```
CODER_GROK_MCP_DISABLE=1 node --import=./test/support/render.mjs --experimental-strip-types --test --test-timeout=20000 \
  test/automationsView.test.tsx test/automationsCreateWiring.test.tsx test/automations.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit only if the sweep forced a fix.** Otherwise stop. Do not file a drive-by cleanup commit.

---

## Self-review (plan vs spec)

| Spec section | Task |
|---|---|
| File shape, hash, MAX_BYTES, automations-only file | Task 1 |
| `automationsTrust` migrate | Task 2 |
| `scope`, merge, overlay defaults, orphan GC | Task 3 |
| Writes, auto-trust writer, remote reject, no clobber | Task 4 |
| Fire gates, trustFile, runNow hash, approve-and-run does not enable | Task 5 |
| IPC + clients | Task 6 |
| UI | Task 7 |
| Out of scope (webhooks, NL, convert, shared memory, auto-commit, SSH) | nowhere — do not add |

No TBD. `projects:changed` from the spec is implemented as `api.projects.list()` refresh (no such push exists).
