# Coder - Product Spec (MVP)

This is the build contract for Coder: what ships first, how Electron + React are split, the core data model, the three-pane UI, and a four-milestone path from mock shell to real agent execution.

Companion doc: `BRAINSTORM.md` (vision, differentiation, ranked ideas, risks).

Style note: no em dashes in product copy or UI strings. Prefer periods, commas, colons, or parentheses.

---

## 1. MVP scope

### Ships first

1. **Electron desktop app (macOS first)** with a dark three-pane layout: Projects/Threads | Thread | Agents pipeline.
2. **Project registration**: add a local git repo path; persist project list.
3. **Threads**: create, select, show status badges (Working + elapsed, Done, Failed, branch name; PR number when present).
4. **Center thread UI**:
   - Message timeline with markdown rendering.
   - Collapsible WorkLog entries (e.g. "Setup script started", "Worked for 1m 45s").
   - Event cards (e.g. "Kicked off 5 subagents" with a compact phase table).
   - Background agents strip ("N agents working in the background") with **Stop**.
   - Composer: model picker, effort/context (e.g. High · 1M), permission mode (Full access / Ask / Read-only), **Build** action, worktree/branch indicator, stash counter.
5. **Right Agents panel**: multi-phase pipeline visualization (Seed, Analyze, Verify, Judge, Synthesize), per-phase fan-out labels, per-agent status dots, settled counters, Σ token meter.
6. **Typed IPC** between main and renderer; orchestration state owned in main (or a main-side service), renderer as view + intent.
7. **Worktree binding** per thread (create/list/remove via main process git helpers).
8. **Mock and then real agent runs**: MVP ends when one real adapter can execute a phased run end-to-end (see milestones).

### Explicitly does not ship in MVP

- Mobile or web remote control.
- Full IDE editing surface (no Monaco-as-product; optional later).
- Browser preview pane, embedded terminal as primary UX.
- Team accounts, cloud sync, SSO.
- Spend hard-caps with billing integration (soft token display only).
- Custom fine-tuned models or training pipeline.
- Windows/Linux parity guarantees (best-effort after macOS).
- Automatic merge of conflicting multi-worktree patches without a Judge/Synthesize step.
- Marketplace of third-party workflow plugins.

---

## 2. Architecture overview (Electron + React)

```
┌─────────────────────────────────────────────────────────────┐
│  Renderer (React)                                           │
│  Three-pane UI · Zustand/React Query style store (view)     │
│  Sends intents over IPC · subscribes to state events        │
└──────────────────────────▲──────────────────────────────────┘
                           │ typed IPC (preload bridge)
┌──────────────────────────▼──────────────────────────────────┐
│  Main process                                               │
│  Window mgmt · Project/Thread store · Orchestrator          │
│  PTY / agent child processes · git worktrees · filesystem   │
│  SQLite or JSON persistence under app userData              │
└─────────────────────────────────────────────────────────────┘
```

### Main process responsibilities

| Area | Responsibility |
|------|----------------|
| Window management | Create BrowserWindow, app menu, quit lifecycle, deep links later. |
| Persistence | Projects, threads, messages, agent runs, token usage. Survive restarts. |
| Orchestrator | Phase graph execution, fan-out, cancel/Stop, status transitions. |
| Process spawning | Spawn harness adapters or worker CLIs via `child_process` / PTY (node-pty). Stream stdout/stderr events to renderer. |
| Git worktrees | `git worktree add/list/remove`, branch create, status, stash list count. Never block UI thread on long git ops without progress events. |
| Filesystem | Sandboxed path checks: agents only touch allowed project roots and their worktrees. |
| Secrets | API keys in OS keychain or env; never write secrets into renderer logs. |

### Renderer responsibilities

- React UI only: layout, components, markdown, local view state (which log is expanded, selected thread id mirrored from main).
- Compose user intents: `thread.create`, `run.start`, `run.stop`, `project.add`.
- Subscribe to push events: `thread.updated`, `agent.progress`, `worklog.append`, `tokens.updated`.
- No direct `child_process`, no raw filesystem writes to the repo, no git CLI from the renderer.

### Typed IPC boundary

- Preload exposes a narrow `window.coder` API with typed methods and event subscriptions.
- Shared package (or `src/shared`) holds request/response types and domain interfaces (see §3).
- Pattern: `invoke('threads:list')` for request/response; `on('threads:changed', cb)` for push.
- Version the protocol lightly (`protocolVersion: 1`) so we can reject mismatched preload/renderer builds.

