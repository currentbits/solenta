# Muse capture notes

Captured 2026-09-03 with Muse Code 1.0.2 (1.0.2-R2040.1).
`--provider echo`. `META_API_KEY` was unset, so no Spark capture.

## Home env

- help mentions MUSE_HOME: no
- help mentions XDG_CONFIG_HOME: no
- help mentions XDG_DATA_HOME: no
- help mentions HOME: no

There is no first-party `MUSE_HOME`. Overlay later tasks should set child
`XDG_CONFIG_HOME` and `XDG_DATA_HOME`, not rewrite process-wide `HOME`.

Docs (https://dev.meta.ai/docs/muse-code/configuration.md,
https://dev.meta.ai/docs/cookbook/deterministic-replay/):

- settings/auth: `$XDG_CONFIG_HOME/muse` else `~/.config/muse`
  (`settings.json`, `auth.json`, `trust.json`)
- sessions: `${XDG_DATA_HOME:-$HOME/.local/share}/muse/sessions/YYYY/MM/DD/<session-id>/session.jsonl`
- user skills: `$XDG_CONFIG_HOME/muse/skills`

The launcher at `~/.local/bin/muse` also resolves
`$XDG_CONFIG_HOME/muse/auth.json` (else `~/.config/muse/auth.json`).
This host has `~/.config/muse/` and `~/.local/share/muse/`.

`settings.json` must include `"schema_version": 1` or every command fails.

## Session-id JSON path

Resume handle is **`stream.id`** when **`stream.kind` is `"session"`**.

Every echo JSONL line is that envelope. Example from `echo-hello.jsonl`:

```json
"stream":{"kind":"session","id":"01a06856-a922-7ec0-a75a-aa6eab933dff"}
```

`muse exec --help` documents `--session-id <UUID>` for follow-ups.

Do not use top-level `id`. That is a per-record id and **restarts per
session** (both captures reuse `018f0000-0000-7000-8000-00000000c350`…).
Also present, not the session id: `payload.run_stream.id` (run),
`payload.task_id` / `payload.task_stream.id` (task).

## Tool events

- echo-hello lines: 13
- echo-tools lines: 13
- echo-tools contains tool start/result: **no**
- spark-hello.jsonl: **not captured** (`META_API_KEY` unset)

`--provider echo` does not run tools. Both prompts produced the same
13 payload types; the tools prompt was echoed as text:

- `runtime.command.accepted`
- `session.run.linked`
- `turn.input.user`
- `run.lifecycle.started`
- `task.stream.linked`
- `task.lifecycle.proposed` / `accepted` / `scheduled` /
  `side_effect_intent` / `started` / `completed`
- `run.output.delta` (`payload.text`)
- `run.terminal.completed` (`payload.terminal`, `payload.text`)

Assistant text is `payload.text` on `run.output.delta` and
`run.terminal.completed`. Terminal kind is `payload.terminal`
(`"completed"` here).

**Tool-name aliases: not captured.** Stop before Task 6 tool-card tests.
Do not copy the `muse-codes` crate. Recapture with Spark (or another
provider that actually calls tools) before writing tool extractors.

## Hooks file shape

`help.txt` does not document hooks. Shape from
https://dev.meta.ai/docs/muse-code/extending.md and
https://dev.meta.ai/docs/muse-code/configuration.md:

- Project: `<project-root>/.muse/hooks.json`
- User: first-class `hooks` block in `~/.config/muse/settings.json`
- Managed: `managed_hooks_path` in settings points at a file
  (also `managed_hooks_env_vars` on the settings document)

Lifecycle events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PermissionRequest`, `PostToolUse`, `PreLLMCall`, `PostLLMCall`,
`PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, `Stop`,
`SessionEnd`.

A malformed project or managed hook file contributes no handlers and
warns at startup. A malformed user settings file fails validation.

Docs do not publish a project `hooks.json` example. Plugin manifests
use structured argv (`command` as a string array) bound to one `event`.
PreToolUse deny output (binary error strings, 1.0.2-R2040.1): JSON object
with `hookSpecificOutput.permissionDecision` (`deny` needs
`permissionDecisionReason`; `allow` needs `updatedInput`).
Legacy `decision: block` is rejected for PreToolUse.

Whether that deny still fires under `--disable-approval` is unproven here.
