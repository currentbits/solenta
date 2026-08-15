# Planboard design

Approved 2026-08-15.

## What it is

A read-only board view that sits under Kanban in the sidebar. It shows the
selected project's plan as GitHub issues in three columns: **Todo /
In progress / Done**. One project at a time, chosen with a selector in the
view header.

## Data & convention

Agents record plan items as GitHub issues in the project's repo using status
labels:

- `plan:todo` — planned, not started
- `plan:doing` — in progress
- `plan:done` — finished (or just close the issue)

Column mapping: `plan:doing` → In progress; `plan:done` or closed state →
Done; any other open issue → Todo. Non-plan labels (task/roadmap/bug/…) show
as badges on the card.

## Backend

`listIssues(projectPath)` in `electron/issues.js`, mirroring
`listPrs`: verify the origin remote is GitHub, run
`gh issue list --state all --limit 100 --json number,title,labels,state,url,updatedAt`,
return `{ ok: true, issues } | { ok: false, reason }` (reasons: `not a
GitHub repo`, `gh missing`, `auth`, or the stderr tail). New IPC channel
`git:listIssues`, preload method `git.listIssues`, plus `wireClient` and
`devCoder` implementations and shared types (`PlanIssue`,
`ListIssuesResult`) in `src/shared/ipc.ts`.

## Renderer

- `src/planboard.ts` — pure column bucketing (`planColumns(issues)`), tested.
- `src/components/PlanboardView.tsx` + module.css — project selector
  (dropdown of project slugs, defaults to the first project), Refresh
  button, per-project error row with Retry, cards link to the issue on
  GitHub via plain `href`.
- Sidebar gets a "Planboard" nav row directly under Kanban; new
  `"planboard"` member of `AppView` in `App.tsx`.

## Teaching the agents

One short standing note appended at the single dispatch point in
`electron/runner.js` (`dispatchPrompt`, shared by claude, codex, kimi,
opencode, generic): plan multi-step work as GitHub issues with the `plan:*`
labels via `gh`; skip when the repo has no GitHub remote. One constant in
`services.js` — no per-provider code.

## Tests

Unit tests for the column bucketing and the gh issue-list parsing, matching
the existing kanban/prList test style.

## Skipped (YAGNI)

Drag-and-drop, milestones, GitHub Projects v2, creating/editing issues from
the UI, caching, per-project opt-out.