### Where orchestration state lives

**Source of truth: main process Orchestrator + persistent store.**

- Renderer holds a **projection** for UI (optimistic selection, expand/collapse).
- On app launch, main hydrates from disk and pushes full snapshot.
- Stop, Build, phase transitions mutate main state first; renderer updates from events.
- Rationale: PTYs and git live in main; crash recovery and multi-window later require one owner.

---

## 3. Core data model (TypeScript sketches)

These are interface sketches for shared types. Not generated code; implement as you scaffold.

```ts
type ID = string;

type ThreadStatus =
  | { kind: 'idle' }
  | { kind: 'working'; startedAt: number }
  | { kind: 'done'; finishedAt: number }
  | { kind: 'failed'; finishedAt: number; error: string };

type PermissionMode = 'full_access' | 'ask' | 'read_only';
type EffortLevel = 'low' | 'medium' | 'high';
type MessageRole = 'user' | 'assistant' | 'system';
type AgentStatus = 'queued' | 'running' | 'settled' | 'failed' | 'cancelled';
type WorkLogKind = 'setup' | 'progress' | 'phase_event' | 'tool' | 'error' | 'summary';

interface Project {
  id: ID;
  name: string;
  rootPath: string;
  defaultBranch: string;
  createdAt: number;
  updatedAt: number;
  preferredModelId?: string;
}

interface Thread {
  id: ID;
  projectId: ID;
  title: string;
  status: ThreadStatus;
  permissionMode: PermissionMode;
  worktreePath?: string;
  branchName?: string;
  prNumber?: number;
  prUrl?: string;
  stashCount: number;
  activeRunId?: ID;
  createdAt: number;
  updatedAt: number;
}

interface Message {
  id: ID;
  threadId: ID;
  role: MessageRole;
  bodyMarkdown: string;
  createdAt: number;
  agentRunId?: ID;
}

interface WorkLogEntry {
  id: ID;
  threadId: ID;
  agentRunId?: ID;
  kind: WorkLogKind;
  title: string;
  detailMarkdown?: string;
  durationMs?: number;
  payload?: Record<string, unknown>;
  createdAt: number;
  collapsedByDefault?: boolean;
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
}

interface AgentRun {
  id: ID;
  threadId: ID;
  parentRunId?: ID;
  phaseId: ID;
  modelId: string;
  effort: EffortLevel;
  contextWindowHint?: string;
  status: AgentStatus;
  startedAt?: number;
  finishedAt?: number;
  tokenUsage: TokenUsage;
  worktreePath?: string;
  error?: string;
}

interface WorkflowPhase {
  id: ID;
  threadId: ID;
  runGroupId: ID;
  name: string;
  index: number;
  plannedAgents: number;
  settledAgents: number;
  failedAgents: number;
  modelIdDefault: string;
  status: 'pending' | 'running' | 'settled' | 'failed' | 'skipped';
  agentRunIds: ID[];
}

interface PipelineSnapshot {
  threadId: ID;
  runGroupId: ID;
  phases: WorkflowPhase[];
  agents: AgentRun[];
  totalTokenUsage: TokenUsage;
  backgroundAgentCount: number;
}
```

**Invariants:** one Project per Thread; at most one active pipeline group per Thread in MVP; Stop cancels all non-settled AgentRuns in that group; agent TokenUsage rolls up into `PipelineSnapshot.totalTokenUsage`.

---

## 4. Three-pane UI structure

### Left: Sidebar (Projects + Threads)

- Project switcher / list at top.
- Under the active project: Thread list sorted by `updatedAt` desc.
- Each thread row: title, status badge, optional branch, optional `PR #n`.
- Working badge shows elapsed time (client timer from `startedAt`).
- New Thread control.
- Width: resizable; collapsed mode shows icons only (post-MVP ok).

### Center: Thread

Vertical stack:

1. **Header**: thread title, branch, PR link if any.
2. **Timeline**: Messages + WorkLogEntries interleaved by `createdAt`. Work logs collapsible. Phase event cards richer than plain text.
3. **Background strip** (conditional): "5 agents working in the background" + **Stop** (calls `run.stop` for active group).
4. **Composer**:
   - Textarea for user goal / follow-up.
   - Model picker (Claude Opus 5, etc.).
   - Effort · context (High · 1M).
   - Permission mode (Full access).
   - Build (primary).
   - Footer meta: worktree/branch indicator, stash counter.

