# Governance layer v1

Issue #262. This spec is the **v1 slice only**: a declarative per-profile
permission matrix, harness-level evaluation on Claude `can_use_tool`, an
HMAC-chained audit log, and Settings UI. Seatbelt OS sandbox is #803.
gh-aw safe-outputs is #804. Neither is in this slice.

Decided on thread `36cfee86-4dc4-4d12-8917-2c1f5568a4bc` (2026-09-02):

- Slice: matrix + harness gate + HMAC audit + profile UI
- Binding: `AgentProfile.policy` + persist `thread.agentProfileId`
- Evaluator: auto-allow, deny-wins severity collect, HMAC chain
- UI: rule rows on the existing profile form; compact audit on Advanced
- Tests: unit + fake-Claude seam + store heal + Settings/permission-card;
  no live Claude binary

## Why

`#190` profiles are presets (provider, model, effort, permission mode).
`#409` `classifyTool` is a global hardcoded floor on Claude `can_use_tool`
(protected writes, secrets, `sudo`, force-push, egress). `electron/sandbox.js`
only reports flags; only Codex is actually confined. Applying a profile does
not remember which profile the thread is using.

V1 makes policy authorable per profile, enforced in the harness (never in
prompts), and recorded by the thing that decided.

## Non-goals

- macOS Seatbelt / Linux seccomp (#803)
- Safe-outputs mutation proxy (#804)
- Writing a profile rule from the permission card
- Confining Kimi, Grok `--always-approve`, Cursor `--force`, or any CLI
  that never raises `can_use_tool`
- Changing the sandbox badge (it stays honest: reporting, not this gate)
- Repo-checked-in policy files (a repo must not grant itself privilege)
- Natural-language policy compile

## Current seams

- `electron/guardrails.js` `classifyTool({ toolName, input, worktreePath })`
  → `{ decision: "allow"|"ask"|"deny", rule, reason }`. Fail-open on its
  own exceptions. `CODER_GUARDRAILS=off` disables it.
- `electron/runner.js` Claude `control_request` / `can_use_tool`: deny is
  answered without a card; ask annotates `PendingPermissionInfo.guardrail`.
- `electron/workflow.js` auto-denies every workflow-agent prompt (unchanged).
- `electron/permissionCommand.js` already strips env prefixes for edit-before-approve.
- Composer `pickProfile` calls `setProvider` → `setReasoningEffort` →
  `setPermissionMode` and stores no profile id.

## Data model

```ts
type GovernanceAction = "block" | "deny" | "ask" | "allow";

interface GovernanceRule {
  kind: "tool" | "bash" | "write" | "network";
  match: string; // glob, 1–200 chars after trim
  action: GovernanceAction;
}

interface GovernancePolicy {
  defaultAction: "ask" | "allow";
  rules: GovernanceRule[];
}

interface AgentProfile {
  id: string;
  name: string;
  provider: string;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  permissionMode: PermissionMode;
  policy?: GovernancePolicy; // absent = empty rules + defaultAction "ask"
}

interface ThreadInfo {
  // existing fields…
  agentProfileId?: string | null;
}
```

`block` and `deny` both auto-respond deny. `block` is the Factory floor
(“never, not a prompt”). Attribution differs (`profile.block` vs
`profile.deny`). `allow` skips the permission card.

Empty / absent policy is today’s behavior: `#409` then ask.

### Store heal

`parseAgentProfile` keeps a well-formed `policy`. Missing `policy` stays
absent. Junk `policy` (wrong types, unknown action/kind, empty match)
heals to absent on disk read and throws on `settings.set` (same split as
today’s profiles: `normalizeAgentProfiles` never throws, `validateAgentProfiles`
does). Cap 40 rules per profile. `thread.agentProfileId` unknown or deleted
is treated as null at evaluate time, not as a store error.

Checked-in project files cannot write `agentProfiles`. Settings stay user-scope.

## Binding

New `threads.applyAgentProfile({ threadId, profileId })`:

1. Load the profile or throw `"Unknown agent profile"`.
2. One store write: provider, model, reasoning effort, permission mode
   (snapped to what the provider honours, same as today’s three calls),
   and `agentProfileId`.
3. Return the updated `ThreadInfo`.

Composer `pickProfile` uses this instead of the three calls.

`threads.setProvider`, `setReasoningEffort`, and `setPermissionMode` clear
`agentProfileId` (the user left the profile). `applyAgentProfile` must not
go through those public handlers in a way that clears the id it just set.

Fork (`services.forkThread` / user forks) copies `agentProfileId` only
when that id still exists **and** the fork’s provider equals the
profile’s provider. Worker-pool forks that change provider leave
`agentProfileId` null (built-ins only). Planboard create with
`agentProfileId` applies the profile the same way `applyAgentProfile`
does (full snapshot, not an id stamp on the wrong provider).

The composer picker treats `thread.agentProfileId` as the selected profile
when it matches a saved id.

## Normalize

One function, used by matcher, approval hash, audit `actionHash`, and
edit-before-approve re-check.

- Tool name: trim, Unicode NFKC, lowercase.
- Command: strip invisible Unicode (same class as `#409` `injection.hiddenchars`),
  collapse whitespace, strip leading `FOO=1` env assignments (reuse
  `permissionCommand.js`), NFKC. Empty after strip → no command.
- Path: expand `~`, resolve against `worktreePath` or cwd, convert to
  POSIX with a leading slash. `fs.realpathSync` when the path exists;
  if realpath throws, **deny** (`layer: normalize`). Never fail open.
- Network host: lowercase hostname from `url` / `uri` / `href` tool fields,
  and from `https://` / `http://` tokens in the normalized command.

`actionHash` is SHA-256 of a stable JSON object
`{ tool, command, path, hosts }` after normalize (sorted host list).
The same spelling always hashes the same; a different canonical form is
a new decision.

## Evaluator

`electron/governance.js`:

```ts
evaluate(input: {
  toolName: string;
  rawInput: unknown;
  worktreePath: string | null;
  policy: GovernancePolicy | null;
  builtin: { decision: "allow"|"ask"|"deny"; rule: string | null; reason: string };
  sessionAllows: ReadonlySet<string>; // actionHashes granted this run
}): {
  decision: "allow" | "ask" | "deny";
  layer:
    | "builtin"
    | "normalize"
    | "profile.block"
    | "profile.deny"
    | "profile.ask"
    | "profile.allow"
    | "profile.default"
    | "session";
  rule: string | null;
  reason: string;
  actionHash: string;
  declared: { tool: string; command: string | null; path: string | null; hosts: string[] };
}
```

Skip the matrix (fall through to `#409` only) for `AskUserQuestion` and
`ExitPlanMode`.

### Matching

Globs are case-insensitive `*` / `?` only (not JS regex). A rule matches when:

- `tool` — glob vs normalized tool name
- `bash` — glob vs normalized command; ignored when there is no command
- `write` — glob vs normalized path; only `WRITE_TOOLS` from `guardrails.js`
  (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `str_replace_editor`,
  `apply_patch`)
- `network` — glob vs any extracted host

Collect every matching rule. First severity that has a match wins:
`block` → `deny` → `ask` → `allow`. Not first-glob-wins.

### Precedence

1. Normalize failure → deny, `layer: normalize`
2. `#409` deny → deny, `layer: builtin` (profile cannot lift)
3. Profile `block` → deny, `layer: profile.block`
4. Profile `deny` → deny, `layer: profile.deny`
5. Profile `ask` → ask, `layer: profile.ask`
6. Session grant (canonical `actionHash` in `sessionAllows`) → allow,
   `layer: session`
7. Profile `allow` → allow, `layer: profile.allow`
8. `#409` ask → ask, `layer: builtin`
9. `policy.defaultAction` (`ask` when policy absent), `layer: profile.default`

`CODER_GUARDRAILS=off` disables step 2 and 8 only. The user matrix stays on.

## Runner seam

Same Claude `can_use_tool` path as `#409` (`electron/runner.js`).

1. `classifyTool` (existing, still fail-open on throw).
2. Resolve policy from `thread.agentProfileId` → settings profile →
   `policy` or null.
3. `evaluate(...)`.
4. **deny** → `handle.respond` deny, transcript event
   `Governance blocked ${tool}: ${layer}: ${rule}: ${reason}`, audit
   append, no card.
5. **allow** → `handle.respond` allow with the original input, audit
   append (`executed` = `declared`), no card.
6. **ask** → existing pending-permission card. Attach
   `guardrail: { rule, reason, layer }`.

`respondPermission`:

- Re-normalize the executed input (`updatedCommand` when present).
- Re-run `evaluate`. If deny (block/deny/normalize/builtin), refuse the
  allow: respond deny, audit, throw or return a user-visible error
  `"Blocked by policy (${layer})"`.
- If the executed `actionHash` differs from the prompt’s hash, this is a
  new decision. Do not treat the click as covering the new hash if
  evaluate now denies.
- `allowAlways` adds the executed `actionHash` to this run’s
  `sessionAllows` only when evaluate’s layer is not `profile.ask` and
  not a deny. Claude `addRules` still fires as today; it does not skip
  this gate on the next `can_use_tool`.

Non-Claude providers: do not invent `can_use_tool`. Do not write fake
deny records. The matrix is stored and shown; it is not enforced.

## Audit

`electron/governanceAudit.js`. JSONL under userData
(`governance-audit.jsonl`, mode `0600`). Key file
`governance-audit.key` (32 random bytes, `0600`), created once.

Writer is this module, called only from the evaluator/runner in main.
The renderer and the agent cannot append.

Envelope (all of these sit inside the HMAC, including `layer`):

```ts
interface GovernanceAuditEntry {
  v: 1;
  seq: number;          // 1-based
  ts: number;           // epoch ms
  prev: string;         // hex HMAC of previous entry, or 64 zeros
  threadId: string;
  profileId: string | null;
  provider: string;
  toolName: string;
  actionHash: string;
  declared: { tool: string; command: string | null; path: string | null; hosts: string[] };
  executed: { tool: string; command: string | null; path: string | null; hosts: string[] } | null;
  decision: "allow" | "ask" | "deny";
  layer: string;
  rule: string | null;
  reason: string;
}
```

HMAC is **outside** the signed object (a field the signer cannot put
inside the JSON it hashes):

`hmac = HMAC-SHA256(key, canonicalJSON(entry) + "\n" + prev)`

`canonicalJSON` is sorted-key JSON, no whitespace. Disk line is
`{ ...entry, hmac }`. The renderer list DTO strips `hmac` and `prev`.

A deny record is written only when this layer actually denied. An ask
record is written when the card is shown. An allow record is written
when the CLI is told allow (auto or after a passing re-check). For
auto-allow, `executed` equals `declared`. For card-then-allow, the ask
row has `executed: null`; the later allow row has both.

Secrets: run `scanSecrets` on command/path strings before persist;
replace hits with the existing redact form. Truncate command/path to
500 chars.

Verify walks the file and checks each HMAC and `prev` link. First
failure returns `{ ok: false, seq, reason }`. Missing key after entries
exist is `{ ok: false, reason: "missing key" }`, not a rewrite.

In-memory ring of the last 50 entries for the Settings list (same cap
idea as `secrets.js`). Disk is append-only; do not rewrite history.

Audit write failure: main-process warning. **Do not skip a deny.**
Allow/ask still proceed if the disk write fails.

## IPC

Add to the channel table (`src/shared/ipcChannels.ts`), `CoderApi`
(`src/shared/ipc.ts`), `electron/ipc.js`, then
`node --experimental-strip-types scripts/sync-ipc-preload.js`.
Hand-update `src/devCoder.ts` and `test/support/fakeCoder.ts`
(do not generate them from the table — #623).

```
threads.applyAgentProfile
governance.listAudit
governance.verifyAudit
```

```ts
governance: {
  listAudit(input?: { threadId?: string; limit?: number }): Promise<GovernanceAuditEntry[]>;
  verifyAudit(): Promise<{ ok: true } | { ok: false; seq?: number; reason: string }>;
}
```

`listAudit` newest-first, default limit 50, max 50. No raw HMAC or key
in the renderer payload (`prev` may be omitted on the list DTO).

Extend `PendingPermissionInfo.guardrail`:

```ts
guardrail?: { rule: string | null; reason: string; layer?: string } | null;
```

## UI

### Profile form (Settings → Agents)

Below permission mode:

- Default action select: Ask / Allow (default Ask)
- Four lists — Tools, Bash, Write paths, Network — each row is `match`
  input + action select (`block` / `deny` / `ask` / `allow`) + remove
- Add-row button per list
- Note: “Built-in Solenta guardrails still apply and cannot be lifted.
  Only Claude’s permission hook is gated until OS sandbox (#803).”

`profileSummary` appends ` · N rules` when `policy.rules.length > 0`.

### Permission card

Reuse the `#409` strip. Show `reason (layer / rule)`. Hide **Allow
always** when `layer` is `profile.ask` (a session grant cannot mute
always-confirm). Auto-deny remains a transcript event, with layer in
the text.

### Advanced

Read-only last 50: time, thread id (short), tool, decision, layer.
**Verify chain** calls `governance.verifyAudit` and shows ok / first
bad seq. No new Settings pane. Sandbox badge unchanged.

## Error handling

| Case | Behavior |
| --- | --- |
| Path realpath throws | deny, `layer: normalize` |
| `#409` `classifyTool` throws | treat builtin as allow (existing fail-open); matrix still runs |
| Audit write throws | log; still deny if evaluate denied |
| HMAC key missing, file empty | create key |
| HMAC key missing, file non-empty | verify fails; do not rotate in place |
| Unknown `applyAgentProfile` id | throw; no partial provider switch |
| Unknown `thread.agentProfileId` at evaluate | policy = null |
| `CODER_GUARDRAILS=off` | builtin off; matrix on |
| Non-Claude `can_use_tool` absence | no enforcement, no fake audit denies |

## Tests

- `electron/test/governance.test.js` — normalize (Unicode, whitespace,
  env prefix); glob match; precedence table; fail-closed path;
  `AskUserQuestion` / `ExitPlanMode` skip; session grant ignored under
  `profile.ask`.
- `electron/test/governance-audit.test.js` — chain verifies; bit-flip
  and layer-tamper fail verify; envelope includes `decision`, `layer`,
  `actionHash`.
- `electron/test/governance-runner.test.js` — fake Claude seam (clone
  `guardrails-runner.test.js`): profile deny auto-answers; profile allow
  skips the card; Allow on an edited command that now matches `block`
  is refused; session grant ignored when the profile says `ask`.
- Store: valid `policy` survives heal; junk rules drop on read; strict
  validate throws; `agentProfileId` heal.
- `test/settingsModal.test.tsx` — add a bash deny row, save patch
  includes it; Advanced shows an audit row and Verify.
- `test/permissionPrompt.test.tsx` — layer strip; Allow always hidden
  on `profile.ask`.
- IPC_CHANNEL_LOCK / preload `--check` for the three new methods.
- Register the new electron tests in `scripts/test-electron.js`.

No live Claude binary. No Seatbelt tests.

## Files

Create:

- `electron/governance.js`
- `electron/governanceAudit.js`
- `electron/test/governance.test.js`
- `electron/test/governance-audit.test.js`
- `electron/test/governance-runner.test.js`

Modify:

- `electron/runner.js` — compose evaluate on `can_use_tool` and re-check
  in `respondPermission`
- `electron/store.js` — `policy` on profiles; `agentProfileId` on threads
- `electron/services.js` — `applyAgentProfile`; clear id on manual set\*;
  copy id on fork
- `electron/ipc.js` — three handlers
- `src/shared/ipc.ts` — types + `CoderApi`
- `src/shared/ipcChannels.ts` — three rows
- `electron/preload.js` — via sync script
- `src/devCoder.ts`, `test/support/fakeCoder.ts`
- `src/components/SettingsModal.tsx`, `SettingsModal.module.css`
- `src/components/Composer.tsx` — `applyAgentProfile`
- `src/components/ThreadView.tsx` — layer + hide Allow always
- `src/modelPicker.ts` — rule count in summary
- `src/useCoder.ts` / `src/App.tsx` — wire the new thread method
- `test/settingsModal.test.tsx`, `test/permissionPrompt.test.tsx`
- `scripts/test-electron.js`

Do not change `electron/guardrails.js` rule tables in this slice.

## Check

- A Scout profile with `bash` / `npm publish` / `block` auto-denies that
  Claude tool call. Transcript + audit say `profile.block`. The card
  never appears.
- The same profile with `tool` / `Read` / `allow` auto-allows Read.
- `#409` still blocks `Write` to `.github/workflows/ci.yml` even if the
  profile allows `write` `*` .
- Editing a command on the card to `sudo rm /` cannot be allowed.
- Allow always is hidden on a profile `ask` row.
- Advanced Verify reports ok on an untouched log and fails after a
  hand-edited layer field.
- Applying Scout then changing the model picker by hand clears
  `agentProfileId` (built-ins only until a profile is applied again).
- A Grok thread with a matrix does not grow fake deny audit rows.
