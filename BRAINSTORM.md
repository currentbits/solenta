# Coder - Concept Brainstorm

Coder is a local-first desktop app for **running multi-agent software work with a visible pipeline**, not another chat box that happens to edit files. Electron + React. Dark three-pane shell: projects and threads on the left, the working thread in the center, and a live agent workflow graph on the right.

This doc is the design brain dump: who it is for, how it differs from the current crop of harnesses, the primitives we will build around, ranked feature ideas, and the risks we should not paper over.

---

## 1. Product vision

**One sentence:** Coder turns "kick off an agent and hope" into a **directed multi-phase workflow** you can watch, stop, restage, and land as a PR.

Most agent UIs today are either:

1. A terminal wrapper around a single long-running agent (Claude Code style), or
2. A control plane that spawns many harnesses but treats each run as an opaque chat (t3code / synara style).

Coder sits in the gap: **you own the workflow graph**. A thread is not "a conversation with one model." It is a job with named phases (Seed → Analyze → Verify → Judge → Synthesize), fan-out inside phases, status per worker, token burn in the open, and a human still at the Build button.

**Who it is for**

- Solo builders and small teams who already pay for Claude / Codex / OpenCode and run agents daily.
- People who routinely fire 3-10 agents and lose track of which branch is which.
- Developers who want **worktree isolation by default**, not "edit main and pray."
- Power users who care about **cost visibility and permission modes**, not just prettier diffs.

**Who it is not for (yet)**

- Non-developers who want a no-code app builder.
- Enterprises that need SSO, audit export, and managed fleet controls on day one.
- People whose whole workflow is "one Claude Code tab in iTerm."

---

## 2. How Coder differs

| Axis | Claude Code / terminal agents | t3code | Synara | **Coder** |
|------|-------------------------------|--------|--------|-----------|
| Core metaphor | One agent session | Harness control plane | Command center workspace | **Phased multi-agent job** |
| Parallelism | Manual / subagents inside one process | Many harnesses, weak phase model | Many agents + terminals + previews | **First-class phase fan-out with settled counts** |
| Isolation | Often cwd / hope | Worktrees in some flows | Worktrees + branches | **Worktree per thread (or per agent), PR as land path** |
| Visibility | Stream of tool calls | Chat + status badges | Chats, diffs, browser | **Pipeline UI + work logs + background agent strip** |
| Product shape | CLI-first | Multi-surface (desktop, mobile, web) | Desktop workspace | **Desktop-first Electron app, orchestration native** |

**Opinionated bets**

1. **The right pane is the product.** If the Agents panel is a decorative sidebar, we failed. It is the live DAG of work.
2. **Threads outrank chats.** History is a job log with messages embedded, not a free-form DM that occasionally runs tools.
3. **Permissions are a mode, not a popup storm.** Full access / ask / read-only is chosen in the composer and sticky per thread.
4. **We are not a better Claude Code.** We may spawn Claude Code, Codex, or our own worker. The harness is pluggable; the **workflow model is ours**.
5. **Cost is a first-class UI surface.** Token meter (`Σ 52.0k tok`) and effort knobs belong next to the Build action, not buried in settings.

---

## 3. Key primitives

These names should show up in code, UI, and docs the same way.

### Project
A local git repository registered with Coder. Owns path, default branch, preferred models, and a list of Threads. Opening a project does not mean "open a folder in an editor"; it means "this is a workspace agents may mutate under policy."

### Thread
A unit of work inside a Project: a user goal, a conversation timeline, a permission mode, a worktree/branch binding, and zero or more AgentRuns. Status is live: `Working (1m 45s)`, `Done`, `Failed`, `PR #42`, branch name. Threads are the left-sidebar atoms, not raw chats.

### Worker agent
A single model process doing a scoped job (analyze file set, write patch, run tests, review). Has model id, effort level, status dots (queued / running / settled / failed), and TokenUsage. Workers are leaves under WorkflowPhases.

### Workflow phase
A named stage in a pipeline: e.g. Seed, Analyze, Verify, Judge, Synthesize. A phase may fan out (4 parallel Analyze agents on sonnet-5). Phases have: plan (how many workers, which model), progress (settled/total), and optional gates (do not start Verify until Analyze settles).

### Worktree
A git worktree tied to a Thread (and optionally to a Worker). Default posture: agents never write the primary checkout. Merge/land is explicit. Stash counter in the composer reflects dirty local state the human still owns.

### PR
The preferred land path for a Thread: open or update a pull request from the thread branch. PR number and CI state surface as thread badges. Coder is not a full GitHub client; it is good at "this work → reviewable PR."

---

## 4. Feature ideas (value vs effort)

Ranked roughly **value / effort**, high first. One-line rationale each.

