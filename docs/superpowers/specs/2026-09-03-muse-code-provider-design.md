# Muse Code provider design

Approved 2026-09-03. Issue #873.

Solenta gains Muse Code as a first-class agent harness, the same way it
already hosts Claude Code, Codex, Grok, Kimi, OpenCode, and Cursor. The
model is Muse Spark. The thing Solenta spawns is Meta's `muse` CLI.

OpenCode already lists `opencode/muse-spark-1.2-contributor-free`. That
row stays on OpenCode. This spec is the Muse Code harness, not a catalog
bump.

## Goal

A user with `muse` on PATH can pick **Muse Code** in the provider picker,
start a thread on `muse-spark-1.3`, and get the same Solenta thread UX
as kimi/cursor: streaming transcript, tool cards, resume, MCP (memory
and project servers), Solenta guardrails, skills fan-out, ask, and
commit-message generation.

Windows has no official `muse` binary. The provider row still exists;
`available` is false until the binary is on PATH.

## Product contract

- Provider id is `muse`. Display name is `Muse Code`. Binary is `muse`,
  overridable with `CODER_MUSE_BIN`.
- Default / recommended model is `muse-spark-1.3` (1,048,576 context
  tokens). `muse-spark-1.2` is listed. Contributor ids are added only
  if a live `muse` catalog lists them. OpenCode model ids are not
  reused here.
- Reasoning effort is `low | medium | high | xhigh | ultra` via
  `--reasoning-effort`. Meta rejects `none`; Solenta never sends it.
- Permission modes offered: `default` and `bypassPermissions`. `plan`
  and `acceptEdits` are not honoured (same shape as OpenCode). Stored
  leftovers snap through the existing `snapPermissionMode`.