Empty state: short instruction to describe a goal and hit Build. No lorem marketing wall.

### Right: Agents panel

- Title: Agents (or Workflow).
- Vertical pipeline of phases. Each phase block:
  - Name + fan-out (e.g. "Analyze · 4 × sonnet-5").
  - Row of status dots per AgentRun.
  - Settled counter (`3/4 settled`).
- Footer: **Σ token meter** for the active pipeline.
- Selecting a phase or agent may scroll/highlight related work logs in the center (nice-to-have in M2).

### Visual language (MVP)

- Dark theme only at first.
- Dense but scannable: status color dots, mono for branch/PR/tokens, prose for assistant markdown.
- Prefer structured cards over raw ANSI terminal dumps in the default timeline.

---

## 5. Roadmap (4 milestones)

### M0 - Mock-data shell (week 1)

**Goal:** Look and feel of the product with zero model calls.

- Electron + React + TypeScript scaffold, dark three-pane layout.
- Fixture Project, Threads, Messages, WorkLogs, WorkflowPhases, AgentRuns.
- Interactive: select threads, expand logs, composer UI (Build no-ops or advances mock state).
- Typed IPC stub: renderer talks to main even if main returns fixtures.
- **Exit:** cold launch shows the reference layout; designer/PM can click through.

### M1 - Real projects, threads, worktrees (week 2-3)

**Goal:** Local truth without agents.

- Add project from disk (must be git repo).
- Persist Projects/Threads to userData.
- Create thread → create git worktree + branch.
- Stash count and branch indicator from real git.
- Thread status still mostly manual/mock for runs.
- **Exit:** user can manage projects/threads and see real worktree paths; no orphan worktrees on thread delete (best-effort cleanup).

### M2 - Orchestrator + one harness adapter (week 3-5)

**Goal:** Build starts a real phased run.

- Orchestrator implements Seed → Analyze → Verify → Judge → Synthesize with configurable fan-out.
- One adapter (prefer Claude Code CLI or Codex CLI already authenticated on the machine).
- Stream WorkLogEntries and AgentRun status over IPC.
- Background strip + Stop kills child processes.
- Token usage best-effort from adapter logs or API if available; else estimated.
- **Exit:** a real repo thread can complete a small task and leave commits on the thread branch.

### M3 - Land path + hardening (week 5-7)

**Goal:** Trustworthy daily driver for solo use.

- Open/update PR from thread branch (gh CLI or API).
- Permission modes enforced in adapter invocation.
- Crash recovery: reopen app, see last run state, no zombie PTYs.
- Basic cost/effort defaults and warnings.
- Polish empty/error states; fix worktree cleanup edge cases.
- **Exit:** demo path from goal → phased agents → PR badge on thread; known limitations documented.

---

## 6. Non-goals for implementation choices

- Do not put orchestration in the renderer "because React is easier."
- Do not share one working tree across parallel agents in MVP.
- Do not block M0 on perfect design tokens; ship structure first.
- Do not add a plugin system before one adapter works well.

---

## 7. Success criteria (MVP)

1. A developer unfamiliar with the codebase can run the app, add a project, start a thread, and understand the three panes in under two minutes.
2. Build produces a visible multi-phase run with status dots and a non-zero token meter (mock in M0, real in M2).
3. Stop cancels in-flight workers within a few seconds.
4. Agent file changes land in a worktree/branch, not silently on the user's primary checkout.
5. Both `BRAINSTORM.md` and this spec remain the orientation docs until replaced by a fuller design system.

---

## 8. Open implementation decisions (resolve during M0-M1)

| Decision | Options | Lean |
|----------|---------|------|
| Persistence | SQLite vs JSON files | SQLite if we already pull a dep; JSON ok for M0-M1 |
| State library in renderer | Zustand vs jotai vs React context | Zustand for simplicity |
| PTY | node-pty vs plain spawn pipes | node-pty if we need interactive harnesses |
| Adapter 1 | Claude Code CLI vs Codex vs OpenCode | Whichever is already installed on the primary machine |
| Phase config | Hardcoded default graph vs per-thread YAML | Hardcoded default for MVP; config file later |

---

## 9. Done definition for this spec

This document is the MVP product contract. Implementation tasks should cite section numbers (e.g. "PRODUCT-SPEC §5 M0") when opening work. If product intent changes, update this file in the same change set as the code that depends on it. Scaffold under `electron/` (main, preload, orchestrator, git, store) and `src/renderer` + `src/shared` when coding starts; this repo is docs-first until then.