| # | Feature | Value | Effort | Rationale |
|---|---------|-------|--------|-----------|
| 1 | **Three-pane shell with mock pipeline** | High | Low | Ships the product feel immediately; unblocks design and user testing before any model call. |
| 2 | **Thread list with live status badges** | High | Low | Status is how multi-job users navigate; elapsed time and PR badges pay for themselves daily. |
| 3 | **Worktree-per-thread isolation** | High | Med | Prevents the #1 agent disaster (parallel agents fighting over the same files on main). |
| 4 | **Phased workflow runner (Seed→…→Synthesize)** | High | High | This is the differentiator vs pure harness GUIs; without it we are a prettier t3code. |
| 5 | **Collapsible work logs + event cards** | High | Med | Makes long runs scannable; "Kicked off 5 subagents" with a phase table is the trust surface. |
| 6 | **Composer: model / effort / permission / Build** | High | Med | Matches the reference UI and encodes policy at send-time instead of mid-run dialogs. |
| 7 | **Background agents strip + Stop** | High | Low | Global kill switch for runaway cost and runaway disk thrash; cheap, non-negotiable. |
| 8 | **Token meter (per agent + Σ)** | Med-High | Low | Cost anxiety kills multi-agent use; meters make fan-out a conscious choice. |
| 9 | **Harness adapters (Claude Code, Codex, OpenCode)** | High | High | Reuses subscriptions users already have; delay custom agent runtime until adapters prove the UX. |
| 10 | **Judge phase with structured pass/fail** | Med-High | Med | Closes the loop: parallel analyzes need a decision step before synthesize, not vibes. |
| 11 | **Stash counter + branch indicator in composer** | Med | Low | Keeps human state visible next to agent state; reduces "where did my edits go?" support. |
| 12 | **Local / offline model path** | Med | High | Important for privacy and cost, but MVP should not block on Ollama/MLX quality parity. |

Stretch (post-MVP, still interesting): mobile remote control (t3code-style), browser preview pane (synara-style), shared team workflow templates, spend caps with hard stop.

---

## 5. Open questions and risks

### Agent cost control
Fan-out of 4× Analyze on a large context window can burn hundreds of dollars in an afternoon. We need: per-thread budget soft caps, a global daily budget, effort defaults that are not always "High · 1M", and the Stop strip that actually kills children. Open: do we hard-block Build when over budget, or only warn?

### Merge conflicts between parallel agents
If two Analyze workers edit overlapping paths in the same worktree, we invented a merge hell factory. Prefer **one worktree per thread** with workers that propose patches into a shared staging area, or **one worktree per worker** with a Synthesize phase that integrates. Open: which default is less surprising for git-literate users?

### Trust and permissions
"Full access" is what power users want and what will scare everyone else. Permission mode must be visible, sticky, and audit-logged (at least locally: what tools ran, what files changed). Network, `git push`, and secrets files need explicit policy, not "the model decided." Open: do we ship a macOS TCC-aware sandbox, or trust OS user + git worktree boundaries first?

### Offline / local models
Local models reduce cost and data egress but lag on tool use and long-horizon coding. Product should not pretend local = cloud quality. Open: treat local as a first-class Worker backend with honest capability tags, or as a fallback only?

### Orchestration ownership
Does Coder own the phase graph and call models as leaf tools, or does it shell out to Claude Code / Codex as the real agent and only visualize? Opinion for v1: **own the graph, adapt the leaves.** Owning only visualization of foreign harnesses will always feel second-class.

### State and durability
Electron main process will spawn PTYs and manage worktrees. If the app crashes mid-run, what resumes? Threads and AgentRuns need durable state on disk (SQLite or JSON under `~/Library/Application Support/Coder`). Open: resume policy for half-finished phases.

### Competitive gravity
t3code and synara move fast and already have multi-agent + worktree stories. Coder wins only if the **pipeline metaphor** is clearer and more trustworthy, not if we match feature checklists. Risk: building a clone with different branding.

---

## 6. Design principles (working)

1. **Show the machine.** Phases, fan-out, tokens, elapsed time: always visible while work is running.
2. **Isolation by default.** Agents write worktrees; humans land PRs.
3. **Stop is sacred.** Any multi-agent UI without a reliable global Stop is a liability.
4. **Policy at the composer.** Model, effort, permissions chosen before Build, not negotiated mid-flight.
5. **Logs over live terminals for the default view.** Terminals exist for power users; the center pane defaults to structured work logs and markdown.
6. **No em-dash marketing copy.** Be concrete. Name the control. Name the failure mode.

---

## 7. What "good" looks like in six months

A developer opens Coder, picks a project, starts a thread: "Add rate limiting to the public API and open a PR." Coder seeds context, fans out analyze workers on the relevant packages, verifies with tests in isolated worktrees, judges which approach wins, synthesizes a single branch, and surfaces **PR #128** on the left with a Done badge. The right pane shows every phase settled. The token meter is non-zero and unsurprising. The human never had five terminal tabs and a spreadsheet of PIDs.

That is the product. Everything else is scaffolding toward it.
