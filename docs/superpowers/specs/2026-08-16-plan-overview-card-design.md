# Plan overview card in the main panel (issue #75)

## Problem

When an agent proposes a plan, the only surface is transient: the `ExitPlanMode`
permission prompt renders the plan markdown as an approve/reject `PlanPrompt`
(`src/components/ThreadView.tsx`). Answering it destroys the plan — the user
then has to scroll the transcript to remember what the agent intends to do.

The thread already carries a *second*, durable plan surface: `ThreadInfo.planSteps`
(issue #76), which the runner mirrors from the agent's TodoWrite list with a
`todo | doing | done` status per step. It is rendered on the Planboard but not in
the thread's main panel, and it already reaches the renderer through
`ThreadDetail.thread`.

## Design

### 1. Persist the prose plan

Add `plan?: string` to `ThreadInfo`, alongside `planSteps`.

The runner already extracts the plan markdown for the prompt (`planText()`,
capped at `PLAN_TRUNCATE` = 20000). In `respondPermission`, the branch that
already runs on plan approval (`isPlan && decision !== "deny"`) also writes the
plan onto the thread, capped at `PLAN_STORE` = 4000 chars: the field rides every
`threads:changed` push for *every* thread, so the prompt's budget is too fat to
persist.

- Rejected plans are not stored — the agent is still planning.
- The newest approved plan replaces the previous one. Latest plan wins; no history.

No new IPC channel, no store schema work (`updateThread` takes an arbitrary
patch), no watching the worktree for plan files.

### 2. `PlanCard` in ThreadView

A new inline card rendered after the transcript, immediately above the
`pendingPermission` block, so it sits in the same slot as `PlanPrompt` /
`QuestionPrompt` and stays in view as the thread auto-scrolls.

Contents:

- Header: `Plan`, plus an `N/M done` counter when `planSteps` is present.
- An `<ol>` of steps, each carrying `data-plan-step={status}` for styling — the
  same convention `PlanboardView` uses for thread plans.
- A `Show full plan` / `Hide full plan` toggle that reveals `thread.plan` through
  the existing `Markdown` component. It starts open when there are no steps yet,
  so the card is never just an empty header.

Visibility:

- Rendered when the thread has `planSteps` or `plan`.
- Suppressed while an `ExitPlanMode` prompt is pending — `PlanPrompt` is already
  showing that plan, and two copies of it would be noise.

### 3. What counts as "created a plan"

Either source qualifies:

- An approved `ExitPlanMode` plan (agents run in plan mode).
- A todo list (`planSteps`), which covers agents that never enter plan mode.

Step progress updates live, because `planSteps` is already rewritten on every
TodoWrite.

## Testing

- Electron: approving an `ExitPlanMode` permission persists `thread.plan`;
  denying it does not.
- Renderer: the card renders steps and the counter, the full-plan toggle works,
  and the card is suppressed while a plan prompt is pending.

## Deliberately not built

- Plan history (a list of past plans per thread).
- Detecting plan files written into the worktree.
- A click-through modal for the full plan — the card's inline markdown covers
  4000 chars; add the modal if that proves cramped.
