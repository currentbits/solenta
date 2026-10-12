# Automation permission scopes (private vs project-shared)

Issue #1590, split from #242. Automations live in the local Electron store
today, so every automation is private to this machine. This spec adds a
`scope` field and a committed shared home, trust-gated like `solenta.json`
commands.

## Decision (user, 2026-10-11)

**Local opt-in runner.** The committed file is the definition. Auto-fire
only on machines that opt in. The creator opts in automatically. **Run now**
works on any machine that has trusted the current file hash. Runtime state
stays local. There is no named owner and no every-machine fire.

Rejected: every trusted machine fires (N teammates = N agent runs per GitHub
event). Rejected: a single named owner in the file (offline owner = silence;
changing owner needs a commit).

## What is actually true today

- `AutomationInfo` (`src/shared/ipc.ts`) has no `scope`. Writes go through
  `electron/services-settings.js` `addAutomation` / `updateAutomation` into
  `store.getAutomations()`.
- The minute ticker (`electron/automations.js` `startScheduler`) and the
  GitHub poller (`electron/automation-triggers.js` `pollTriggers`) both
  iterate `store.getAutomations()` and fire when `enabled` is true.
- GitHub events are local REST polls, not webhooks. There is no coordinator.
  A shared definition that auto-fired on every machine would duplicate runs.
- `solenta.json` (`electron/repoConfig.js`) is the committed project file.
  Commands (`setup`, `quickActions`, `onSettle`) run only after the user
  approves a sha256 stored as `project.repoConfigTrust`. Editing the file
  re-prompts.
- `.solenta/` is gitignored agent scratch (`.gitignore`). A file there would
  never reach teammates. Shared automations therefore live in `solenta.json`,
  not `.solenta/automations`.

## Design

### 1. File shape

`solenta.json` gains an optional `automations` array. Unknown keys stay
ignored, as today. Example:

```json
{
  "setup": "npm ci",
  "automations": [
    {
      "id": "pr-triage",
      "name": "PR triage",
      "prompt": "Triage the new pull request.",
      "provider": "claude",
      "model": null,
      "preset": "hourly",
      "hour": null,
      "trigger": { "type": "github", "event": "pr_opened" },
      "tier": null
    }
  ]
}
```

Definition fields only (never runtime):

| Field | Rule |
|---|---|
| `id` | Required slug: `^[a-z][a-z0-9-]{0,47}$`. Unique inside the file. |
| `name` | Non-empty, trimmed. Same required-name rule as private automations. |
| `prompt` | Non-empty. Cap 4000 characters (same as automation memory). |
| `provider` | Known provider id. |
| `model` | String or `null`. |
| `preset` | `hourly` \| `daily` \| `weekly`. Ignored when `trigger` is set, but still required so the row round-trips the existing writer. |
| `hour` | `0–23` for daily/weekly; `null` for hourly. |
| `trigger` | Absent/`null` = schedule. Else the existing `AutomationTrigger` object. |
| `tier` | Absent/`null` or `auto` \| `fast` \| `balanced` \| `strong`. |

Not in the file: `enabled`, `lastRunAt`, `nextRunAt`, `lastError`,
`consecutiveFailures`, `pendingRunThreadId`, `triggerCursor`, `memory`,
`projectId`. `projectId` is the project whose checkout contains the file.

Limits: at most **16** automations. `solenta.json` `MAX_BYTES` rises from
64 KB to **256 KB** so 16 × 4000-character prompts fit. One bad automation
row fails the **automations section only** (empty list + `error` string).
Commands still parse. Same “never a partial list” rule as `quickActions`.

Hash: one sha256 of the canonical array (file order) of those nine
fields per row. Independent of `commandsHash`. Approving `npm test` does
not approve a new agent prompt.

A file that contains only `automations` (no `setup` / `quickActions` /
`onSettle`) is valid. Today `parseRepoConfig` returns `null` when no
commands exist; that early return must not hide an automations-only file.
Commands presentation stays null; `automationsFile` is still filled.

### 2. Trust, stored on the project

New persisted field on the project, sibling of `repoConfigTrust`:

- `automationsTrust`: sha256 hex of the current automations section, or
  absent.

`normalizeTrustHash` already in `repoConfig.js` validates the shape.
`store-migrate.js` `migrateProject` drops a non-hex value the same way it
drops a bad `repoConfigTrust`.

A project is automations-trusted when
`project.automationsTrust === automationsHash(file)`. Editing the array
invalidates every teammate. The writer’s machine auto-trusts the new hash
(they just authored it).

