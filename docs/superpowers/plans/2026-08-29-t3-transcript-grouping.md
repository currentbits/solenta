# T3 Transcript Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse consecutive tools into one T3 sentence and flatten overlay tiles, per `docs/superpowers/specs/2026-08-29-t3-transcript-grouping-design.md` (#768).

**Architecture:** Pure `src/toolGroups.ts` collapses `TimelineEntry[]` into display rows. `ThreadView` renders a group line (expand in place) and ignores `kind === "worklog"`. Overlay CSS keeps `.planCard` / `.specCard` names and becomes a left-rule. No IPC or store change.

**Tech Stack:** TypeScript, React 19, CSS modules, `node:test` + `test/support/render.mjs`.

**Spec:** `docs/superpowers/specs/2026-08-29-t3-transcript-grouping-design.md`.

## Global Constraints

- Hide messages; do not drop them from the store.
- Thinking rows are `role === "event"` plus `thinking === true`.
- `N` is tool-call count, not unique files.
- Permission / question / pending plan stay `.permissionCard`.
- Do not re-land #732 chrome-only strip on remaining tiles.
- No Environment `gitCard` work (#748). No Summary mode (#461).
- Verbose (`useVerboseToolCards`) expands every group.
- Visible copy: no em dashes.

## File structure

| File | Responsibility |
|---|---|
| `src/toolGroups.ts` | `isGroupable`, `toolAction`, `summarizeToolGroup`, `liveGroupLabel`, `collapseTimeline` |
| `test/toolGroups.test.ts` | Pure grouping / grammar / live / hide |
| `src/components/ThreadView.tsx` | Render groups; delete `WorkLogCard`; `data-page-block` |
| `src/components/ThreadView.module.css` | `.toolGroup`, left-rule plan/spec, event line, user bubble no outline |
| `test/threadView.test.tsx` | Grouping, Work Log gone, expand, events not `.card` |
| `test/planCard.test.tsx` | `data-page-block` on plan |

---

### Task 1: Pure grouping

**Files:**
- Create: `src/toolGroups.ts`
- Create: `test/toolGroups.test.ts`

**Interfaces:**
- Consumes: `ChatMessage` from `src/shared/ipc.ts`; `TimelineEntry` from `src/timeline.ts`
- Produces:

```ts
export type ToolGroupAction = "read" | "edit" | "command" | "code-search" | "search" | "other";
export type ToolGroup = {
  id: string; // `${runId ?? "norun"}:${firstMessage.id}`
  runId: string | null;
  messages: ChatMessage[];
  hasError: boolean;
};
export type DisplayEntry =
  | { kind: "message"; message: ChatMessage; timestamp: number }
  | { kind: "group"; group: ToolGroup; timestamp: number }
  | Extract<TimelineEntry, { kind: "artifacts" }>;

export function isGroupable(message: ChatMessage): boolean;
export function toolAction(name: string): ToolGroupAction;
export function summarizeToolGroup(messages: ChatMessage[]): string;
export function liveGroupLabel(messages: ChatMessage[]): string | null;
export function collapseTimeline(
  entries: TimelineEntry[],
  opts: { working: boolean },
): DisplayEntry[];
```

- [ ] **Step 1: Write `test/toolGroups.test.ts`** covering: consecutive tools same run collapse; assistant prose breaks; missing runId does not merge; grammar one/two/three+; unknown name → Used N tools; error flag; thinking-only completed hidden; thinking-only live shown as Thinking; live `Bash: npm test` → `Running npm`; worklog entries dropped.

- [ ] **Step 2: Run the test and confirm it fails to import**

```bash
node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test --test-timeout=20000 test/toolGroups.test.ts
```

- [ ] **Step 3: Implement `src/toolGroups.ts` to the spec (normalize names by lowercasing and stripping `_`; skip `kind === "worklog"`).**

- [ ] **Step 4: Re-run the test. Expected: PASS.**

- [ ] **Step 5: Commit** `feat: collapse consecutive tools into a T3 summary`

---

### Task 2: ThreadView groups and delete Work Log card

**Files:**
- Modify: `src/components/ThreadView.tsx`
- Modify: `src/components/ThreadView.module.css`
- Modify: `test/threadView.test.tsx`

**Interfaces:**
- Consumes: `collapseTimeline` from Task 1
- Produces: `[data-tool-group]` with `aria-expanded`; expanded children without `.card`; no "Work Log" text

- [ ] **Step 1: Update threadView tests** that require Work Log titles or always-visible tool cards. Add: multi-tool run shows `Read 2 files` (or the actual sentence) once; click/Verbose reveals tool names; path-click expands first; events have no `.card` class.

- [ ] **Step 2: Run `test/threadView.test.tsx`. Expected: FAIL on Work Log / toolCard.**

- [ ] **Step 3: Wire `collapseTimeline` over `visibleTimeline`. Skip worklog. Render `ToolGroupRow`. Add `bare` to ToolCallCard/ThinkingCard (no `.card` / `.toolCard` tile). Event row uses `.eventLine` not `.card`. Delete `WorkLogCard`.**

- [ ] **Step 4: Re-run threadView tests. Expected: PASS.**

- [ ] **Step 5: Commit** `feat: render grouped tools and drop the Work Log card`

---

### Task 3: Overlay left-rule

**Files:**
- Modify: `src/components/ThreadView.tsx` (add `data-page-block` on Plan/Spec/Ask/Teach/Btw/Felt)
- Modify: `src/components/ThreadView.module.css` (`.planCard` / `.specCard` left-rule; `.userBubble` drop outline)
- Modify: `test/planCard.test.tsx`

**Interfaces:**
- Consumes: existing overlay components
- Produces: `data-page-block` on flattened nodes; permission unchanged

- [ ] **Step 1: Assert `[data-plan-card][data-page-block]` in planCard.test.tsx**

- [ ] **Step 2: Run planCard test. Expected: FAIL missing attribute.**

- [ ] **Step 3: Add the attribute and retarget CSS. Do not change `.permissionCard`.**

- [ ] **Step 4: Run planCard + feltCard + specCard tests. Expected: PASS.**

- [ ] **Step 5: Commit** `feat: flatten plan and mode overlays to a left rule`

---

### Task 4: Renderer suite and typecheck

- [ ] **Step 1:** `npm run test:renderer` — fix any leftover Work Log / toolCard assertions
- [ ] **Step 2:** `npm run typecheck`
- [ ] **Step 3:** Commit any fixes