- Resume is real. The first turn omits `--session-id`. The runner
  stores the session id the stream emits. Follow-ups pass
  `--session-id <uuid>`. Solenta never invents a sentinel id
  (kimi #220).
- Headless `on-request` would hang: there is no UI to answer Muse
  approvals. Default therefore does not send `on-request`.
- Solenta owns git worktrees. Muse `--worktree` is never passed.
- `--yolo` is never passed. It disables approval and the OS sandbox
  and trusts attacker-controlled `AGENTS.md` on a PR checkout.
- `--trust-workspace` is always passed so project `AGENTS.md`, skills,
  and hooks load.
- Token spend and the context ring stay at zero until a captured
  `muse exec --json` stream actually carries usage. Do not invent
  numbers.
- `supportsSearch` is false unless a live CLI flag maps cleanly onto
  `thread.webSearch`. Do not show a Search pill on a guess.

## Architecture

Solenta keeps spawning a CLI and parsing stdout. v1 talks to
`muse exec --json`. It does not use `muse serve` or `@muse-code/sdk`
(MSP). That control protocol is a later upgrade if exec JSONL cannot
carry what we need.

New modules, following kimi (extractors + overlay) and grok
(fail-closed MCP overlay, PreToolUse hook):

| File | Role |
|------|------|
| `electron/providers.js` | Registry row, `kind: "muse-json"`, `buildArgs` |
| `electron/muse.js` | Overlay, JSONL extractors, spawn helpers |
| `electron/muse-guardrail-hook.js` | PreToolUse → `classifyTool` |
| `electron/runner.js` | `startMuseRun` on `kind === "muse-json"` |

Fan-out (every list kimi or cursor already sits on):

- `electron/skills.js` + `src/shared/ipc.ts` `SkillTarget`: add `muse`
  → `$XDG_CONFIG_HOME/muse/skills` (default `~/.config/muse/skills`)
- `src/components/onboarding/installHints.ts`
- `src/components/Sidebar.tsx` provider rank
- `src/components/UsageView.tsx` color
- `src/components/SkillsSections.tsx` label
- `electron/ask.js` / `electron/commitmsg.js`
- `electron/mcpImports.js` `MCP_PROVIDERS` (Muse settings.json)
- `src/devCoder.ts`, `test/support/fakeCoder.ts`
- `docs/ARCHITECTURE.md` kinds list (it is already stale for grok)

`electron/runner.js` dispatch after the existing kinds:

```
if (entryDef.kind === "muse-json") {
  return startMuseRun(threadId, dispatchPrompt, runId, entryDef);
}
```

Do not fall through to `startClaudeRun`. Muse JSONL is not
claude-stream.

## Registry and argv

`buildArgs({ prompt, sessionId, permissionMode, model, reasoningEffort })`
emits, with the prompt last:

```
exec --json
[--session-id <uuid>]          # only when sessionId is set
[--model <id>]
[--reasoning-effort <level>]   # only when the model lists that level
--trust-workspace
--approval-mode never          # default
# or
--disable-approval             # bypassPermissions
<prompt>
```

`--disable-approval` keeps the OS sandbox. `--approval-mode never` also
keeps the sandbox and skips approval prompts. Both are unattended-safe.

Cwd is `thread.worktreePath || project.path`. That directory is the
workspace. Do not pass `--workspace` or `--allow-workspace-switch`. If
a live capture shows `muse exec` ignoring cwd for policy, update this
spec before shipping; do not guess a flag.

## Overlay, MCP, guardrails

Muse stores MCP and hooks in user-global
`~/.config/muse/settings.json` (or `$XDG_CONFIG_HOME/muse/settings.json`).
Auth is `auth.json` next to it. Sessions live under
`~/.local/share/muse/` (or `$XDG_DATA_HOME/muse/`). A missing
`schema_version: 1` in a written settings file fails every command.

Per-run overlay dest: `path.join(userDataPath, "muse-homes", threadId)`.

Env, in order:

1. If live `muse --help` documents a first-party home override (for
   example `MUSE_HOME`), use that and put the overlay tree in the
   shape that env expects.
2. Otherwise set both `XDG_CONFIG_HOME` and `XDG_DATA_HOME` on the
   child so auth, settings, and sessions resolve inside the overlay.
   Do not rewrite the process-wide `HOME`.

Materialize:

- Symlink `auth.json` from the user's real config dir so login and
  `META_API_KEY` fallback still work. `META_API_KEY` in the
  environment already wins over a stored key; leave it untouched.
- Symlink the sessions directory so `--session-id` resume works.
- Write `settings.json` with `"schema_version": 1`, Solenta MCP
  servers for this project only (same payload `kimiMcpServersForRun`
  already builds), and a PreToolUse hook. Do not copy the user's
  settings file.
- Do not symlink user hooks, MCP, or `trust.json`.
- `--trust-workspace` covers this turn's cwd; do not copy
  `trust.json`.

Overlay failure **fails the run** (grok #706), not kimi's best-effort
swallow. A failed isolate would inherit the user's global MCP.

Reclaim without following those symlinks (existing grok/kimi reclaim).
A live thread (`working` or `quota-wait`) keeps its overlay.

ssh/WSL: deploy the overlay with `remote-overlay.js` the way kimi
does (`deployKimiGuardrailOverlay`), pass the far-side config/data
env through `wrapCommand`. A deploy miss must not run the far-side
`muse` against the user's unsandboxed settings: fail the run.

Guardrail hook:

- Overlay PreToolUse invokes `electron/muse-guardrail-hook.js`.
- Map Muse tool names onto `classifyTool`'s set (Bash/Edit/Read/…).
  The live alias table is captured from a real `muse exec --json`
  tool event, not guessed.
- Asking modes are already remapped, so hook `ask` is treated as
  deny (same as grok under `--always-approve`).
- Hook JSON schema is proven against the installed CLI. If the
  documented settings `hooks` block cannot deny under
  `--disable-approval`, stop and fix the overlay before shipping;
  do not ship an inert gate.

## Stream parser

`muse exec --json` JSONL is unpublished. The community crate
`muse-codes` is a hint, not a contract.

Pure extractors in `electron/muse.js` (kimi.js shape):

- session id (the stream-unique handle, stored on the thread)
- assistant text deltas and completed text
- thinking / reasoning deltas
- tool start and tool result
- terminal (completed / cancelled / failed)

Unknown payload types are ignored. They must not fail the run.

Tool-card correlation uses `(stream.id, record.id)`. Muse record ids
restart per session; using `id` alone aliases cards across threads.

First implementation step, before the parser is written: capture

1. `muse exec --json --provider echo "…"` (no credentials)
2. one real Spark run if `META_API_KEY` or a stored login exists

Commit those captures as fixtures. Parser unit tests are
fixture-driven. Fake `muse` (via `writeFakeBin`) drives runner tests
and replays the same shapes.

If echo cannot emit tool events, the fake bin still emits the captured
live shapes so tool-card tests do not depend on credentials.

## Ask, commit message, workflows

`ask.js` / `commitmsg.js`: `muse exec --json --trust-workspace
--approval-mode never` plus optional `--model`, prompt last. Parse
assistant text from the same extractors. No session id (one-shot).

Workflow phases use the same `buildArgs` + overlay as a normal turn.
Resume a phase the same way as kimi: stored per-slot session id, not
`--last`.

## Error handling

- Exit 0 means the turn finished, not that the work is correct. Verify
  stays Solenta's job.
- Exit 1: fail, cancel, or `--max-model-steps`. Exit 2: usage error.
  130/143: signal. Map these onto the existing `markRunFailed` /
  stopped paths, not a new taxonomy.
- Overlay settings without `schema_version: 1` is a Solenta bug: the
  writer always includes it.
- Auth missing: surface stderr (`not logged in` / API key). Onboarding
  hint command is `curl -fsSL https://dev.meta.ai/install.sh | bash`
  and docs URL `https://dev.meta.ai/docs/muse-code`.
- Missing binary: existing `assertProviderBinary` path.

## Testing

Mirror kimi, not a new harness:

- `electron/test/muse.test.js`: fake-bin JSONL for text, thinking,
  tools, resume `--session-id`, prompt-last argv, permission flags
- `electron/test/muse-home.test.js` + reclaim: symlink auth/sessions,
  written settings, no user MCP leak, fail-closed on overlay throw,
  no-follow-symlink delete
- `electron/test/muse-guardrail-hook.test.js`: deny-tier Bash
- `electron/test/providers.test.js`: registry includes `muse`,
  `kind: "muse-json"`, models, efforts, permissionModes
- `electron/test/permission-modes.test.js`: snap + argv
- UI lists: providerRows, install hints, skills target, sidebar rank
- Workflow resume test if kimi has one (`workflow-kimi-resume.test.js`
  analogue)

Optional later, not a v1 gate: `MUSE_LIVE` canary that the overlay
PreToolUse actually denies under `--disable-approval` (grok #826
shape).

## Out of scope

- `@muse-code/sdk` / `muse serve` / MSP `approval/decide`
- Interactive Muse approval round-trip in the Solenta ask modal
- Muse `--worktree`, Muse workflows, Muse session-messaging
- OpenCode catalog bump from Spark 1.2 to 1.3
- Windows `muse` binary
- Spend / context-ring numbers until the stream carries usage
- Copying the user's `settings.json` into the overlay
- Passing `--yolo` or Muse `--worktree`

## Key decisions

1. **Harness, not model.** Spark-via-OpenCode already exists. Support
   means spawning `muse`.
2. **`exec --json`, not MSP.** Matches every current provider. MSP is
   experimental (exit 5 when the SDK tier is off) and would be a new
   runner architecture.
3. **Provider id `muse`.** Matches the binary, like `grok` / `kimi`.
4. **Headless never asks.** `default` → `--approval-mode never`;
   `bypassPermissions` → `--disable-approval`. Sandbox stays on.
   Same trap as grok #549.
5. **Fail-closed overlay.** Grok #706, not kimi's best-effort
   swallow. Isolation is the feature.
6. **Fixture-first parser.** Unpublished JSONL. Capture echo + live
   before writing extractors. `muse-codes` is not the contract.
7. **No Muse worktree, no `--yolo`.** Solenta already isolates the
   checkout; `--yolo` would drop the remaining sandbox.

## Implementation order

1. Live capture (`--provider echo`, then Spark if credentials exist).
   Confirm home env (first-party vs XDG) and PreToolUse hook schema.
2. Registry + `buildArgs` + fake-bin argv tests.
3. Overlay + MCP + guardrail hook + reclaim + fail-closed tests.
4. Extractors + `startMuseRun` + fake JSONL runner tests.
5. UI fan-out, ask, commitmsg, skills, mcpImports.
6. Workflow resume if step 4 stored session ids correctly.

Do not merge a parser written only from the community crate.