`ProjectInfo` gains a derived, never-persisted block:

```ts
automationsFile?: {
  hash: string;
  trusted: boolean;
  error?: string;
  count: number;
};
```

Remote (`remoteHost`) and pathless projects: no file, no block. Same as
`repoConfigFor`.

### 3. `scope` on `AutomationInfo`

```ts
scope: "private" | "project";
```

Missing `scope` migrates to `"private"`. `AutomationWrite` accepts optional
`scope` and, for project scope on create, optional `id` (the slug). If
omitted on create, the slug is derived from the name
(`pr-triage` from `"PR triage"`) and de-duplicated with `-2`, `-3`, … inside
that file. A derived slug that fails the regex becomes `auto`, then
`auto-2`, …

Internal id for a shared row is `shared:<projectId>:<slug>`. Private rows
keep UUIDs. A private create whose id would start with `shared:` is rejected.

`listAutomations` returns the merge:

1. Every store row with `scope !== "project"` (private).
2. For each local project, parse `solenta.json` automations. For each slug,
   overlay the store row `shared:<projectId>:<slug>` if present, else
   defaults: `enabled: false`, empty runtime, empty memory, `triggerCursor: null`,
   `nextRunAt` from `nextFire` at list time (not persisted until the user
   enables or runs).
3. Definition fields always come from the file. Store copies of name/prompt/…
   on a shared id are overwritten on list and are not a source of truth.
4. Store overlays whose slug is gone from the file never appear in the
   list. Orphan GC runs on add/update/remove and on the scheduler tick
   (not as a surprise save from `list`).

`enabled` means **auto-fire on this machine** for both scopes. It is never
written to `solenta.json`.

| | Private | Project, this machine created it | Project, teammate just pulled |
|---|---|---|---|
| `scope` | `private` | `project` | `project` |
| `enabled` default | `true` (today) | `true` | `false` |
| Trusted | n/a | yes (writer auto-trusts) | no, until they approve |

### 4. Who may fire

The ticker and the GitHub poller iterate the **merged** list, not raw
`store.getAutomations()`.

A row may auto-fire only when:

- `enabled === true`, and
- if `scope === "project"`, the project’s `automationsTrust` matches the
  current file hash.

Untrusted shared rows are listed and are readable. They never enter
`dueAutomations`. `pollTriggers` skips them. `runNow` on an untrusted shared
row rejects with a distinct error (`Automations file is not trusted`) unless
the caller passes `hash` equal to the current file hash (approve-and-run).
That persists `automationsTrust` like `runCommand` + `trustRepoConfig`, then
fires. It does not flip `enabled`; approve-and-run is one manual fire.

Private `runNow` is unchanged.

Circuit breaker (`enabled=false` after 3 failures) still writes the overlay
only. It does not edit `solenta.json`. Re-enable is the existing UI toggle.

### 5. Writes

`add` / `update` / `remove` with `scope: "project"`:

- Reject when the project has `remoteHost` or no local `path`.
- Read `solenta.json` (create `{ automations: [] }` if missing).
- Refuse if the file exists but is not valid JSON (do not clobber).
- Patch only the `automations` key. Preserve `setup`, `quickActions`,
  `onSettle`, and unknown keys.
- Write `JSON.stringify(doc, null, 2) + "\n"` to `<project.path>/solenta.json`.
- Invalidate the `repoConfig.js` read cache.
- Persist `automationsTrust` = the new hash on this project.
- Persist/update the overlay row (`enabled` included).
- `add` with project scope sets `enabled: true` unless the write explicitly
  passes `enabled: false`.
- `update` of definition fields on a shared row writes the file. `update` of
  `enabled` / `memory` only touches the overlay.
- `remove` of a shared row deletes that slug from the file and drops the
  overlay. Other slugs stay.

The app does **not** commit. The Automations UI says the file was written
and still needs a commit to reach teammates.

`scope` cannot change on `update`. Convert private ↔ project is out of
scope (a later “Share with project” can add it). Create as one or the other.

### 6. UI (`AutomationsView`)

- Create form: a **Scope** select, `Private (this machine)` / `Project
  (solenta.json)`. Project is disabled when the chosen project is remote
  or has no path.
- Saving a project automation shows a one-line note: “Wrote solenta.json —
  commit it to share.”
