# T3-style transcript grouping and overlay flatten (issue #768)

## Problem

T3 Code's main screen shows a finished turn as user text, one summary line
(`Read 12 files, ran 4 commands, and changed 3 files`), then assistant prose.
Live work is one `Running rg` line. Tools are one click away.

Solenta paints a `.card` (fill, 1px border, shadow, 12px padding) for every
tool, every thinking block, every event, plus a Work Log card, then stacks
Plan / Spec / Ask / Teach / Felt / Divergence under the fold.

A 40-tool turn is one line in T3 and about 40 boxes here. #732 stripped chrome
from the same tiles and was reverted: ghost outlines, same count. #748 flattens
chrome but still lists every tool. #461 is a Claude Focus *toggle*. This spec
is T3's default: always grouped, expand in place, plus overlay flatten.

Tracking: [#768](https://github.com/currentbits/solenta/issues/768).
Thread: `e260cda9-b69a-41eb-b254-476003aa6258`.

## Goals

1. Consecutive tool and thinking messages in a run collapse to one sentence.
2. A live turn shows one `Running …` (or `Thinking`) line.
3. Click a group, or turn Verbose on (#750), to expand in place.
4. Remove the Work Log card from the transcript. Duration stays on the run header.
5. Overlay: only permission, question, and pending plan approval stay cards.
   Plan and mode blocks become left-rule page type.
6. Hide messages. Do not drop them from the store.

## Non-goals

- Environment `gitCard` grouping (stays on #748).
- Claude Summary / Normal / Verbose dropdown (stays on #461).
- A new transcript data model, IPC field, or store schema.
- Re-landing the #732 chrome-only strip on remaining tiles.
- Rebrand, layout rewrite, or changing what the agent actually did.

## Architecture

Pure grouping lives in a new module, `src/toolGroups.ts`. `ThreadView` consumes
it. `buildTimeline` keeps emitting every `ChatMessage` and every work-log group;
the renderer ignores `kind === "worklog"` and replaces consecutive tool/thinking
message entries with one group row.

```
detail.messages  ──►  buildTimeline  ──►  visible entries
                                              │
                         toolGroups.collapse ─┤
                                              ▼
                         group row | prose | event line | overlay block
```

No second list of tools. `detail.workLog` remains the source for
`workLogDurationLabel` / `mapRunHeaders`. `WorkLogCard` is deleted.

### Units

- **Groupable:** `role === "tool"`, or `thinking === true` (those are `role === "event"`).
- **Breaks a group:** `role === "user"`, `role === "assistant"`, or a non-thinking `event`.
- **Same run:** adjacent groupable messages share a `runId`. A missing `runId` on
  either side breaks the group (do not merge across runs or across un-tagged rows).

A group of one is still a group: `Read 1 file`, not a boxed `ToolCallCard`.

A group that is only completed thinking (no tools) renders nothing. Live
thinking-only is the `Thinking` line.

### Summary grammar

Map `tool.name` (case-insensitive, ignore `_` vs camel) to an action:

| Action | Names (non-exhaustive; match contains / equals) | Sentence |
|---|---|---|
| read | Read, ReadFile, image_view | `Read N files` |
| edit | Edit, Write, StrReplace, file_change | `Changed N files` |
| command | Bash, Shell, Command, run_terminal_command, command_execution | `Ran N commands` |
| code-search | Grep, Glob, ripgrep | `Searched code N times` |
| search | WebSearch, web_search, WebFetch | `Searched the web N times` |
| other | everything else, including MCP tools | `Used N tools` |

`N` is the number of tool calls in that action, not unique file paths (most
tools only expose a one-line `text`, not structured paths). Singular when
`N === 1`.

Join labels the T3 way:

- one action: `Read 12 files`
- two: `Read 12 files and ran 4 commands` (second label lowercased)
- three or more: `Read 12 files, ran 4 commands, and changed 3 files`

Thinking rows do not increment `N`. They only affect the live line.

If any tool in the group has `tool.isError`, the summary carries
`data-status="error"`. Failures must not hide.

### Live line

When the thread is `working` and the latest group in the latest run has an
in-progress tool (`tool.done === false`), the collapsed slot is `Running {label}`.
`label` is the first token after the first `": "` in `message.text` when that
token exists (`Bash: npm test` → `npm`), otherwise `tool.name`.

When the latest group is thinking-only and live, the slot is `Thinking`.

The existing status strip (`workingLabel` + Stop) stays. The group line replaces
the stack of open tool/thinking cards, not the strip.

### Expand

- Click / Enter on the summary toggles `aria-expanded`.
- Verbose on (`useVerboseToolCards`) expands every group.
- Expanded rows are the current tool/thinking disclosure (name, summary, input,
  output, images, path links) **without** `.card` / `.toolCard` fill, border, or
  shadow. A chevron row is enough.
- Collapsed path links are not required. The Read-header path-click test expands
  first.

### Events

Non-thinking `role === "event"` is a one-line status row (title + optional
Retry / Fork). No `.card`.

## Overlay flatten

A box means "you must do something now."

**Stay cards** (keep `.permissionCard` amber):

- `PermissionPrompt`
- `QuestionPrompt`
- `PlanPrompt` (pending ExitPlanMode)

**Left-rule page blocks** (no fill, no border, no shadow):

- Plan overview (`data-plan-card`)
- Spec / Ask / Teach / Side question (`data-spec-card`, `data-ask-card`,
  `data-teach-card`, `data-btw-card`)
- Felt estimate (`data-felt-card`)

Keep the existing class names (`.planCard`, `.specCard`). Change their CSS to
a left-rule page block: 2px left rule
`color-mix(in srgb, var(--text) 35%, transparent)`, 10px padding-left, 8px
vertical gap, no fill, no border, no shadow. Buttons and copy stay. `data-*`
hooks stay so existing tests keep finding the blocks.

**Already banners, leave them:** Divergence, suggested-work, working / quota /
queued strips, review bar, inbound `From …` note.

**Removed:** `WorkLogCard` and the `kind === "worklog"` render branch.

**The one remaining shell:** Composer. User bubbles keep fill and drop their
outline. Do not strip chrome from the amber prompts.

## Error handling

- Empty group after filtering thinking-only completed rows: skip (no blank line).
- Unknown tool name: `other` / `Used N tools`. Never throw in the renderer.
- Expand state is per group id (`runId` + first message id). Thread switch
  drops it (component remount). Verbose does not persist expand-beyond-verbose.

## Testing

New: `test/toolGroups.test.ts` for collapse, grammar, live line, error mark,
run-boundary, thinking-only hide.

Update:

- `test/threadView.test.tsx`: a multi-tool run shows one summary and no
  "Work Log" title; Verbose or click reveals tool names; single-tool path click
  still works after expand. Event rows must not use `userBubble` (already true)
  and must not use `.card`.
- `test/planCard.test.tsx`, `test/specCard.test.tsx`, `test/feltCard.test.tsx`:
  still query `data-*-card`. Add one contract assertion that the flattened
  block has no `box-shadow` and no 1px `--border` box (computed style or a
  `data-page-block` attribute set on the same node).

Do not change Electron / store tests. No IPC change.

## File plan

| File | Change |
|---|---|
| `src/toolGroups.ts` | collapse + summarize + live label (pure) |
| `src/components/ThreadView.tsx` | render groups; delete `WorkLogCard`; mark flattened nodes `data-page-block` |
| `src/components/ThreadView.module.css` | retarget `.planCard` / `.specCard` to left-rule; add `.toolGroup` |
| `test/toolGroups.test.ts` | new |
| `test/threadView.test.tsx` | grouping + Work Log removal |
| existing overlay tests | chrome contract only |

`src/timeline.ts` stays. Duration helpers already read `detail.workLog`.

## Deliberately not built

- Per-turn fold of *prose* (Claude Summary mode).
- Provider-supplied `group_tool_verbs` / display transforms (#461 comment).
  Synthesize from `tool.name` for every CLI this pass.
- Drag-to-reorder Environment items.
- Marketing screenshot recapture.