- Each row badges `Private` or `Project`.
- The existing enable toggle on a project row is “run on this machine.”
- When `projects` include any `automationsFile` that is untrusted or has
  `error`, the view shows one approve card per such project (not per row),
  copy parallel to the `solenta.json` command card in `ThreadView`:

  > Run automations from this repo’s solenta.json?
  > These come from a checked-in file, so anyone who can push to the repo
  > can change them. You will be asked again if they change.

  Approve calls `automations.trustFile({ projectId, hash })`. Cancel leaves
  them listed and disabled for auto-fire.
- Edit form for a project row can change definition fields (writes the
  file) and memory / enabled (overlay). Project cannot be changed (already
  true for private).
- Untrusted project rows: definition is visible; enable and Run now wait
  on the approve card (Run now can be the approve-and-run action).

### 7. IPC

`AutomationInfo` and `AutomationWrite` gain `scope?: "private" | "project"`.
`AutomationWrite` on create may include `id` when `scope === "project"`
(the slug). Listed shared rows always have `scope: "project"` and the
`shared:<projectId>:<slug>` id.

New method:

```ts
automations.trustFile(input: { projectId: string; hash: string }): Promise<void>
```

Rejects an unknown project, a hash that is not the current file hash, or a
project with no automations section. On success stores `automationsTrust`
and broadcasts `projects:changed`.

`runNow` input becomes `{ id: string; hash?: string }`. `hash` is ignored
for private rows. For project rows it is the approve-and-run path above.

`ProjectInfo.automationsFile` is filled in `listProjects` next to
`presentRepoConfig`.

Dev coder (`src/dev/automations.ts`, `src/devCoder.ts`) implements the same
merge and trust so the web harness stays honest.

### 8. Error handling

| Case | Behavior |
|---|---|
| Missing `solenta.json` | No shared rows. Private list unchanged. |
| Invalid JSON | Commands error (today). Automations section error. No shared rows. No write. |
| Bad automations array | Commands still load. `automationsFile.error` set. No shared rows. |
| Duplicate / bad slug | Automations section error (no partial list). |
| Provider in file not installed | Row lists. Fire / runNow fails with the existing unknown-provider error. |
| File hash changed since overlay existed | `trusted: false`. Overlay `enabled` is kept but ignored until re-trust. |
| SSH / remote project | No file read, no project-scope write. |

### 9. Out of scope

- Inbound webhook relay / a cloud single-owner (#1588).
- Natural-language authoring (#1589).
- Converting an existing private automation into a shared one.
- Sharing `memory` / `triggerCursor` across machines.
- Auto-commit or a git prompt after write.
- SSH remote checkouts.

## Testing

Electron (`electron/test/`):

- `repoConfig` parse: automations present, hash independent of commands,
  one bad row fails only the automations section, 17th row errors, slug
  / prompt-cap / duplicate-id errors, `MAX_BYTES` 256 KB.
- Merge: private + shared; overlay `enabled` / cursor / memory survive a
  definition edit; orphan overlay GC; missing scope → private.
- Fire gates: untrusted shared never due and never polled; trusted +
  `enabled: false` never fires; trusted + `enabled: true` does; private
  unchanged.
- Writes: add project-scope creates/patches `solenta.json`, auto-trusts,
  `enabled: true`; teammate overlay defaults `enabled: false`; update
  memory does not rewrite definition; remove drops the slug; refuse write
  on invalid JSON; remote project rejected.
- `trustFile`: matching hash persists; stale hash rejected.
- `runNow` untrusted rejects; approve-and-run trusts and fires.
- `migrateProject` drops a non-hex `automationsTrust`.

Renderer (`test/automationsView.test.tsx` and create-wiring):

- Scope select; project badge; approve card copy and action; enable label
  on a project row; write-note after a project save.

## Files

- `electron/repoConfig.js` — parse automations, separate hash, raise
  `MAX_BYTES`, present `automationsFile`.
- `electron/automations-file.js` (new, if repoConfig would grow past one
  job) — read/write the automations key, slug helpers, overlay merge.
- `electron/services-settings.js` — `list` / `add` / `update` / `remove` /
  `trustFile`.
- `electron/automations.js` + `electron/automation-triggers.js` — merged
  list + trust gate on tick and poll.
- `electron/store-migrate.js` — `scope` default, `automationsTrust`.
- `src/shared/ipc.ts` — types + `trustFile`.
- `src/components/AutomationsView.tsx` — scope, badge, approve card.
- `src/dev/automations.ts` — same semantics for the harness.
- Tests listed above.

No new dependency. No schema change to memory-server.
