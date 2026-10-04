# Inspector Tabs Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each inspector tab (Environment, Agents, Memory, Skills) one job, one shared section style and no duplicate actions, and move global or per-project configuration into Settings.

**Architecture:**
- A shared `InspectorSection` (native `<details>` when collapsible) and `InspectorBanner`, with one CSS module (`Inspector.module.css`), replace the per-tab card wrappers and the Environment drag-to-reorder list.
- Moved components move unchanged. Only their container changes:
  - Display prefs → Settings → General.
  - Spotlight → Settings → Git.
  - Code map + Config doctor → Settings → Memory, through a new `MemoryProjectTools` export.
  - Catalog, MCP, imports and Add skill → a new Settings pane "Skills & MCP", through `SkillsManager`. That is the old `SkillsTab` body minus the library.
- The inspector reaches Settings through `onOpenSettings(pane)`, which reuses App's existing `openSettings`.
- Fork / Hand off move from the Environment tab to the thread header (`HeaderForkControl` in `ThreadView.tsx`, the old `ForkCard` behaviour), wired through ThreadView's existing `onFork` prop.
- Crew workers get a "Lead: <title> ›" line in the Agents tab instead of the worker-side Team view.

**Tech Stack:** Electron + React 19 + TypeScript renderer, CSS modules, `node:test` with jsdom (`test/support/dom.ts`).

**Spec:** `docs/superpowers/specs/2026-10-03-inspector-tabs-design.md`. This plan covers everything except "Performance changes", which lives in `docs/superpowers/plans/2026-10-03-inspector-performance.md`.

**Base branch and line numbers:**
- Build on `coder/inspector-performance` (PR #1424). Cut `coder/inspector-tabs-redesign` from its tip once the PR's commits are final; at the time of writing that is `810f9243`.
- All line numbers below are from `810f9243`. That branch already has:
  - `listThreadSummaries(input?: ThreadSummariesInput)`, with project-scoped team summaries
  - `RecapCard` calling `{ threadIds: [id] }`
  - App passing `panelRosterKey`, plus stable `integrateSelectedWorker` / `verifySelectedLead` / `landSelectedLead` handlers
  - the `isCrewLead` crew-integration effect, debounced, with the `integrationSeq` request-sequence guard
- A task's line numbers are only exact before earlier tasks in this plan edit the same file. Every edit therefore also quotes an anchor; when the number and the anchor disagree, the anchor wins. Re-locate with `grep -n` before each edit.
- App edits are anchored on quoted text only.

---

## Spec discrepancies

Each line is checked against the code. The plan's decision is in **bold**. Items 1–4 and 11 were decided by Willem on 2026-10-04 and are marked **Resolved**.

1. **Fork / Hand off are not in the thread header.** **Resolved: add them to the header, remove them from the tab.**
   - Today the only header fork is "Fork to fresh context", shown when the context ring warns (`src/components/ThreadView.tsx:382-393`, gated at `:7283`).
   - Both actions also exist in the sidebar card menu (`src/threadActionMenu.ts:100-114`, handled at `src/components/Sidebar.tsx:1002-1004`, menu gated `:1026`). **The sidebar menu stays as is.**
   - **Task 4 adds a Fork button and a "Hand off to…" provider menu to the header `.actions` row (`ThreadView.tsx:7241`), reusing the `ForkCard` behaviour through ThreadView's existing `onFork` prop (`ThreadView.tsx:828-830`, wired at App `onFork={handleForkOpen}`). It is hidden while the thread is working (`isWorking`, `ThreadView.tsx:5092`) and on a draft header (`isDraftHeader`, `:6842`). Task 5 then removes the Environment Fork card.**
2. **"Open in Finder" has no other home.** `revealInFinder` is only used by the inspector (`AgentsPanel.tsx:2500`) and passed by App. **Resolved: keep it.**
   - **Task 5 keeps Finder and Editor as two small icon buttons (aria-label and tooltip "Open in Finder" / "Open in Editor") in the Environment status header's link row.**
3. **"Open in Editor" is in the details card only when the thread has a worktree** (`src/components/WorktreeControl.tsx:919` gates `rows`; the editor row is at `:940-1006`; the details card renders `worktree.rows.workspace` at `ThreadView.tsx:7334-7338`). A thread on the plain checkout, or a remote or scratch project, has no other editor button. **Resolved: keep it.**
   - **Kept as an icon button next to Finder (Task 5).**
4. **The Repository link has no other home.** `gitRepoInfo` is only consumed by the inspector `RepositoryCard` (`AgentsPanel.tsx:1368-1436`). The details card shows no owner/repo. **Resolved: keep it.**
   - **Task 5 keeps it as a small link in the same row: the owner/repo slug with an external-link icon.**
5. **`SyncPill` is not in the header bar.** It sits in the details popover (`ThreadView.tsx:7357-7372`) and hides itself without an upstream.
   - The spec keeps Sync in the Environment status header anyway. **No action.**
6. **The context ring is in the header only at the warn threshold** (`ThreadView.tsx:7283`). Otherwise it is the details card "Context" row (`ThreadView.tsx:7340-7348`).
   - Context stays reachable. **Remove from the Agents tab (Task 6).**
7. **The "Pull requests" home is the sidebar nav button labelled "Review"** (`src/components/Sidebar.tsx:4560-4577`, `data-view-nav="review"`, which opens view `prs`).
   - **Remove the Environment PR card (Task 5).**
8. **No IPC call returns a changed-file count.**
   - "N changed files ›" needs `git:diff` (`fetchDiff`). That is the same call the details card makes (`ThreadView.tsx:6380-6386`).
   - **Fetch it on thread select and on status change only. The link reads "Changes ›" until the count arrives (Task 5).**
9. **The Skills expanded row has no "path".** `SkillInfo` has no path field (`src/shared/ipc.ts:3066-3083`), and IPC changes are out of scope.
   - **The row keeps providers, coverage, tokens, source and Remove (Task 3).**
10. **The Memory review banner shows only for a non-empty queue.** Today an empty queue with auto-resolved pairs still shows a "Review" chip (`MemoryTab.tsx:705`, `:721-724`).
    - **Follow the spec. The activity line appears only inside an opened, non-empty queue (Task 7).**
11. **"Team: crew leads only" drops the worker's orchestrator back-link** (`AgentsPanel.tsx:3371-3381`, the `team?.kind === "worker"` branch at `:3362`). **Resolved: keep a lead link.**
    - **Task 6 replaces the worker-side Team section with one "Lead: <title> ›" line, shown for orchWorker threads whose lead exists in the same project (the existing `team.kind === "worker"` derivation) and clickable through `onSelectThread`. Workers also keep the "Worker" chip on the session line.**
12. **Team rows show no "diff size".** `ThreadSummaryInfo` carries none. The diff size is the "N changed files" on the Integration rows directly under Team (`src/components/CrewIntegration.tsx:215`).
    - **No new data (Task 6).**
13. **"Memory tools route to Settings" (spec Testing) needs an entry point the Memory section does not list.**
    - **Add a "Code map & config doctor ›" link to the Memory footer line (Task 7).**
14. **Task order.**
    - Splitting `SkillsTab` into `SkillsManager` (Settings) and the inspector list is one atomic refactor. So the "Skills & MCP" pane ships in the same task as the Skills tab rebuild: Task 3, right after the other Settings additions.
    - The header Fork / Hand off (Task 4) lands before the Environment rebuild (Task 5), so Fork is reachable from the header before the tab card goes.
    - Environment, Agents and Memory follow as Tasks 5–7.

## Global Constraints

Copied from the spec:
- "No IPC contract changes except the optional `threadIds` filter on `threads:summaries`. Moved components keep their existing props and API calls." (The filter already exists on the base branch.)
- "Errors keep the existing in-component error lines. Banners hide when their data fails to load and never show a stale count."
- "Empty sections are not rendered. Where a tab would be completely empty, it shows one short empty-state line."
- "One spacing and type scale in a shared CSS module. The tab CSS modules shrink accordingly."
- Out of scope:
  - "Merging tabs or changing their order or names."
  - "New features in moved components."
  - "The thread header and details card." Exception, decided by Willem on 2026-10-04: the header gains Fork / Hand off (Task 4). Nothing else in the header or details card changes.
- Environment order is fixed: Status header, Run, Checkpoints, Lanes. `src/envSectionOrder.ts` and its `coder.envSectionOrder` localStorage key are deleted, and a stale key is ignored. Nothing reads it, and nothing writes or clears it.
- Display uses the same `uiPrefs` keys: `coder.divergenceCard`, `coder.runDuration`, `coder.pasteCards`, `coder.composerVim`.
- Spotlight uses the existing `project.spotlight` field and the `setSpotlight` API.
- No new dependencies.
- Keep the perf branch's behaviour intact in every task that touches `AgentsContent`:
  - the project-scoped summaries fetch (`listThreadSummaries({ projectId })`) and its 5 s poll only while `rosterKey` has a working thread
  - the `isCrewLead`-keyed, 1 s debounced crew-integration effect
  - the `integrationSeq` guard in that effect and in the `CrewIntegration` `onIntegrate` / `onRefreshWorker` / `onVerify` / `onFinal` handlers
  - Tasks 5 and 6 only move JSX around these; they never edit the effects or handlers.

Engineering constraints:
- `tsc` runs with `noUnusedLocals` and `noUnusedParameters`.
  - A non-exported function, import or destructured prop that a task orphans **must be deleted in that same task**, or `npx tsc --noEmit` fails.
  - Exported leftovers, interface-only props and CSS wait for Task 8.
- Test files are not typechecked (`tsconfig.json` `include: ["src"]`). They run with `--experimental-strip-types`.
- Renderer test command (use it verbatim): `node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test <files>`
- `test/support/dom.ts` fails a test on any `console.error` while mounted.
- CSS-module breakage only shows in `npx vite build`. Run it in Task 9 and after any task that touched `*.module.css`.
- Worktree setup before the first test run (from the main checkout):
  ```bash
  cp -Rc ~/code/coder/node_modules ./node_modules
  cp -Rc ~/code/coder/core/node_modules ./core/node_modules
  cp -Rc ~/code/coder/memory-server/node_modules ./memory-server/node_modules
  cp -Rc ~/code/coder/core/dist ./core/dist
  ```

## File map

| File | Change |
|---|---|
| `src/components/InspectorSection.tsx` | **Create.** `InspectorSection`, `InspectorBanner`, `DataAttrs` |
| `src/components/Inspector.module.css` | **Create.** Shared spacing and type scale |
| `src/components/SettingsModal.tsx` | Display group, Spotlight, Project tools, new `skills` pane, project picker |
| `src/components/MemoryTab.tsx` | Export `MemoryProjectTools`. Tab: toolbar `+`, review banner, footer, no map or doctor |
| `src/components/SkillsTab.tsx` | Old body → `SkillsManager` (Settings). New small inspector `SkillsTab` |
| `src/components/SkillsTab.module.css` | `.manager`, filter menu classes |
| `src/components/ThreadView.tsx` | `HeaderForkControl`: Fork + Hand off to… in the header `.actions` row (Task 4) |
| `src/components/AgentsPanel.tsx` | Environment rebuild, Agents rebuild (Lead line for workers), tab plumbing, `onOpenSettings` |
| `src/App.tsx` | SettingsModal props, AgentsPanel `onOpenSettings` and `fetchDiff`, prop cleanup |
| `src/envSectionOrder.ts` | **Delete** (Task 8) |
| `src/components/skillsLibrary.ts` | Drop `SkillsView` (Task 8) |
| `src/uiPrefs.ts` | Comment only (Task 5) |
| Tests | Listed per task |

---

### Task 1: Shared `InspectorSection`, `InspectorBanner` and `Inspector.module.css`

**Files:**
- Create: `src/components/InspectorSection.tsx`
- Create: `src/components/Inspector.module.css`
- Test: `test/inspectorSection.test.tsx` (new)

**Interfaces:**
- Produces:
  ```ts
  export type DataAttrs = { [key: `data-${string}`]: string | undefined };
  export function InspectorSection(props: {
    title: string;
    count?: number;
    collapsible?: boolean;      // native <details>
    defaultOpen?: boolean;      // collapsible only; default true
    action?: ReactNode;         // drawn on non-collapsible sections only
    children?: ReactNode;       // null/false → renders nothing
  } & DataAttrs): JSX.Element | null;
  export function InspectorBanner(props: {
    text?: ReactNode;
    actionLabel: string;        // rendered as "<actionLabel> ›"
    onAction: () => void;
    actionProps?: DataAttrs & { "aria-label"?: string; title?: string; disabled?: boolean };
  } & DataAttrs): JSX.Element;
  ```
  Every section gets `aria-label={title}`. The count renders as `<span data-section-count>`.
- CSS classes for consumers (`import inspector from "./Inspector.module.css"`): `pane`, `section`, `head`, `title`, `count`, `action`, `chevron`, `body`, `block`, `subhead`, `row`, `line`, `muted`, `empty`, `banner`, `bannerText`, `bannerAction`, `footer`, `linkBtn`, `iconBtn`.

- [ ] **Step 1: Write the failing test.** Create `test/inspectorSection.test.tsx`:

```tsx
/**
 * Shared inspector building blocks (inspector tabs redesign).
 *
 * Run: node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test test/inspectorSection.test.tsx
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mount, unmountAll } from "./support/dom.ts";
import {
  InspectorBanner,
  InspectorSection,
} from "../src/components/InspectorSection";

afterEach(unmountAll);

describe("InspectorSection", () => {
  it("renders title, count, action and children in a labelled section", async () => {
    const m = await mount(
      <InspectorSection
        title="Run"
        count={3}
        action={<button type="button">Go</button>}
        data-probe=""
      >
        <p>body</p>
      </InspectorSection>,
    );
    const section = m.query("[data-probe]");
    assert.ok(section, "data-* attributes pass through");
    assert.equal(section.tagName, "SECTION");
    assert.equal(section.getAttribute("aria-label"), "Run");
    assert.equal(m.query("[data-section-count]")?.textContent, "3");
    assert.ok(m.byText("Go"), "action slot renders");
    assert.match(m.text(), /body/);
  });

  it("renders nothing without children", async () => {
    const m = await mount(
      <div data-host="">
        <InspectorSection title="Empty">{null}</InspectorSection>
        <InspectorSection title="False">{false}</InspectorSection>
      </div>,
    );
    assert.equal(m.query("[data-host]")?.innerHTML, "");
  });

  it("collapsible: honours defaultOpen and re-applies it when it changes", async () => {
    const el = (open: boolean) => (
      <InspectorSection
        title="Lanes"
        count={0}
        collapsible
        defaultOpen={open}
        data-probe=""
      >
        <p>lanes body</p>
      </InspectorSection>
    );
    const m = await mount(el(false));
    const details = m.query("[data-probe]") as HTMLDetailsElement;
    assert.equal(details.tagName, "DETAILS");
    assert.equal(details.open, false, "closed by default when asked");
    assert.match(m.query("summary")?.textContent ?? "", /Lanes\s*0/);
    assert.match(m.text(), /lanes body/, "body stays in the DOM while closed");
    await m.rerender(el(true));
    assert.equal(details.open, true, "opens when defaultOpen flips");
  });
});

describe("InspectorBanner", () => {
  it("shows text and a › action, and passes data attributes through", async () => {
    let hits = 0;
    const m = await mount(
      <InspectorBanner
        data-probe=""
        text="2 skills out of sync"
        actionLabel="Sync"
        onAction={() => {
          hits += 1;
        }}
        actionProps={{ "aria-label": "Sync missing skills", "data-act": "" }}
      />,
    );
    const banner = m.query("[data-probe]");
    assert.ok(banner);
    assert.match(banner.textContent ?? "", /2 skills out of sync/);
    const btn = m.query("[data-act]") as HTMLButtonElement;
    assert.equal(btn.textContent, "Sync ›");
    assert.equal(btn.getAttribute("aria-label"), "Sync missing skills");
    await m.click(btn);
    assert.equal(hits, 1);
  });

  it("can be a single action with no leading text", async () => {
    const m = await mount(
      <InspectorBanner
        data-probe=""
        actionLabel="1 memory needs review"
        onAction={() => {}}
      />,
    );
    assert.equal(m.query("[data-probe]")?.textContent, "1 memory needs review ›");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails.**
Run: `node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test test/inspectorSection.test.tsx`
Expected: FAIL with `Cannot find module '.../src/components/InspectorSection'`.

- [ ] **Step 3: Create `src/components/Inspector.module.css`.**

```css
/*
 * Shared inspector spacing and type scale (inspector tabs redesign).
 * Every tab builds on these; per-tab modules keep only what is unique.
 */

.pane {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding: 4px 14px 16px;
}

.section {
  display: block;
  min-width: 0;
  padding: 12px 0;
  border-top: 1px solid var(--border-soft);
}

.pane > .section:first-child {
  border-top: none;
}

.head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 20px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

summary.head {
  cursor: pointer;
  list-style: none;
  border-radius: var(--radius-sm);
}

summary.head::-webkit-details-marker {
  display: none;
}

summary.head:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.count {
  color: var(--text-dim);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.action {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 400;
}

.chevron {
  flex-shrink: 0;
  color: var(--text-dim);
  transition: transform 0.12s ease;
}

details[open] > summary .chevron {
  transform: rotate(90deg);
}

.body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  margin-top: 8px;
}

.block {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.subhead {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
}

.row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 10px;
  min-width: 0;
}

.line {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-muted);
  min-width: 0;
  overflow-wrap: anywhere;
}

.muted {
  color: var(--text-dim);
}

.empty {
  margin: 24px 8px;
  color: var(--text-dim);
  font-size: 12px;
  text-align: center;
}

.banner {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0 0;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  background: var(--blue-soft);
  color: var(--text);
  font-size: 12px;
}

.bannerText {
  min-width: 0;
}

.bannerAction {
  margin-left: auto;
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  font-weight: 600;
  color: var(--info-fg);
  cursor: pointer;
  white-space: nowrap;
}

.bannerAction:only-child {
  margin-left: 0;
}

.bannerAction:hover:not(:disabled) {
  color: var(--info-fg-strong);
}

.bannerAction:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.bannerAction:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
  border-radius: var(--radius-sm);
}

.footer {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 10px;
  padding: 10px 14px;
  border-top: 1px solid var(--border-soft);
  color: var(--text-muted);
  font-size: 12px;
}

.linkBtn {
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  color: var(--text-muted);
  cursor: pointer;
  white-space: nowrap;
}

.linkBtn:hover:not(:disabled) {
  color: var(--text);
}

.linkBtn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.linkBtn:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
  border-radius: var(--radius-sm);
}

.iconBtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text-muted);
  cursor: pointer;
}

.iconBtn:hover:not(:disabled) {
  color: var(--text);
  background: var(--card-hover);
}

.iconBtn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.iconBtn:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
```

- [ ] **Step 4: Create `src/components/InspectorSection.tsx`.**

```tsx
import type { ReactNode } from "react";
import styles from "./Inspector.module.css";

/** `data-*` passthrough so callers and tests keep their hooks. */
export type DataAttrs = { [key: `data-${string}`]: string | undefined };

/**
 * One inspector section: title, optional count, optional collapse, optional
 * right-aligned action, children. Renders nothing without children, so an
 * empty section never paints a bare heading.
 *
 * Collapse is a native <details>: no state, keyboard and a11y come free.
 * `defaultOpen` applies on mount and again whenever it changes; a manual
 * toggle sticks in between. `action` is drawn on non-collapsible sections
 * only, because a button inside <summary> would toggle the section.
 */
export function InspectorSection({
  title,
  count,
  collapsible = false,
  defaultOpen = true,
  action,
  children,
  ...data
}: {
  title: string;
  count?: number;
  collapsible?: boolean;
  defaultOpen?: boolean;
  action?: ReactNode;
  children?: ReactNode;
} & DataAttrs) {
  if (children == null || children === false) return null;
  const label = (
    <>
      <span className={styles.title}>{title}</span>
      {count != null ? (
        <span className={styles.count} data-section-count="">
          {count}
        </span>
      ) : null}
    </>
  );
  if (collapsible) {
    return (
      <details
        className={styles.section}
        open={defaultOpen}
        aria-label={title}
        {...data}
      >
        <summary className={styles.head}>
          <svg
            className={styles.chevron}
            width="9"
            height="9"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M3.5 2 6.5 5 3.5 8" />
          </svg>
          {label}
        </summary>
        <div className={styles.body}>{children}</div>
      </details>
    );
  }
  return (
    <section className={styles.section} aria-label={title} {...data}>
      <div className={styles.head}>
        {label}
        {action ? <span className={styles.action}>{action}</span> : null}
      </div>
      <div className={styles.body}>{children}</div>
    </section>
  );
}

/** One-line notice with a › action (memory review queue, skill drift). */
export function InspectorBanner({
  text,
  actionLabel,
  onAction,
  actionProps,
  ...data
}: {
  text?: ReactNode;
  actionLabel: string;
  onAction: () => void;
  actionProps?: DataAttrs & {
    "aria-label"?: string;
    title?: string;
    disabled?: boolean;
  };
} & DataAttrs) {
  return (
    <div className={styles.banner} role="status" {...data}>
      {text != null ? <span className={styles.bannerText}>{text}</span> : null}
      <button
        type="button"
        className={styles.bannerAction}
        onClick={onAction}
        {...actionProps}
      >
        {actionLabel} ›
      </button>
    </div>
  );
}
```

- [ ] **Step 5: Run the test and typecheck.**
Run: `node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test test/inspectorSection.test.tsx && npx tsc --noEmit`
Expected: 5 pass, 0 fail. tsc prints nothing.

- [ ] **Step 6: Commit.**
```bash
git add src/components/InspectorSection.tsx src/components/Inspector.module.css test/inspectorSection.test.tsx
git commit -m "Add shared InspectorSection and InspectorBanner for the inspector tabs"
```

---

### Task 2: Settings additions: Display, Spotlight and Project tools

The tab copies stay in place until Tasks 5 and 7, so every item is reachable in both places in between.

**Files:**
- Modify: `src/components/MemoryTab.tsx`. Add `MemoryProjectToolsApi` and `MemoryProjectTools` after `ConfigDoctorCard`, which ends at line 630. Swap the two cards inside `secondary` (lines 1215-1231) for `<MemoryProjectTools>`.
- Modify: `src/components/SettingsModal.tsx`:
  - imports (lines 15-45)
  - `PANE_META` hints and keywords (lines 64-101)
  - `SettingsModalProps` (lines 121-155)
  - destructuring (lines 344-364)
  - state (after line 389) and the open effect (line 429)
  - JSX after the Git `WorktreeGcSection` block (ends line 1947), after the Memory section (ends line 1991) and after the General section (ends line 2455)
  - new components after `PaneIcon` (ends line 2531)
- Modify: `src/App.tsx`, the `<SettingsModal` element (anchor `onForgetConnection={(input) => api.app.forgetRemoteConnection(input)}`).
- Test: `test/settingsModal.test.tsx` (helper and three new `describe` blocks).

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  ```ts
  // src/components/MemoryTab.tsx
  export interface MemoryProjectToolsApi {
    loadCodeMap?: (input: { projectId: string }) => Promise<ProjectCodeMap>;
    lintAgentConfig?: (input: { projectId: string }) => Promise<AgentConfigDoctorReport>;
    previewAgentConfig?: (input: { projectId: string; targets?: string[] }) => Promise<AgentConfigPreview>;
    writeAgentConfig?: (input: { projectId: string; targets?: string[] }) => Promise<AgentConfigWriteResult>;
  }
  export function MemoryProjectTools(props: { projectId: string; projectSlug: string | null } & MemoryProjectToolsApi): JSX.Element | null;
  // src/components/SettingsModal.tsx — new optional props
  currentProjectId?: string | null;
  onSetSpotlight?: (input: { projectId: string; enabled: boolean }) => Promise<MergeSpotlight>;
  projectTools?: MemoryProjectToolsApi;
  ```
- New DOM hooks:
  - `[data-display-prefs]` with `[data-divergence-pref]`, `[data-run-duration-pref]`, `[data-paste-cards-pref]` and `[data-composer-vim-pref]`
  - `[data-spotlight-settings]` with `[data-project-picker="spotlight-project"]` and `[data-lane-spotlight]`
  - `[data-project-tools]` with `[data-project-picker="project-tools-project"]`
  - `[data-memory-project-tools]`

- [ ] **Step 1: Extend the test helper.** In `test/settingsModal.test.tsx`, change the imports at the top to:

```tsx
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { useState } from "react";
import { mount, unmountAll } from "./support/dom.ts";
import { SettingsModal, type SettingsPane } from "../src/components/SettingsModal";
import type { MemoryProjectToolsApi } from "../src/components/MemoryTab";
import {
  getComposerVimEnabled,
  getDivergenceCardEnabled,
  getPasteCardsEnabled,
  getRunDurationEnabled,
  setComposerVimEnabled,
  setDivergenceCardEnabled,
  setPasteCardsEnabled,
  setRunDurationEnabled,
} from "../src/uiPrefs";
import type {
  AgentConfigDoctorReport,
  AppSettings,
  AppStatus,
  MergeSpotlight,
  ProjectInfo,
  ProviderInfo,
  SubagentPool,
  WebhookTestResult,
} from "../src/shared/ipc";
```

Add four fields to `interface Stubs`, after `onClose?: () => void;`:

```tsx
  projects?: ProjectInfo[];
  currentProjectId?: string | null;
  onSetSpotlight?: (input: {
    projectId: string;
    enabled: boolean;
  }) => Promise<MergeSpotlight>;
  projectTools?: MemoryProjectToolsApi;
```

In `function modal(...)`, add these props after `onTestWebhook={stubs.onTestWebhook}`:

```tsx
      projects={stubs.projects}
      currentProjectId={stubs.currentProjectId}
      onSetSpotlight={stubs.onSetSpotlight}
      projectTools={stubs.projectTools}
```

- [ ] **Step 2: Write the failing tests.** Append to `test/settingsModal.test.tsx`:

```tsx
function proj(over: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: "p1",
    slug: "acme/one",
    name: "one",
    path: "/tmp/one",
    ...over,
  } as ProjectInfo;
}

const DOCTOR_REPORT: AgentConfigDoctorReport = {
  projectId: "p1",
  files: [
    {
      path: "AGENTS.md",
      bytes: 120,
      score: 42,
      grade: "D",
      axes: [],
      issues: [],
      recommendations: [],
    },
  ],
  score: 42,
  grade: "D",
  memory: {
    considered: 3,
    covered: 1,
    missing: [
      { id: "c1", type: "convention", title: "Fail closed on worktrees" },
    ],
  },
  issues: [],
  recommendations: [],
};

// Moved from test/environmentCards.test.tsx "display prefs card (#779)".
describe("SettingsModal Display group (moved from Environment)", () => {
  afterEach(() => {
    setDivergenceCardEnabled(false);
    setRunDurationEnabled(false);
    setPasteCardsEnabled(true);
    setComposerVimEnabled(false);
  });

  it("offers vim motions off by default", async () => {
    setComposerVimEnabled(false);
    const m = await mount(modal());
    const card = m.query("[data-display-prefs]");
    assert.ok(card, "Display group on General");
    const box = card.querySelector(
      "[data-composer-vim-pref]",
    ) as HTMLInputElement | null;
    assert.ok(box, "vim motions checkbox");
    assert.equal(box.checked, false);
    assert.equal(getComposerVimEnabled(), false);
    assert.match(card.textContent || "", /Vim motions in the composer/);
  });

  it("turns the pref on from the Display group", async () => {
    setComposerVimEnabled(false);
    const m = await mount(modal());
    const box = m.query("[data-composer-vim-pref]") as HTMLInputElement;
    await m.click(box);
    assert.equal(box.checked, true);
    assert.equal(getComposerVimEnabled(), true);
  });

  it("toggles the same uiPrefs keys the Environment card used", async () => {
    setDivergenceCardEnabled(false);
    setRunDurationEnabled(false);
    setPasteCardsEnabled(true);
    const m = await mount(modal());
    await m.click(m.query("[data-divergence-pref]"));
    await m.click(m.query("[data-run-duration-pref]"));
    await m.click(m.query("[data-paste-cards-pref]"));
    assert.equal(getDivergenceCardEnabled(), true);
    assert.equal(getRunDurationEnabled(), true);
    assert.equal(getPasteCardsEnabled(), false);
    assert.equal(window.localStorage.getItem("coder.divergenceCard"), "on");
    assert.equal(window.localStorage.getItem("coder.runDuration"), "on");
    assert.equal(window.localStorage.getItem("coder.pasteCards"), "off");
  });
});

// The opt-in half of mergeQueueChips "opts into Spotlight per repo" moved here.
describe("SettingsModal Spotlight (moved from the Lanes card)", () => {
  it("defaults to the selected thread's project and toggles through setSpotlight", async () => {
    const calls: Array<{ projectId: string; enabled: boolean }> = [];
    const m = await mount(
      modal({
        initialPane: "git",
        projects: [proj(), proj({ id: "p2", name: "two", path: "/tmp/two" })],
        currentProjectId: "p2",
        onSetSpotlight: async (input) => {
          calls.push(input);
          return { spotlight: input.enabled };
        },
      }),
    );
    const picker = m.query(
      '[data-project-picker="spotlight-project"]',
    ) as HTMLSelectElement;
    assert.ok(picker, "Spotlight has a project picker");
    assert.equal(picker.value, "p2");
    const box = m.query("[data-lane-spotlight]") as HTMLInputElement;
    assert.equal(box.checked, false);
    await m.click(box);
    assert.deepEqual(calls, [{ projectId: "p2", enabled: true }]);
    assert.equal(
      (m.query("[data-lane-spotlight]") as HTMLInputElement).checked,
      true,
    );
    await m.change(picker, "p1");
    await m.click(m.query("[data-lane-spotlight]"));
    assert.deepEqual(calls[1], { projectId: "p1", enabled: true });
  });

  it("shows the saved flag and leaves remote projects out", async () => {
    const m = await mount(
      modal({
        initialPane: "git",
        projects: [
          proj({ id: "r1", name: "remote", remoteHost: "dev@box" }),
          proj({ spotlight: true }),
        ],
        onSetSpotlight: async (input) => ({ spotlight: input.enabled }),
      }),
    );
    const picker = m.query(
      '[data-project-picker="spotlight-project"]',
    ) as HTMLSelectElement;
    assert.deepEqual(
      [...picker.options].map((o) => o.value),
      ["p1"],
      "lanes are local-only",
    );
    assert.equal(
      (m.query("[data-lane-spotlight]") as HTMLInputElement).checked,
      true,
      "opt-in is checked when the project flag is on",
    );
  });

  it("is absent without a setter", async () => {
    const m = await mount(modal({ initialPane: "git", projects: [proj()] }));
    assert.equal(m.query("[data-spotlight-settings]"), null);
  });
});

describe("SettingsModal Project tools (moved from the Memory tab)", () => {
  it("defaults to the selected thread's project, under the server status", async () => {
    const linted: string[] = [];
    const m = await mount(
      modal({
        initialPane: "memory",
        status: status({ memory: { entries: 12 } }),
        projects: [proj(), proj({ id: "p2", name: "two", path: "/tmp/two" })],
        currentProjectId: "p2",
        projectTools: {
          lintAgentConfig: async (input) => {
            linted.push(input.projectId);
            return { ...DOCTOR_REPORT, projectId: input.projectId };
          },
          loadCodeMap: async (input) => ({
            projectId: input.projectId,
            updatedAt: Date.now(),
            fileCount: 0,
            symbolCount: 0,
            modules: [],
            dependencies: [],
          }),
        },
      }),
    );
    const tools = m.query("[data-project-tools]");
    assert.ok(tools, "Project tools section on the Memory pane");
    assert.match(tools.textContent ?? "", /Project tools/);
    assert.ok(m.text().includes("12 entries"), "server status still renders");
    const pane = m.query('[data-settings-pane="memory"]')!;
    assert.ok(
      pane.textContent!.indexOf("12 entries") <
        pane.textContent!.indexOf("Project tools"),
      "server status stays at the top of the pane",
    );
    const picker = m.query(
      '[data-project-picker="project-tools-project"]',
    ) as HTMLSelectElement;
    assert.equal(picker.value, "p2");
    assert.ok(tools.querySelector("[data-code-map]"), "code map moved here");
    await m.click(m.query("[data-config-doctor] summary"));
    assert.deepEqual(linted, ["p2"]);
    await m.change(picker, "p1");
    assert.equal(linted.at(-1), "p1", "doctor follows the picked project");
  });

  it("falls back to the first project when no thread is selected", async () => {
    const m = await mount(
      modal({
        initialPane: "memory",
        projects: [proj(), proj({ id: "p2", name: "two", path: "/tmp/two" })],
        projectTools: { lintAgentConfig: async () => DOCTOR_REPORT },
      }),
    );
    assert.equal(
      (
        m.query(
          '[data-project-picker="project-tools-project"]',
        ) as HTMLSelectElement
      ).value,
      "p1",
    );
  });

  it("is absent without projects or tools", async () => {
    const none = await mount(modal({ initialPane: "memory" }));
    assert.equal(none.query("[data-project-tools]"), null);
    none.unmount();
    const noTools = await mount(
      modal({ initialPane: "memory", projects: [proj()] }),
    );
    assert.equal(noTools.query("[data-project-tools]"), null);
  });
});
```

- [ ] **Step 3: Run the new tests to make sure they fail.**
Run: `node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test test/settingsModal.test.tsx`
Expected: the nine new tests FAIL (for example, `Display group on General` is not ok). Every existing test still passes.

- [ ] **Step 4: Export `MemoryProjectTools` from `src/components/MemoryTab.tsx`.** Insert after `ConfigDoctorCard` (its closing `}` is line 630), before `function ReviewQueueCard`:

```tsx
/** Code map + config doctor callbacks (Settings → Memory → Project tools). */
export interface MemoryProjectToolsApi {
  loadCodeMap?: (input: { projectId: string }) => Promise<ProjectCodeMap>;
  lintAgentConfig?: (input: {
    projectId: string;
  }) => Promise<AgentConfigDoctorReport>;
  previewAgentConfig?: (input: {
    projectId: string;
    targets?: string[];
  }) => Promise<AgentConfigPreview>;
  writeAgentConfig?: (input: {
    projectId: string;
    targets?: string[];
  }) => Promise<AgentConfigWriteResult>;
}

/**
 * One project's code map and config doctor. Both stay lazy disclosures
 * (#1123), and both handle a projectId change in place (#1136), so the
 * Settings picker can swap projects without a key.
 */
export function MemoryProjectTools({
  projectId,
  projectSlug,
  loadCodeMap,
  lintAgentConfig,
  previewAgentConfig,
  writeAgentConfig,
}: { projectId: string; projectSlug: string | null } & MemoryProjectToolsApi) {
  if (!loadCodeMap && !lintAgentConfig) return null;
  return (
    <div className={styles.secondary} data-memory-project-tools="">
      {loadCodeMap ? (
        <CodeMapCard projectId={projectId} loadCodeMap={loadCodeMap} />
      ) : null}
      {lintAgentConfig ? (
        <ConfigDoctorCard
          projectId={projectId}
          projectLabel={projectLabelOf(projectSlug, projectId)}
          lintAgentConfig={lintAgentConfig}
          previewAgentConfig={previewAgentConfig}
          writeAgentConfig={writeAgentConfig}
        />
      ) : null}
    </div>
  );
}
```

Then, inside `MemoryTab`, replace the `mapCard` constant and the first two children of `secondary` (lines 1215-1231, from `  const mapCard =` through the `) : null}` that closes `ConfigDoctorCard`) with:

```tsx
  const secondary = (
    <div className={styles.secondary} data-memory-secondary="">
      {projectId ? (
        <MemoryProjectTools
          projectId={projectId}
          projectSlug={projectSlug}
          loadCodeMap={loadCodeMap}
          lintAgentConfig={lintAgentConfig}
          previewAgentConfig={previewAgentConfig}
          writeAgentConfig={writeAgentConfig}
        />
      ) : null}
```

Keep the `{maintenanceMemory ? (<ReviewQueueCard … />) : null}` child and the closing `</div>` and `);` unchanged.

- [ ] **Step 5: Add the Settings pieces to `src/components/SettingsModal.tsx`.**

5a. Imports. Add `MergeSpotlight` to the `import type { … } from "../shared/ipc"` list (keep it alphabetical after `GcScanResult`). Below `import { useModalFocus } from "../useModalFocus";`, add:

```tsx
import {
  setComposerVimEnabled,
  setDivergenceCardEnabled,
  setPasteCardsEnabled,
  setRunDurationEnabled,
  useComposerVimEnabled,
  useDivergenceCardEnabled,
  usePasteCardsEnabled,
  useRunDurationEnabled,
} from "../uiPrefs";
import { MemoryProjectTools, type MemoryProjectToolsApi } from "./MemoryTab";
```

5b. In `PANE_META`, update three entries:

```tsx
  general: {
    label: "General",
    hint: "Display, notifications, the welcome tour, and this build.",
    keywords:
      "notifications tour welcome update version build channel nightly prod felt estimate time saved webhook slack discord ntfy push phone agents panel sidebar collapse remember last quit confirm accidental close display divergence compare run duration paste cards vim motions",
  },
```

```tsx
  git: {
    label: "Git",
    hint: "Source control, Linear tickets, PR size, worktree disk, and Spotlight.",
    keywords:
      "github gitlab bitbucket azure source control pr pull request worktree gc disk cleanup linear ticket api key spotlight lanes preview",
  },
```

```tsx
  memory: {
    label: "Memory",
    hint: "The local memory server, plus each project's code map and config doctor.",
    keywords: "memory entries vectors janitor server port embed code map config doctor agents.md claude.md project tools",
  },
```

5c. In `interface SettingsModalProps`, add after `onForgetConnection?: …;`:

```tsx
  /** Project picker default for Spotlight and Project tools: the selected thread's project. */
  currentProjectId?: string | null;
  /** Per-project Spotlight opt-in (moved from the Environment Lanes card). */
  onSetSpotlight?: (input: {
    projectId: string;
    enabled: boolean;
  }) => Promise<MergeSpotlight>;
  /** Code map + config doctor (moved from the Memory tab). */
  projectTools?: MemoryProjectToolsApi;
```

5d. In the `SettingsModal({ … })` destructuring, add after `onForgetConnection,`:

```tsx
  currentProjectId = null,
  onSetSpotlight,
  projectTools,
```

5e. After `const [downloadingUpdate, setDownloadingUpdate] = useState(false);`, add:

```tsx
  /** Shared by Git → Spotlight and Memory → Project tools; reset on open. */
  const [toolsProjectId, setToolsProjectId] = useState<string | null>(null);
```

Inside `if (justOpened) {`, add after `setPane(isSettingsPane(initialPane) ? initialPane : "general");`:

```tsx
      setToolsProjectId(currentProjectId);
```

After `const paneMeta = PANE_META[pane];`, add:

```tsx
  const toolsProject =
    projects?.find((p) => p.id === toolsProjectId) ?? projects?.[0] ?? null;
```

5f. JSX. After the Git `WorktreeGcSection` block (the `)}` that closes `{pane === "git" && (<WorktreeGcSection … />` at line 1947), insert:

```tsx

          {pane === "git" && onSetSpotlight && projects && (
          <SpotlightSection
            projects={projects}
            value={toolsProjectId}
            onPick={setToolsProjectId}
            onSetSpotlight={onSetSpotlight}
          />
          )}
```

After the Memory section (the `)}` at line 1991, right after `Shared memory is project-scoped …</p></section>`), insert:

```tsx

          {pane === "memory" && projectTools && projects && toolsProject && (
          <section className={styles.section} data-project-tools="">
            <h3 className={styles.sectionLabel}>Project tools</h3>
            <ProjectPicker
              id="project-tools-project"
              projects={projects}
              value={toolsProject.id}
              onChange={setToolsProjectId}
            />
            <MemoryProjectTools
              projectId={toolsProject.id}
              projectSlug={toolsProject.path}
              {...projectTools}
            />
          </section>
          )}
```

After the General section (the `)}` at line 2455, right after the `Update failed:` block's `</section>`), insert:

```tsx

          {pane === "general" && <DisplayPrefsSection />}
```

5g. Add three components right after `function PaneIcon(…) { … }` (before `function ProfileForm`):

```tsx
/** Display prefs (moved from the Environment tab). Same uiPrefs keys. */
function DisplayPrefsSection() {
  const divergence = useDivergenceCardEnabled();
  const runDuration = useRunDurationEnabled();
  const pasteCards = usePasteCardsEnabled();
  const composerVim = useComposerVimEnabled();
  return (
    <section className={styles.section} data-display-prefs="">
      <h3 className={styles.sectionLabel}>Display</h3>
      <label className={styles.fieldRow}>
        <input
          type="checkbox"
          data-divergence-pref=""
          checked={divergence}
          onChange={(e) => setDivergenceCardEnabled(e.target.checked)}
        />
        <span>Show divergence compare on threads</span>
      </label>
      <label className={styles.fieldRow}>
        <input
          type="checkbox"
          data-run-duration-pref=""
          checked={runDuration}
          onChange={(e) => setRunDurationEnabled(e.target.checked)}
        />
        <span>Show time spent at the end of a run</span>
      </label>
      <label className={styles.fieldRow}>
        <input
          type="checkbox"
          data-paste-cards-pref=""
          checked={pasteCards}
          onChange={(e) => setPasteCardsEnabled(e.target.checked)}
        />
        <span>Collapse large pastes into cards</span>
      </label>
      <label className={styles.fieldRow}>
        <input
          type="checkbox"
          data-composer-vim-pref=""
          checked={composerVim}
          onChange={(e) => setComposerVimEnabled(e.target.checked)}
        />
        <span>Vim motions in the composer</span>
      </label>
    </section>
  );
}

function ProjectPicker({
  id,
  projects,
  value,
  onChange,
}: {
  id: string;
  projects: ProjectInfo[];
  value: string;
  onChange: (projectId: string) => void;
}) {
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor={id}>
        Project
      </label>
      <select
        id={id}
        className={styles.input}
        data-project-picker={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Per-project Spotlight opt-in (moved from the Environment Lanes card).
 * Lanes are local-only, so remote projects are not offered.
 */
function SpotlightSection({
  projects,
  value,
  onPick,
  onSetSpotlight,
}: {
  projects: ProjectInfo[];
  value: string | null;
  onPick: (projectId: string) => void;
  onSetSpotlight: (input: {
    projectId: string;
    enabled: boolean;
  }) => Promise<MergeSpotlight>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Shown until useCoder's projects.list refresh brings the saved flag back.
  const [saved, setSaved] = useState<{
    projectId: string;
    enabled: boolean;
  } | null>(null);
  const local = projects.filter((p) => !p.remoteHost);
  const project = local.find((p) => p.id === value) ?? local[0] ?? null;
  if (!project) return null;
  const checked =
    saved?.projectId === project.id ? saved.enabled : project.spotlight === true;
  return (
    <section className={styles.section} data-spotlight-settings="">
      <h3 className={styles.sectionLabel}>Spotlight</h3>
      <ProjectPicker
        id="spotlight-project"
        projects={local}
        value={project.id}
        onChange={onPick}
      />
      <label className={styles.fieldRow}>
        <input
          type="checkbox"
          data-lane-spotlight=""
          checked={checked}
          disabled={busy}
          onChange={(e) => {
            const enabled = e.target.checked;
            const projectId = project.id;
            setBusy(true);
            setError(null);
            void onSetSpotlight({ projectId, enabled })
              .then(() => setSaved({ projectId, enabled }))
              .catch((err) =>
                setError(
                  err instanceof Error && err.message
                    ? err.message
                    : "Failed to save Spotlight",
                ),
              )
              .finally(() => setBusy(false));
          }}
        />
        <span>Preview lanes on the project checkout</span>
      </label>
      <p className={styles.note}>
        When on, Preview on the Environment Lanes section hot-swaps the
        claimed lane onto this project&apos;s checkout, so one running app
        serves whichever lane you pick.
      </p>
      {error ? (
        <p className={styles.fieldError} role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
```

- [ ] **Step 6: Wire App.** In `src/App.tsx`, in the `<SettingsModal` element, add these lines right after the anchor `onForgetConnection={(input) => api.app.forgetRemoteConnection(input)}`:

```tsx
          projects={projects}
          currentProjectId={project?.id ?? null}
          onSetSpotlight={setSpotlight}
          projectTools={{
            loadCodeMap,
            lintAgentConfig,
            previewAgentConfig,
            writeAgentConfig,
          }}
```

(`projects`, `project`, `setSpotlight`, `loadCodeMap`, `lintAgentConfig`, `previewAgentConfig` and `writeAgentConfig` are already in scope. `project` is the `const project = …` near the `visibleDetail` declaration. Passing `projects` also gives `IntegrationsSection` and `WorktreeGcSection` the real list instead of their `window.coder` fallback.)

- [ ] **Step 7: Run the tests and typecheck.**
Run: `npx tsc --noEmit && node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test test/settingsModal.test.tsx test/memoryTab.test.tsx test/environmentCards.test.tsx test/mergeQueueChips.test.tsx test/appWiring.test.tsx`
Expected: tsc clean, 0 fail. `memoryTab.test.tsx` is unchanged and green, because `MemoryTab` still renders map and doctor through `MemoryProjectTools`.

- [ ] **Step 8: Commit.**
```bash
git add src/components/MemoryTab.tsx src/components/SettingsModal.tsx src/App.tsx test/settingsModal.test.tsx
git commit -m "Settings: Display group, per-project Spotlight and Project tools"
```

---
### Task 3: Settings → "Skills & MCP" pane, and the rebuilt Skills tab

The pane and the tab ship together: the old `SkillsTab` body becomes `SkillsManager` (Settings), and a new small `SkillsTab` keeps only the installed list. See spec discrepancy 14.

**Files:**
- Modify: `src/components/SkillsTab.tsx`. Line numbers are from the unchanged file. Apply the edits bottom-up.
- Modify: `src/components/SkillsTab.module.css` (append)
- Modify: `src/components/SettingsModal.tsx`:
  - `SETTINGS_PANES` (lines 47-57)
  - `PANE_META`
  - props, destructuring and JSX
  - `PaneIcon`
- Modify: `src/components/AgentsPanel.tsx`:
  - `AgentsPanelProps` (lines 195-366)
  - `AgentsPanel` destructuring (lines 3551-3632)
  - the `tab === "skills"` branch (lines 3810-3838)
  - a type import
- Modify: `src/App.tsx`: `<AgentsPanel` (add `onOpenSettings`) and `<SettingsModal` (add `skills`)
- Test: `test/skillsTab.test.tsx`, `test/settingsModal.test.tsx`, `test/appWiring.test.tsx`

**Interfaces:**
- Consumes: `InspectorBanner` and `DataAttrs` (Task 1). The `currentProjectId` and `projects` `SettingsModal` props from Task 2.
- Produces:
  ```ts
  // src/components/SkillsTab.tsx
  export interface SkillsManagerProps {           // old SkillsTabProps minus settings, saveSettings, removeSkill, syncSkills
    projectPath: string | null;
    listMcpServers; saveMcpServer; removeMcpServer; setMcpEnabled; listMcpCatalog;
    pickMcpImport; previewMcpImport; installMcpImport; discardMcpImport;
    listSkills; addSkill; listSkillCatalog; pickSkillImport; previewSkillImport;
    installSkillImport; discardSkillImport; detectHarnessSources;
    previewHarnessImport; installHarnessImport; discardHarnessImport;   // same signatures as today
  }
  export function SkillsManager(props: SkillsManagerProps): JSX.Element;
  export interface SkillsTabProps {
    projectPath: string | null;
    listSkills: (input?: { projectPath?: string }) => Promise<SkillInfo[]>;
    removeSkill: (input: { name: string }) => Promise<void>;
    syncSkills: () => Promise<{ copied: number; skills: string[] }>;
    onManage?: () => void;
  }
  export function SkillsTab(props: SkillsTabProps): JSX.Element;
  // SettingsModal
  export const SETTINGS_PANES: [..., "memory", "skills", "connections", ...];
  skills?: Omit<SkillsManagerProps, "projectPath">;   // new prop
  // AgentsPanel
  onOpenSettings?: (pane?: SettingsPane) => void;     // new prop
  ```
- New DOM hooks:
  - `[data-skills-manager]`
  - `[data-skills-filter-menu]`
  - `[data-skills-manage]`
  - `[data-skills-drift]`
  - `[data-settings-nav="skills"]`

**Existing tests that assert removed UI, and where they go:**

All in `test/skillsTab.test.tsx`:
- **The four view buttons (`data-skills-view-btn`) and the 11 chips.**
  - The `openSkillsView` helper becomes a surface assertion.
  - The 45 catalog/MCP/add-only mounts switch to `ManagerHarness` (sed in Step 2).
  - The chip selectors (`data-source-filter`, `data-provider-filter`) survive on the filter-menu checkbox labels, so `"composes provider and source filters…"` (line 2843) is unchanged.
- **These tests mix the library with catalog or MCP. Each is split into an inspector mount and a Settings mount, with every assertion kept (Step 3):**
  - "renders installed skills first; MCP stays on a secondary view" (521)
  - "keeps curated, added, and project skills…" (1400)
  - "loads catalog independently…" (1456)
  - "keeps catalog rows when installed skills fail…" (1485)
  - "does not mention catalog unavailable…" (1505)
  - "falls back to installed curated skills…" (1528)
  - "does not treat an added skill as curated…" (1581)
  - "shows curated loading…" (1612)
  - "labels catalog source links…" (2200)
  - "preserves search when moving between library and catalog" (2882)
- **The always-visible Sync button.** Two tests change:
  - "Sync calls skills.sync…" (1323): the button now lives in the drift banner, and "Sync disables once nothing has drift" becomes "banner hides once nothing has drift".
  - "disables Sync when no skill has drift" (1369) becomes "no drift banner".
- **"installs the selection, reloads lists…" (1883).** Settings shows the catalog, so the two `catalogs.length === 0` assertions become 1 (load on open) and 2 (reload after install).

- [ ] **Step 1: Write the failing Settings and App tests.**

In `test/settingsModal.test.tsx`:
- add `import type { SkillsManagerProps } from "../src/components/SkillsTab";`
- add `skills?: Omit<SkillsManagerProps, "projectPath">;` to `interface Stubs`
- add `skills={stubs.skills}` to `modal()` next to `projectTools={stubs.projectTools}`

Then append:

```tsx
function skillsApi(calls: string[]): Omit<SkillsManagerProps, "projectPath"> {
  const unused = async (): Promise<never> => {
    throw new Error("unused");
  };
  return {
    listMcpServers: async () => {
      calls.push("mcp");
      return [];
    },
    saveMcpServer: unused,
    removeMcpServer: async () => {},
    setMcpEnabled: unused,
    listMcpCatalog: async () => [],
    pickMcpImport: async () => null,
    previewMcpImport: unused,
    installMcpImport: async () => ({ installed: [] }),
    discardMcpImport: async () => {},
    listSkills: async (input) => {
      calls.push(`skills:${input?.projectPath ?? ""}`);
      return [];
    },
    addSkill: async (input) => ({ name: input.name, installedIn: [] }),
    listSkillCatalog: async () => {
      calls.push("catalog");
      return [];
    },
    pickSkillImport: async () => null,
    previewSkillImport: unused,
    installSkillImport: async () => ({ installed: [], plugins: [] }),
    discardSkillImport: async () => {},
    detectHarnessSources: async () => {
      calls.push("harness");
      return [];
    },
    previewHarnessImport: unused,
    installHarnessImport: async () => ({
      skills: [],
      commands: [],
      mcp: [],
      memories: [],
      instructions: [],
      settings: null,
      plugins: [],
    }),
    discardHarnessImport: async () => {},
  };
}

describe("SettingsModal Skills & MCP pane (moved from the Skills tab)", () => {
  it("renders catalog, MCP servers, import and Add skill, scoped to the current project", async () => {
    const calls: string[] = [];
    const m = await mount(
      modal({
        initialPane: "skills",
        projects: [proj(), proj({ id: "p2", name: "two", path: "/tmp/two" })],
        currentProjectId: "p2",
        skills: skillsApi(calls),
      }),
    );
    assert.equal(
      m.query("[data-settings-pane]")?.getAttribute("data-settings-pane"),
      "skills",
    );
    assert.equal(
      m.query('[data-settings-nav="skills"]')?.textContent?.trim(),
      "Skills & MCP",
    );
    assert.ok(m.query("[data-skills-manager]"));
    assert.ok(m.query('[data-skill-section="curated"]'), "Browse catalog");
    assert.ok(m.query('section[aria-label="MCP servers"]'), "MCP servers");
    assert.ok(m.query("[data-harness-import]"), "Import from other tools");
    assert.ok(m.query('[data-skill-section="add"]'), "Add skill");
    assert.equal(m.query("[data-skill]"), null, "the installed list stays in the tab");
    assert.ok(calls.includes("catalog") && calls.includes("mcp"));
    assert.ok(calls.includes("harness"));
    assert.ok(calls.includes("skills:/tmp/two"), "uses the current project path");
  });

  it("is found by Find a setting", async () => {
    const m = await mount(modal({ skills: skillsApi([]) }));
    await m.type(m.query("[data-settings-search]"), "mcp server");
    assert.ok(m.query('[data-settings-nav="skills"]'));
  });
});
```

In `test/appWiring.test.tsx`, append inside `describe("App memory wiring", …)` (it already has `boot`, `expandAgents`, `project` and `thread`):

```tsx
  it("Skills tab Manage › opens Settings on Skills & MCP", async () => {
    const fake = createFakeCoder({
      projects: [project()],
      threads: [thread()],
    });
    const m = await boot(fake);
    await expandAgents(m);
    await m.click(m.query('[data-panel-tab="skills"]'));
    const manage = m.query("[data-skills-manage]");
    assert.ok(manage, "Manage › sits on the Skills toolbar");
    await m.click(manage);
    assert.equal(
      m.query("[data-settings-pane]")?.getAttribute("data-settings-pane"),
      "skills",
    );
    assert.ok(m.query("[data-skills-manager]"), "moved sections render in Settings");
    m.unmount();
  });
```

- [ ] **Step 2: Migrate the mounts in `test/skillsTab.test.tsx`.** Do this before any other edit to the file, so the line ranges are still exact:

```bash
sed -i '' \
  -e '674,1229s/<Harness\([ />]\)/<ManagerHarness\1/g' -e '674,1229s/<Harness$/<ManagerHarness/' \
  -e '1231,1283s/<Harness\([ />]\)/<ManagerHarness\1/g' -e '1231,1283s/<Harness$/<ManagerHarness/' \
  -e '1636,2199s/<Harness\([ />]\)/<ManagerHarness\1/g' -e '1636,2199s/<Harness$/<ManagerHarness/' \
  -e '2233,2804s/<Harness\([ />]\)/<ManagerHarness\1/g' -e '2233,2804s/<Harness$/<ManagerHarness/' \
  test/skillsTab.test.tsx
grep -c "<ManagerHarness" test/skillsTab.test.tsx
```
Expected output: `45`. These four ranges are:
- the MCP describe
- "adds a skill…"
- "validates the add form…"
- the import-preview describe up to line 2199
- the harness-import describe

None of these tests touches the installed list.

- [ ] **Step 3: Rewrite the mixed tests in `test/skillsTab.test.tsx`, bottom-up.** Line numbers are unchanged, because Step 2 replaced text without adding lines.

3a. Replace lines 2882-2896 ("preserves search when moving between library and catalog") with:

```tsx
  it("keeps the search while the catalog lives in Settings", async () => {
    const m = await mount(<Harness catalog={[catalogEntry()]} />);
    await m.type(m.query('input[aria-label="Search installed skills"]'), "write-tests");
    assert.equal(m.queryAll("[data-skill]").length, 1);
    assert.equal(m.query('[data-catalog="ponytail"]'), null, "catalog is not in the tab");
    const s = await mount(<ManagerHarness catalog={[catalogEntry()]} />);
    assert.ok(s.query('[data-catalog="ponytail"]'));
    s.unmount();
    assert.equal(
      (m.query('input[aria-label="Search installed skills"]') as HTMLInputElement)
        .value,
      "write-tests",
    );
    assert.equal(m.queryAll("[data-skill]").length, 1);
    m.unmount();
  });
```

3b. Replace lines 2200-2231 ("labels catalog source links and unique row actions for focus") with:

```tsx
  it("labels catalog source links and unique row actions for focus", async () => {
    const skills = [SKILLS[0], { ...SKILLS[1], name: "other-skill" }];
    const s = await mount(
      <ManagerHarness catalog={[catalogEntry()]} skills={skills} />,
    );
    const link = s.query('[data-catalog="ponytail"] a');
    assert.ok(link);
    assert.ok(link.getAttribute("href")?.includes("github.com"));
    assert.ok(
      link.getAttribute("aria-label")?.includes("Ponytail"),
      "catalog source link must include the entry name",
    );
    s.unmount();
    const m = await mount(<Harness skills={skills} />);
    await expandSkill(m, "claude:review-pr");
    await expandSkill(m, "agents:other-skill");
    const labels = m
      .queryAll('button[aria-label^="Remove "]')
      .map((b) => b.getAttribute("aria-label"));
    assert.ok(labels.includes("Remove review-pr"));
    assert.ok(labels.includes("Remove other-skill"));
    assert.equal(new Set(labels).size, labels.length);
    m.unmount();
  });
```

3c. In "installs the selection, reloads lists, and announces the count" (lines 1883-1940):
- Replace line 1906 with:
  ```tsx
      assert.equal(catalogs.length, 1, "Settings shows the catalog, so it loads once on open");
  ```
- Replace lines 1918-1922 (the `assert.equal(catalogs.length, 0, "file install does not fetch a hidden catalog");` statement) with:
  ```tsx
      assert.equal(catalogs.length, 2, "the visible catalog reloads to mark the new install");
  ```

3d. Replace lines 1612-1633 ("shows curated loading without hiding installed skills") with:

```tsx
  it("shows curated loading without hiding installed skills", async () => {
    let resolveCatalog!: (rows: SkillCatalogEntry[]) => void;
    const pending = new Promise<SkillCatalogEntry[]>((resolve) => {
      resolveCatalog = resolve;
    });
    const m = await mount(
      <Harness catalog={[catalogEntry()]} pendingCatalog={pending} />,
    );
    assert.ok(
      m.query('[data-skill="claude:review-pr"]'),
      "the tab lists installed skills without waiting on the catalog",
    );
    m.unmount();
    const s = await mount(
      <ManagerHarness catalog={[catalogEntry()]} pendingCatalog={pending} />,
    );
    assert.ok(
      s.query('[data-skill-section="curated"]')?.textContent?.includes("Loading"),
    );
    await inAct(async () => {
      resolveCatalog([catalogEntry()]);
    });
    await s.flush();
    assert.ok(
      s.query('[data-skill-section="curated"]')?.textContent?.includes("Ponytail"),
    );
    s.unmount();
  });
```

3e. Replace lines 1581-1610 ("does not treat an added skill as curated just because names match") with:

```tsx
  it("does not treat an added skill as curated just because names match", async () => {
    const skills: SkillInfo[] = [
      {
        name: "Ponytail",
        description: "User-added skill that happens to share a name",
        source: "claude",
        installedIn: [...ALL_TARGETS],
        missingFrom: [],
        bytes: 4800,
        provenance: "added",
      },
    ];
    const s = await mount(
      <ManagerHarness
        catalog={[catalogEntry({ name: "Ponytail", installed: true })]}
        skills={skills}
      />,
    );
    const row = s.query('[data-catalog="ponytail"]');
    assert.ok(row);
    assert.ok(row.textContent?.includes("Installed"));
    assert.equal(
      row.querySelector("[data-coverage]"),
      null,
      "name-only match must not borrow an added skill's coverage",
    );
    s.unmount();
    const m = await mount(<Harness skills={skills} />);
    assert.ok(m.query('[data-skill="claude:Ponytail"]'));
    m.unmount();
  });
```

3f. In "falls back to installed curated skills when the catalog fails or is empty" (lines 1528-1579), keep the `curatedInstalled` constant (lines 1529-1542). Replace lines 1543-1578, from `const failed = await mount(` through `empty.unmount();`, with:

```tsx
    const failedTab = await mount(
      <Harness catalogError="catalog down" skills={[curatedInstalled, SKILLS[1]]} />,
    );
    await failedTab.click(failedTab.query('[data-source-filter="added"]'));
    assert.equal(
      failedTab.query('[data-skill="claude:review-pr"]'),
      null,
      "fallback curated rows must not be duplicated as User skills",
    );
    failedTab.unmount();

    const failed = await mount(
      <ManagerHarness
        catalogError="catalog down"
        skills={[curatedInstalled, SKILLS[1]]}
      />,
    );
    const curated = failed.query('[data-skill-section="curated"]');
    assert.ok(curated?.textContent?.toLowerCase().includes("unavailable"));
    const row = failed.query('[data-catalog="ponytail"]');
    assert.ok(row, "installed curated skill must stay visible as a fallback row");
    assert.ok(row.textContent?.includes("Ponytail"));
    assert.ok(row.textContent?.includes("Installed"));
    assert.equal(row.querySelector("[data-coverage]")?.textContent, "7/7");
    failed.unmount();

    const empty = await mount(
      <ManagerHarness catalog={[]} skills={[curatedInstalled, SKILLS[1]]} />,
    );
    assert.ok(empty.query('[data-catalog="ponytail"]'));
    assert.equal(
      empty
        .query('[data-skill-section="curated"]')
        ?.textContent?.toLowerCase()
        .includes("unavailable"),
      false,
    );
    empty.unmount();
```

3g. Replace lines 1505-1526 ("does not mention catalog unavailable when the catalog loaded empty") with:

```tsx
  it("does not mention catalog unavailable when the catalog loaded empty", async () => {
    const m = await mount(<Harness catalog={[]} skills={[]} />);
    assert.match(m.text(), /manage/i, "empty library points at Manage");
    m.unmount();
    const s = await mount(<ManagerHarness catalog={[]} skills={[]} />);
    const curated = s.query('[data-skill-section="curated"]');
    assert.ok(curated);
    assert.equal(
      curated.textContent?.toLowerCase().includes("unavailable"),
      false,
    );
    const live = s.query("[aria-live]");
    assert.ok(live, "aria-live status is always mounted");
    assert.equal((live.textContent || "").trim(), "");
    assert.ok(
      live.hasAttribute("data-empty"),
      "empty live region must collapse via data-empty",
    );
    s.unmount();
  });
```

3h. Replace lines 1485-1503 ("keeps catalog rows when installed skills fail to load") with:

```tsx
  it("keeps catalog rows when installed skills fail to load", async () => {
    const opts = {
      catalog: [catalogEntry()],
      skillsError: "Error invoking remote method 'skills:list': Error: skills down",
    };
    const m = await mount(<Harness {...opts} />);
    assert.ok(m.text().includes("skills down"));
    assert.equal(m.text().includes("Error invoking remote method"), false);
    assert.equal(m.query('[data-skill="claude:review-pr"]'), null);
    m.unmount();
    const s = await mount(<ManagerHarness {...opts} />);
    assert.ok(
      s.query('[data-skill-section="curated"]')?.textContent?.includes("Ponytail"),
    );
    s.unmount();
  });
```

3i. Replace lines 1456-1483 ("loads catalog independently and does not erase installed skills on catalog failure") with:

```tsx
  it("loads catalog independently and does not erase installed skills on catalog failure", async () => {
    const listed: unknown[] = [];
    const catalogs: unknown[] = [];
    const opts = {
      catalog: [catalogEntry()],
      catalogError:
        "Error invoking remote method 'skills:catalog': Error: catalog down",
      onListSkills: () => {
        listed.push(1);
      },
      onListSkillCatalog: () => {
        catalogs.push(1);
      },
    };
    const m = await mount(<Harness {...opts} />);
    assert.equal(listed.length, 1);
    assert.equal(catalogs.length, 0, "the inspector tab never loads the catalog");
    assert.ok(
      m.query('[data-skill="claude:review-pr"]'),
      "installed skills must still render",
    );
    m.unmount();
    const s = await mount(<ManagerHarness {...opts} />);
    assert.equal(catalogs.length, 1, "Settings → Skills & MCP loads it once");
    const curated = s.query('[data-skill-section="curated"]');
    assert.ok(curated?.textContent?.toLowerCase().includes("unavailable"));
    assert.equal(
      curated?.textContent?.includes("Error invoking remote method"),
      false,
    );
    assert.equal(curated?.textContent?.includes("Ponytail"), false);
    s.unmount();
  });
```

3j. In "keeps curated, added, and project skills in distinct sections without duplication" (lines 1400-1454), make these changes:
- Hoist the `skills={[…]}` array literal (lines 1404-1417) into `const skills: SkillInfo[] = [ … ];` above the mount, and mount `<Harness catalog={[catalogEntry({ installed: true })]} skills={skills} />`.
- Replace line 1423 (`await openSkillsView(m, "catalog");`) with:
  ```tsx
      const s = await mount(
        <ManagerHarness catalog={[catalogEntry({ installed: true })]} skills={skills} />,
      );
  ```
- In lines 1424-1437, change every `m.query(` to `s.query(`, and the message `"Curated section must render in the catalog view"` to `"Curated section must render in Settings → Skills & MCP"`.
- Replace line 1438 (`await openSkillsView(m, "library");`) with `s.unmount();`.
- Leave lines 1439-1453 on `m` unchanged.

3k. Replace lines 1369-1396 ("disables Sync when no skill has drift") with:

```tsx
  it("shows no drift banner when no skill has drift", async () => {
    const m = await mount(
      <Harness
        skills={[
          {
            name: "review-pr",
            description: "Review a pull request end to end",
            source: "claude",
            installedIn: [...ALL_TARGETS],
            missingFrom: [],
            bytes: 4800,
            provenance: "added",
          },
        ]}
      />,
    );
    assert.equal(m.query("[data-skills-drift]"), null);
    assert.equal(m.query('button[aria-label="Sync missing skills"]'), null);
    assert.equal(
      m.query('[data-skill="project:local-rules"]'),
      null,
      "Project skills are omitted when the inventory has none",
    );
    m.unmount();
  });

  it("hides the drift banner when the last load failed (no stale count)", async () => {
    const m = await mount(
      <Harness
        onSyncSkills={() => {
          throw new Error("sync down");
        }}
      />,
    );
    assert.ok(m.query("[data-skills-drift]"));
    await m.click(m.query('button[aria-label="Sync missing skills"]'));
    assert.ok(m.text().includes("sync down"), "the in-tab error line stays");
    assert.equal(m.query("[data-skills-drift]"), null);
    m.unmount();
  });
```

3l. Replace lines 1323-1367 ("Sync calls skills.sync, reloads, and reports what it copied") with:

```tsx
  it("Sync in the drift banner calls skills.sync, reloads, and reports what it copied", async () => {
    const listed: Array<{ projectPath?: string } | undefined> = [];
    let syncs = 0;
    const m = await mount(
      <Harness
        onListSkills={(input) => listed.push(input)}
        onSyncSkills={() => {
          syncs += 1;
        }}
      />,
    );
    assert.equal(listed.length, 1, "listSkills once on mount");
    const banner = m.query("[data-skills-drift]");
    assert.ok(banner, "drift banner shows while a skill is missing somewhere");
    assert.match(banner.textContent ?? "", /1 skill out of sync/);
    const syncBtn = m.query(
      'button[aria-label="Sync missing skills"]',
    ) as HTMLButtonElement | null;
    assert.ok(syncBtn, "Sync action must render");
    assert.ok(banner.contains(syncBtn), "Sync lives in the drift banner");
    assert.equal(
      m.query("[data-skills-toolbar]")?.contains(syncBtn),
      false,
      "the toolbar no longer carries Sync",
    );
    assert.equal(syncBtn.disabled, false);
    await m.click(syncBtn);
    assert.equal(syncs, 1, "syncSkills must fire once");
    assert.equal(listed.length, 2, "listSkills must reload after sync");
    assert.ok(m.text().includes("Copied 1 skill"), "sync reports what it did");
    const live = m.queryAll("[aria-live]").find((el) =>
      (el.textContent || "").includes("Copied 1 skill"),
    );
    assert.ok(live, "sync success must be an aria-live status");
    assert.equal(
      m.queryAll("[aria-live]").length,
      1,
      "status uses one always-mounted live region",
    );
    assert.equal(
      m.query('[data-skill="agents:write-tests"]')?.querySelector("[data-drift]"),
      null,
      "drift marker clears after sync reloads",
    );
    assert.equal(m.query("[data-skills-drift]"), null, "banner hides once nothing has drift");
    m.unmount();
  });

  it("toolbar is search, one filter menu and Manage ›", async () => {
    let managed = 0;
    const m = await mount(
      <Harness
        onManage={() => {
          managed += 1;
        }}
      />,
    );
    const toolbar = m.query("[data-skills-toolbar]")!;
    assert.ok(toolbar.querySelector('input[aria-label="Search installed skills"]'));
    const menus = toolbar.querySelectorAll("[data-skills-filter-menu]");
    assert.equal(menus.length, 1, "one filter menu replaces the chips");
    assert.equal(
      menus[0]!.querySelectorAll("[data-source-filter], [data-provider-filter]")
        .length,
      11,
      "3 sources + 8 providers live inside the menu",
    );
    assert.equal(m.query("[data-skills-view-btn]"), null, "no view buttons");
    assert.equal(m.query('[data-skill-section="add"]'), null, "Add skill moved to Settings");
    const manage = m.query("[data-skills-manage]");
    assert.equal(manage?.textContent, "Manage ›");
    await m.click(manage);
    assert.equal(managed, 1);
    m.unmount();
  });
```

3m. In "renders installed skills first; MCP stays on a secondary view" (lines 521-562):
- Rename it to `"renders installed skills in the tab; MCP lives in Settings → Skills & MCP"`.
- Replace line 552 (`await openSkillsView(m, "mcp");`) with:
  ```tsx
      assert.equal(m.query("[data-skills-manager]"), null, "no MCP surface in the tab");
      m.unmount();
      const s = await mount(<ManagerHarness mcpServers={[httpDef()]} />);
  ```
- In lines 553-560, change every `m.text()` to `s.text()`.
- Change the last `m.unmount();` (line 561) to `s.unmount();`.

3n. Replace the `openSkillsView` helper (lines 499-506) with:

```tsx
/**
 * Catalog, MCP and Add skill live on Settings → Skills & MCP (SkillsManager);
 * the installed library is the inspector tab. Asserts the mount is the right one.
 */
async function openSkillsView(
  m: Awaited<ReturnType<typeof mount>>,
  view: "library" | "catalog" | "mcp" | "add",
): Promise<void> {
  const onSettings = Boolean(m.query("[data-skills-manager]"));
  assert.equal(
    onSettings,
    view !== "library",
    `${view} lives on the ${view === "library" ? "inspector tab" : "Settings pane"}`,
  );
}
```

3o. Update the harness:
- In `interface HarnessOptions`, add `surface?: "inspector" | "settings";` and `onManage?: () => void;`.
- In `function Harness`, right before `return (`, add:
  ```tsx
    // Both surfaces read only the props they declare, so one prop bag drives either.
    const Surface = (opts.surface === "settings" ? SkillsManager : SkillsTab) as typeof SkillsManager;
  ```
- Change `<SkillsTab` (line 248) to `<Surface`, and add `onManage={opts.onManage}` right after `projectPath="/repo"`.
- After the closing `}` of `function Harness`, add:
  ```tsx
  function ManagerHarness(opts: HarnessOptions) {
    return <Harness {...opts} surface="settings" />;
  }
  ```
- Change line 12 to `import { SkillsManager, SkillsTab } from "../src/components/SkillsTab";`.

- [ ] **Step 4: Run the skills, settings and app tests to make sure they fail.**
Run: `node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test test/skillsTab.test.tsx test/settingsModal.test.tsx test/appWiring.test.tsx`
Expected: FAIL. `SkillsManager` is not exported (`Surface` is undefined, so React throws on render), and the Skills & MCP tests are not ok.

- [ ] **Step 5: Split `src/components/SkillsTab.tsx`, bottom-up.**

5a. After the closing `}` of the component (line 1430, just before `function McpServersSection(`), insert the new inspector tab:

```tsx
export interface SkillsTabProps {
  /** Selected project's checkout path; project skills are read-only. */
  projectPath: string | null;
  listSkills: (input?: { projectPath?: string }) => Promise<SkillInfo[]>;
  removeSkill: (input: { name: string }) => Promise<void>;
  syncSkills: () => Promise<{ copied: number; skills: string[] }>;
  /** Opens Settings → Skills & MCP. Absent hides Manage ›. */
  onManage?: () => void;
}

/**
 * Inspector Skills tab: the skills this thread can use. Catalog, MCP
 * servers, imports and Add skill live in Settings → Skills & MCP
 * (SkillsManager above).
 */
export function SkillsTab({
  projectPath,
  listSkills,
  removeSkill,
  syncSkills,
  onManage,
}: SkillsTabProps) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  /** Inline remove confirm: row key of the skill asking. */
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sourceFilters, setSourceFilters] = useState<Set<SkillProvenance>>(
    () => new Set(),
  );
  const [providerFilters, setProviderFilters] = useState<Set<SkillTarget>>(
    () => new Set(),
  );
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const mountedRef = useRef(true);
  const genRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    const gen = ++genRef.current;
    setLoading(true);
    try {
      const list = await listSkills(projectPath ? { projectPath } : undefined);
      if (!mountedRef.current || gen !== genRef.current) return;
      setSkills(list);
      setError(null);
    } catch (err) {
      if (!mountedRef.current || gen !== genRef.current) return;
      setError(errorMessage(err));
    } finally {
      if (mountedRef.current && gen === genRef.current) setLoading(false);
    }
  }, [listSkills, projectPath]);

  useEffect(() => {
    setSkills([]);
    setExpandedKeys(new Set());
    setConfirmRemove(null);
    void reload();
  }, [reload]);

  const handleRemove = async (skill: SkillInfo) => {
    if (skill.provenance === "project" || skill.source === "project") return;
    setBusy(true);
    try {
      await removeSkill({ name: skill.name });
      if (!mountedRef.current) return;
      setConfirmRemove(null);
      setStatusMessage(null);
      await reload();
    } catch (err) {
      if (mountedRef.current) setError(errorMessage(err));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleSync = async () => {
    setError(null);
    setStatusMessage(null);
    setBusy(true);
    try {
      const result = await syncSkills();
      if (!mountedRef.current) return;
      await reload();
      if (!mountedRef.current) return;
      setStatusMessage(copiedMessage(result.copied));
    } catch (err) {
      if (mountedRef.current) setError(errorMessage(err));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const visible = filterInstalledSkills(skills, {
    query,
    sources: sourceFilters,
    providers: providerFilters,
  })
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
  // Never a stale count: a failed load or action hides the banner.
  const drifted = error
    ? 0
    : skills.filter((s) => s.provenance !== "project" && s.missingFrom.length > 0)
        .length;
  const activeFilters = sourceFilters.size + providerFilters.size;

  const library = (() => {
    if (loading && skills.length === 0) {
      return <p className={styles.empty}>Loading…</p>;
    }
    if (error && skills.length === 0) {
      return (
        <div className={styles.downWrap}>
          <p className={styles.formError} role="alert">
            {error}
          </p>
          <button
            type="button"
            className={styles.ghostBtn}
            onClick={() => void reload()}
          >
            Retry
          </button>
        </div>
      );
    }
    if (skills.length === 0) {
      return (
        <p className={styles.empty}>
          No installed skills yet. Add or import one in Manage.
        </p>
      );
    }
    if (visible.length === 0) {
      return (
        <p className={styles.empty}>
          {query.trim()
            ? "No skills match this search."
            : "No skills match these filters."}
        </p>
      );
    }
    return (
      <ul className={styles.list} data-skill-section="installed">
        {visible.map((skill) => {
          const key = skillKey(skill);
          return (
            <InstalledSkillRow
              key={key}
              skill={skill}
              expanded={expandedKeys.has(key)}
              busy={busy}
              confirmRemove={confirmRemove}
              onToggle={() =>
                setExpandedKeys((current) => toggleSetValue(current, key))
              }
              onAskRemove={setConfirmRemove}
              onConfirmRemove={(row) => void handleRemove(row)}
              onCancelRemove={() => setConfirmRemove(null)}
            />
          );
        })}
      </ul>
    );
  })();

  return (
    <div className={styles.root}>
      <div className={styles.toolbar} data-skills-toolbar="">
        <div className={styles.toolbarRow}>
          <input
            type="search"
            className={styles.searchInput}
            placeholder="Search installed skills"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search installed skills"
          />
          <span className={styles.count} data-skills-count="">
            {loading && skills.length === 0
              ? "…"
              : `${visible.length}/${skills.length}`}
          </span>
          <details className={styles.filterMenu} data-skills-filter-menu="">
            <summary className={styles.ghostBtn} aria-label="Filter skills">
              {activeFilters > 0 ? `Filter · ${activeFilters}` : "Filter"}
            </summary>
            <div className={styles.filterMenuList}>
              <div className={styles.sectionLabel}>Source</div>
              {SOURCE_FILTERS.map((filter) => {
                const count = sourceFilterCount(skills, filter.id, {
                  query,
                  providers: providerFilters,
                });
                return (
                  <label
                    key={filter.id}
                    className={styles.checkLabel}
                    data-source-filter={filter.id}
                  >
                    <input
                      type="checkbox"
                      checked={sourceFilters.has(filter.id)}
                      aria-label={`${filter.label} source filter, ${count}`}
                      onChange={() =>
                        setSourceFilters((prev) => toggleSetValue(prev, filter.id))
                      }
                    />
                    {filter.label} {count}
                  </label>
                );
              })}
              <div className={styles.sectionLabel}>Provider</div>
              {PROVIDER_FILTERS.map((filter) => {
                const count = providerFilterCount(skills, filter.id, {
                  query,
                  sources: sourceFilters,
                });
                return (
                  <label
                    key={filter.id}
                    className={styles.checkLabel}
                    data-provider-filter={filter.id}
                  >
                    <input
                      type="checkbox"
                      checked={providerFilters.has(filter.id)}
                      aria-label={`${filter.label} provider filter, ${count}`}
                      onChange={() =>
                        setProviderFilters((prev) =>
                          toggleSetValue(prev, filter.id),
                        )
                      }
                    />
                    {filter.label} {count}
                  </label>
                );
              })}
            </div>
          </details>
          {onManage ? (
            <button
              type="button"
              className={styles.ghostBtn}
              data-skills-manage=""
              onClick={onManage}
            >
              Manage ›
            </button>
          ) : null}
        </div>
      </div>
      <div className={styles.scroll} data-skills-scroll="">
        <p
          className={styles.syncNote}
          aria-live="polite"
          data-empty={statusMessage ? undefined : ""}
        >
          {statusMessage ?? ""}
        </p>
        {drifted > 0 ? (
          <InspectorBanner
            data-skills-drift=""
            text={`${drifted} ${drifted === 1 ? "skill" : "skills"} out of sync`}
            actionLabel="Sync"
            onAction={() => void handleSync()}
            actionProps={{
              "aria-label": "Sync missing skills",
              title: "Copy missing skills into every provider",
              disabled: busy,
            }}
          />
        ) : null}
        {error && skills.length > 0 ? (
          <div className={styles.downWrap}>
            <p className={styles.formError} role="alert">
              {error}
            </p>
            <button
              type="button"
              className={styles.ghostBtn}
              onClick={() => void reload()}
            >
              Retry
            </button>
          </div>
        ) : null}
        <section className={styles.section} aria-label="Installed skills">
          {library}
        </section>
      </div>
    </div>
  );
}
```

5b. Replace lines 1039-1429 of the old component, from `  const visibleSkills = filterInstalledSkills(` through the `  );` that closes its `return (`, with:

```tsx
  const skillPreview = (
    <>
      {installResult && <SkillInstallResultPanel result={installResult} />}
      {preview && (
        <SkillImportPreviewPanel
          preview={preview}
          selected={selected}
          replace={replace}
          trusted={trusted}
          busy={skillBusy}
          error={importError}
          onToggle={(name) => {
            setSelected((prev) => {
              const next = new Set(prev);
              if (next.has(name)) next.delete(name);
              else next.add(name);
              return next;
            });
          }}
          onReplace={setReplace}
          onTrust={setTrusted}
          onInstall={() => void handleInstallPreview()}
          onCancel={() => void handleDiscardPreview()}
        />
      )}
    </>
  );

  // Moved as-is from the old Skills tab views; only the container changed.
  return (
    <div className={styles.manager} data-skills-manager="">
      <p
        className={styles.syncNote}
        aria-live="polite"
        data-empty={statusMessage ? undefined : ""}
      >
        {statusMessage ?? ""}
      </p>
      {skillPreview}
      <section className={styles.section} aria-label="Browse catalog">
        <CuratedSkillsSection
          catalog={catalog}
          loading={catalogLoading}
          error={catalogError}
          skills={skills}
          busy={skillBusy}
          onInstall={handleCatalogInstall}
        />
        {catalogError && (
          <button
            type="button"
            className={styles.ghostBtn}
            onClick={() => void reloadCatalog()}
          >
            Retry
          </button>
        )}
      </section>
      <McpServersSection
        mcpServers={mcpServers}
        mcpCatalog={mcpCatalog}
        mcpBusy={mcpBusy}
        mcpError={mcpError}
        mcpErrorScope={mcpErrorScope}
        mcpImportError={mcpPreview ? null : mcpImportError}
        mcpName={mcpName}
        mcpUrl={mcpUrl}
        mcpToken={mcpToken}
        mcpCommand={mcpCommand}
        mcpArgs={mcpArgs}
        mcpTrustLocal={mcpTrustLocal}
        mcpJson={mcpJson}
        mcpGithub={mcpGithub}
        onName={setMcpName}
        onUrl={setMcpUrl}
        onToken={setMcpToken}
        onCommand={setMcpCommand}
        onArgs={setMcpArgs}
        onTrustLocal={setMcpTrustLocal}
        onJson={setMcpJson}
        onGithub={setMcpGithub}
        onAdd={() => void handleAddMcp()}
        onAddLocal={() => void handleAddLocalMcp()}
        onToggle={(name, enabled) => void handleToggleMcp(name, enabled)}
        onRemove={(name) => void handleRemoveMcp(name)}
        onTrust={(server) => void handleTrustMcp(server)}
        onCatalogInstall={(id) => void handleMcpCatalogInstall(id)}
        onImportFile={() => void handleMcpImportFile()}
        onPreviewJson={() => void handleMcpPreviewJson()}
        onPreviewGithub={() => void handleMcpPreviewGithub()}
      />
      {mcpPreview && (
        <McpImportPreviewPanel
          preview={mcpPreview}
          selected={mcpSelected}
          replace={mcpReplace}
          trusted={mcpTrustImport}
          busy={mcpBusy}
          error={mcpImportError}
          onToggle={(name) => {
            setMcpSelected((prev) => {
              const next = new Set(prev);
              if (next.has(name)) next.delete(name);
              else next.add(name);
              return next;
            });
          }}
          onReplace={setMcpReplace}
          onTrust={setMcpTrustImport}
          onInstall={() => void handleInstallMcpPreview()}
          onCancel={() => void handleDiscardMcpPreview()}
        />
      )}
      <section className={styles.section} aria-label="Add skill">
        <HarnessImportSection
          sources={harnessSources}
          busy={skillBusy}
          error={harnessPreview ? null : harnessError}
          onScan={(id) => void handleHarnessScan(id)}
        />
        {harnessPreview && (
          <HarnessImportPreviewPanel
            preview={harnessPreview}
            selected={harnessSelected}
            replace={harnessReplace}
            trusted={harnessTrust}
            pluginTrusted={harnessPluginTrust}
            busy={skillBusy}
            error={harnessError}
            onToggle={(id) => {
              setHarnessSelected((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              });
            }}
            onReplace={setHarnessReplace}
            onTrust={setHarnessTrust}
            onPluginTrust={setHarnessPluginTrust}
            onSelectRemaining={() =>
              setHarnessSelected(new Set(harnessRemainingIds(harnessPreview)))
            }
            onSelectAll={() =>
              setHarnessSelected(new Set(harnessItemIds(harnessPreview)))
            }
            onInstall={() => void handleInstallHarness()}
            onCancel={() => handleDiscardHarness()}
          />
        )}
        <AddSkillSection
          busy={skillBusy}
          githubUrl={githubUrl}
          skillName={skillName}
          skillDescription={skillDescription}
          skillBody={skillBody}
          formError={skillFormError}
          importError={preview ? null : importError}
          onGithubUrl={setGithubUrl}
          onImportFile={handleImportFile}
          onPreviewGithub={handlePreviewGithub}
          onSkillName={setSkillName}
          onSkillDescription={setSkillDescription}
          onSkillBody={setSkillBody}
          onAddSkill={() => void handleAddSkill()}
        />
      </section>
    </div>
  );
```

5c. Delete line 914: `      switchView("library");` in `handleInstallPreview`.

5d. Delete lines 786-818: `handleRemoveSkill`, `handleSync` and the blank line after them. They now live in the new `SkillsTab`.

5e. In `handleAddSkill`, replace lines 776-777:
```tsx
      setStatusMessage(null);
      switchView("library");
```
with:
```tsx
      setStatusMessage(`Added ${name}`);
```
The status line is the only feedback now that there is no view switch.

5f. Replace lines 471-505, from `const switchView = useCallback(` through the harness `useEffect` that ends `}, [projectPath, loadHarnessSources]);`, with:

```tsx
  // Settings mounts this only while the Skills & MCP pane is open, so load
  // the catalog and MCP list once on open, and harness sources per project.
  useEffect(() => {
    void reloadCatalog();
    void reloadMcp();
  }, [reloadCatalog, reloadMcp]);

  useEffect(() => loadHarnessSources(), [projectPath, loadHarnessSources]);
```

5g. Delete line 457: `    harnessRequestedRef.current = true;`.

5h. Replace lines 442-454, the `reloadVisible` callback and the effect after it, with:

```tsx
  const reloadVisible = useCallback(async () => {
    await Promise.all([reloadSkills(), reloadCatalog(), reloadMcp()]);
  }, [reloadSkills, reloadCatalog, reloadMcp]);

  useEffect(() => {
    setSkills([]);
    void reloadSkills();
  }, [reloadSkills]);
```

5i. Replace `reloadSkills` (lines 393-411) with:

```tsx
  // Catalog rows mark what is installed; the list itself is the inspector
  // tab, which reports list failures. Here a failure just leaves rows unmatched.
  const reloadSkills = useCallback(async () => {
    const gen = ++skillsGenRef.current;
    try {
      const list = await listSkills(projectPath ? { projectPath } : undefined);
      if (!mountedRef.current || gen !== skillsGenRef.current) return;
      setSkills(list);
    } catch {
      // see above
    }
  }, [listSkills, projectPath]);
```

5j. Delete lines 347-356: `catalogRequestedRef`, `mcpRequestedRef`, `harnessRequestedRef`, `scrollRef` and `scrollByView`.

5k. Delete lines 302-314, from `/** Inline remove confirm … */` through the `expandedKeys` `useState`.

5l. Delete lines 265-266: the `skillsLoading` and `skillsError` state.

5m. Replace lines 237-261, the component signature, with:

```tsx
/**
 * Settings → Skills & MCP: catalog, MCP servers, imports from other tools,
 * Add skill. The old Skills tab body, moved as-is; the installed list is the
 * inspector SkillsTab below.
 */
export function SkillsManager({
  projectPath,
  listMcpServers,
  saveMcpServer,
  removeMcpServer,
  setMcpEnabled,
  listMcpCatalog,
  pickMcpImport,
  previewMcpImport,
  installMcpImport,
  discardMcpImport,
  listSkills,
  addSkill,
  listSkillCatalog,
  pickSkillImport,
  previewSkillImport,
  installSkillImport,
  discardSkillImport,
  detectHarnessSources,
  previewHarnessImport,
  installHarnessImport,
  discardHarnessImport,
}: SkillsManagerProps) {
```

5n. In the props interface (lines 66-107):
- rename `export interface SkillsTabProps {` to `export interface SkillsManagerProps {`
- delete the `settings`, `saveSettings`, `removeSkill` and `syncSkills` members

5o. Imports:
- Line 1 becomes `import { useCallback, useEffect, useRef, useState } from "react";`.
- Delete `AppSettings,` from the `../shared/ipc` type import.
- Delete `type SkillsView,` from the `./skillsLibrary` import.
- Add `import { InspectorBanner } from "./InspectorSection";` below the `./skillsLibrary` import.

Run `npx tsc --noEmit`. Every remaining error must be an unused local left by 5c–5n. Delete exactly what it names and nothing else.

- [ ] **Step 6: Append the new classes to `src/components/SkillsTab.module.css`.**

```css
/* Settings → Skills & MCP: the moved sections, stacked. */
.manager {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

/* One filter menu replaces the source and provider chip rows. */
.filterMenu {
  position: relative;
  flex-shrink: 0;
}

.filterMenu > summary {
  list-style: none;
  cursor: pointer;
}

.filterMenu > summary::-webkit-details-marker {
  display: none;
}

.filterMenuList {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 20;
  min-width: 180px;
  max-height: 320px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-pop);
}
```

- [ ] **Step 7: Add the Settings pane in `src/components/SettingsModal.tsx`.**
- Add `"skills",` to `SETTINGS_PANES` right after `"memory",`.
- Add this `PANE_META` entry after `memory`:

```tsx
  skills: {
    label: "Skills & MCP",
    hint: "The skill catalog, MCP servers, and imports every agent shares.",
    keywords:
      "skills mcp server catalog curated import harness plugin add skill write manually github claude codex cursor grok kimi",
  },
```

- Add `import { SkillsManager, type SkillsManagerProps } from "./SkillsTab";` next to the `./MemoryTab` import.
- In `SettingsModalProps`, add:

```tsx
  /** Catalog, MCP servers, imports and Add skill (moved from the Skills tab). */
  skills?: Omit<SkillsManagerProps, "projectPath">;
```

- Destructure `skills,` after `projectTools,`.
- In the JSX, right after the Project tools block from Task 2, insert:

```tsx

          {pane === "skills" && skills && (
          <SkillsManager
            projectPath={
              projects?.find((p) => p.id === currentProjectId)?.path ?? null
            }
            {...skills}
          />
          )}
```

- In `PaneIcon`, add a branch before the final `) : (` fallback:

```tsx
      ) : id === "skills" ? (
        <>
          <path d="M9 3v4M15 3v4" />
          <path d="M7 7h10v4a5 5 0 0 1-10 0V7Z" />
          <path d="M12 16v5" />
        </>
```

- [ ] **Step 8: Rewire `src/components/AgentsPanel.tsx`.**
- Add `import type { SettingsPane } from "./SettingsModal";` below `import { SkillsTab } from "./SkillsTab";`.
- In `AgentsPanelProps`, after `onCollapse?: () => void;`, add:

```tsx
  /** Opens Settings at a pane (Skills → Manage ›, Memory → Project tools). */
  onOpenSettings?: (pane?: SettingsPane) => void;
```

- In the `AgentsPanel` destructuring (lines 3551-3632):
  - Delete these names: `settings`, `saveSettings`, `listMcpServers`, `saveMcpServer`, `removeMcpServer`, `setMcpEnabled`, `listMcpCatalog`, `pickMcpImport`, `previewMcpImport`, `installMcpImport`, `discardMcpImport`, `addSkill`, `listSkillCatalog`, `pickSkillImport`, `previewSkillImport`, `installSkillImport`, `discardSkillImport`, `detectHarnessSources`, `previewHarnessImport`, `installHarnessImport` and `discardHarnessImport`.
  - Keep `listSkills`, `removeSkill` and `syncSkills`.
  - Add `onOpenSettings,` after `onCollapse,`.
  - Their interface entries stay until Task 8.
- Replace the `tab === "skills"` branch (`<SkillsTab … />`, lines 3811-3837) with:

```tsx
        <SkillsTab
          projectPath={project?.path ?? null}
          listSkills={listSkills}
          removeSkill={removeSkill}
          syncSkills={syncSkills}
          onManage={onOpenSettings ? () => onOpenSettings("skills") : undefined}
        />
```

- [ ] **Step 9: Wire App.** In `src/App.tsx`:
- On `<AgentsPanel`, add `onOpenSettings={openSettings}` right after the anchor `onFork={handleForkOpen}`, the last prop before `/>`. `openSettings` is the existing `useCallback` at the anchor `const openSettings = useCallback((pane?: SettingsPane) => {`.
- On `<SettingsModal`, add after `projectTools={{ … }}`:

```tsx
          skills={{
            listMcpServers,
            saveMcpServer,
            removeMcpServer,
            setMcpEnabled,
            listMcpCatalog,
            pickMcpImport,
            previewMcpImport,
            installMcpImport,
            discardMcpImport,
            listSkills,
            addSkill,
            listSkillCatalog,
            pickSkillImport,
            previewSkillImport,
            installSkillImport,
            discardSkillImport,
            detectHarnessSources,
            previewHarnessImport,
            installHarnessImport,
            discardHarnessImport,
          }}
```

- [ ] **Step 10: Run the tests, typecheck and build.**
Run: `npx tsc --noEmit && node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test test/skillsTab.test.tsx test/settingsModal.test.tsx test/appWiring.test.tsx test/agentsCollapse.test.tsx test/mcpSettingsTwins.test.ts test/skillImportTwins.test.ts && npx vite build`
Expected: tsc clean, 0 fail, vite `✓ built`.

- [ ] **Step 11: Commit.**
```bash
git add src/components/SkillsTab.tsx src/components/SkillsTab.module.css src/components/SettingsModal.tsx src/components/AgentsPanel.tsx src/App.tsx test/skillsTab.test.tsx test/settingsModal.test.tsx test/appWiring.test.tsx
git commit -m "Skills: installed list in the tab, catalog/MCP/import/add in Settings → Skills & MCP"
```

---
### Task 4: Fork / Hand off in the thread header

Decided by Willem on 2026-10-04 (discrepancy 1). This task adds a Fork button and a "Hand off to…" provider menu to the thread header, using the `ForkCard` behaviour. The Environment card stays until Task 5, so Fork is never unreachable between commits. The sidebar card menu is not touched.

**Files:**
- Modify: `src/components/ThreadView.tsx`:
  - Insert `HeaderForkControl` right before `function ReturnToViewButton({` (line 4609).
  - Render it in the header `.actions` row, right after the "Exit spec mode" block (lines 7274-7282) and before `{ring?.view.warn ? ringBadge : null}` (line 7283).
- Test: `test/threadHeader.test.tsx`:
  - the `view()` helper (lines 134-247)
  - `describe("header no longer hosts Environment actions")` (lines 459-470)
- Test: `test/forkHandoff.test.tsx`:
  - "Environment Hand off submenu…" (lines 237-280)
  - "Environment Fork also hits threads.fork…" (lines 447-485)

**Interfaces:**
- Consumes: ThreadView's existing props and locals, all in scope inside `ThreadView` at the header:
  - `onFork?: (opts?: { provider?: string; model?: string | null }) => void | Promise<void | ThreadInfo | null>` (lines 828-830). App already passes `onFork={handleForkOpen}`, which forks `selectedThreadId`.
  - `providers` and `thread`
  - `isWorking` (line 5092)
  - `isDraftHeader` (line 6842)
- Produces, inside `[data-thread-header]`:
  - `[data-thread-fork]` (title "Fork thread (same harness)")
  - `[data-thread-handoff]` (`aria-haspopup="menu"`)
  - `[data-thread-handoff-menu]` with `[data-handoff-provider="<id>"]` items
  - These are the same hooks the Environment `ForkCard` used, so the forkHandoff tests keep their selectors and scope them to the header.

**Behaviour copied from `ForkCard` (`AgentsPanel.tsx:638-757`):**
- Plain Fork calls `onFork()`.
- The Hand off menu lists every provider except the thread's own.
- An unavailable provider is listed but disabled, titled "<name> is not installed".
- A pick closes the menu and calls `onFork({ provider })`.
- Clicking outside, or Escape, closes the menu.
- Differences:
  - While the thread is working, the whole control is hidden instead of disabled (the decision: "hidden while the thread is working").
  - It is also hidden on a draft header, like the git step.
  - With no other provider, there is no Hand off button.

**Existing tests that assert changed UI:**
- `test/threadHeader.test.tsx` "does not render a dev menu, Fork, or Hand off in the thread header" (lines 460-470). Its assertions still hold with no `onFork`. It is kept as the "no Fork without onFork" case under a renamed describe.
- `test/forkHandoff.test.tsx`: both Environment Fork / Hand off tests move to the header.
  - Every assertion is kept: the current provider is excluded from the menu, other providers are listed, and Fork sends no `provider`.
  - The selectors are scoped to `[data-thread-header]`.
  - The selected thread gets one message, because a message-less detail is a draft (`ThreadView.tsx:6842`).

- [ ] **Step 1: Write the failing header tests.** In `test/threadHeader.test.tsx`:

1a. In the `view(props: { … })` parameter type, add these two members after `onOpenWorktreeIn?: …;`:

```tsx
  providers?: ProviderInfo[];
  onFork?: (opts?: {
    provider?: string;
    model?: string | null;
  }) => void | Promise<void | ThreadInfo | null>;
```

In the returned `<ThreadView`:
- change `providers={providers}` to `providers={props.providers ?? providers}`
- add `onFork={props.onFork}` after `onOpenWorktreeIn={props.onOpenWorktreeIn}`

1b. Replace `describe("header no longer hosts Environment actions", …)` (lines 459-470) with:

```tsx
const HANDOFF_PROVIDERS: ProviderInfo[] = [
  ...providers,
  {
    id: "grok",
    name: "Grok",
    available: true,
    supportsResume: true,
    models: [],
    modelInfo: [],
    efforts: [],
  },
  {
    id: "kimi",
    name: "Kimi",
    available: false,
    supportsResume: true,
    models: [],
    modelInfo: [],
    efforts: [],
  },
];

describe("header Fork / Hand off (moved from the Environment tab)", () => {
  it("has no dev menu, and no Fork or Hand off without onFork", async () => {
    const m = await mount(view({}));
    await m.flush();
    const header = m.query("header");
    assert.ok(header, "thread header present");
    assert.equal(header!.querySelector("[data-dev-menu]"), null);
    assert.equal(header!.querySelector("[data-thread-fork]"), null);
    assert.equal(header!.querySelector("[data-thread-handoff]"), null);
    m.unmount();
  });

  it("forks with the same harness and hands off to another provider", async () => {
    const forks: Array<{ provider?: string; model?: string | null } | undefined> = [];
    const m = await mount(
      view({
        providers: HANDOFF_PROVIDERS,
        onFork: (opts) => {
          forks.push(opts);
        },
      }),
    );
    await m.flush();
    const header = m.query("[data-thread-header]")!;
    const fork = header.querySelector("[data-thread-fork]");
    assert.ok(fork, "Fork sits in the thread header");
    assert.equal(fork.getAttribute("title"), "Fork thread (same harness)");
    await m.click(fork);
    assert.deepEqual(forks, [undefined], "plain Fork passes no provider");

    const handoff = header.querySelector("[data-thread-handoff]");
    assert.ok(handoff, "Hand off to… sits next to Fork");
    assert.equal(handoff.getAttribute("aria-expanded"), "false");
    await m.click(handoff);
    const entries = m
      .queryAll("[data-thread-handoff-menu] [data-handoff-provider]")
      .map((el) => el.getAttribute("data-handoff-provider"));
    assert.deepEqual(entries, ["grok", "kimi"], "the current provider is not offered");
    const kimi = m.query('[data-handoff-provider="kimi"]') as HTMLButtonElement;
    assert.equal(kimi.disabled, true);
    assert.equal(kimi.getAttribute("title"), "Kimi is not installed");
    await m.click(kimi);
    assert.deepEqual(forks, [undefined], "a disabled entry is click-dead");
    await m.click(m.query('[data-handoff-provider="grok"]'));
    assert.deepEqual(forks, [undefined, { provider: "grok" }]);
    assert.equal(m.query("[data-thread-handoff-menu]"), null, "a pick closes the menu");
    m.unmount();
  });

  it("hides Fork and Hand off while the thread is working", async () => {
    const m = await mount(
      view({
        detail: detail({ thread: thread({ status: "working" }) }),
        providers: HANDOFF_PROVIDERS,
        onFork: () => {},
      }),
    );
    await m.flush();
    assert.equal(m.query("[data-thread-fork]"), null);
    assert.equal(m.query("[data-thread-handoff]"), null);
    m.unmount();
  });

  it("hides them on a draft header with no conversation yet", async () => {
    const m = await mount(
      view({
        detail: detail({ messages: [] }),
        providers: HANDOFF_PROVIDERS,
        onFork: () => {},
      }),
    );
    await m.flush();
    assert.equal(m.query("[data-thread-fork]"), null);
    m.unmount();
  });

  it("offers Fork but no Hand off when no other provider exists", async () => {
    const m = await mount(view({ onFork: () => {} }));
    await m.flush();
    assert.ok(m.query("[data-thread-header] [data-thread-fork]"));
    assert.equal(m.query("[data-thread-handoff]"), null);
    m.unmount();
  });
});
```

`ThreadInfo` and `ProviderInfo` are already in the file's `../src/shared/ipc` type import (used by `thread()` and `providers`).

- [ ] **Step 2: Move the two App-level Environment fork tests to the header.** In `test/forkHandoff.test.tsx`:

2a. Add `ThreadDetail` to the type import (`import type { ProviderInfo, ThreadDetail, ThreadInfo } from "../src/shared/ipc";`). After `const NOW = Date.now();`, add:

```tsx
/** A started thread: a message-less detail is a draft, whose header has no Fork (#1411). */
const STARTED = [
  { id: "u-start", role: "user", text: "start", createdAt: 1 },
] as ThreadDetail["messages"];
```

2b. Replace "Environment Fork also hits threads.fork without provider" (lines 447-485) with:

```tsx
  it("Header Fork also hits threads.fork without provider", async () => {
    const d = decoy();
    const s = source();
    const o = otherProjectThread();
    const fake = createFakeCoder({
      projects: [
        project({ id: "p1", slug: "acme/one", name: "one", path: "/tmp/one" }),
        project({ id: "p2", slug: "acme/two", name: "two", path: "/tmp/two" }),
      ],
      providers,
      threads: [d, s, o],
      details: {
        "t-decoy": detail({ thread: d }),
        "t-source-fork": detail({ thread: s, messages: STARTED }),
        "t-p2": detail({ thread: o }),
      },
    });
    const m = await boot(fake);
    await selectThread(m, "source handoff thread");

    const headerFork = m.query("[data-thread-header] [data-thread-fork]");
    assert.ok(headerFork, "Header Fork must render");
    await m.click(headerFork as HTMLElement);
    await m.flush();

    const forks = fake.of("threads.fork");
    assert.equal(forks.length, 1);
    const arg = forks[0]!.args[0] as { threadId: string; provider?: string };
    assert.equal(arg.threadId, "t-source-fork");
    assert.equal(
      Object.prototype.hasOwnProperty.call(arg, "provider"),
      false,
    );
    m.unmount();
  });
```

2c. Replace "Environment Hand off submenu excludes current provider (and lists others)" (lines 237-280) with:

```tsx
  it("Header Hand off submenu excludes current provider (and lists others)", async () => {
    const d = decoy();
    const s = source();
    const o = otherProjectThread();
    const fake = createFakeCoder({
      projects: [
        project({ id: "p1", slug: "acme/one", name: "one", path: "/tmp/one" }),
        project({ id: "p2", slug: "acme/two", name: "two", path: "/tmp/two" }),
      ],
      providers,
      threads: [d, s, o],
      details: {
        "t-decoy": detail({ thread: d }),
        "t-source-fork": detail({ thread: s, messages: STARTED }),
        "t-p2": detail({ thread: o }),
      },
    });
    const m = await boot(fake);
    await selectThread(m, "source handoff thread");

    const headerHandoff = m.query("[data-thread-header] [data-thread-handoff]");
    assert.ok(headerHandoff, "Header Hand off to… must render");
    await m.click(headerHandoff as HTMLElement);
    await m.flush();

    const menu = m.query("[data-thread-header] [data-thread-handoff-menu]");
    assert.ok(menu, "Header hand-off menu open");
    const entries = Array.from(
      menu.querySelectorAll("[data-handoff-provider]"),
    ).map((el) => el.getAttribute("data-handoff-provider"));
    assert.ok(
      !entries.includes("claude"),
      `current provider must not appear in the header Hand off menu, got: ${entries.join(",")}`,
    );
    assert.ok(
      entries.includes("grok") && entries.includes("kimi"),
      "other providers must still be listed in the header menu (positive control)",
    );
    m.unmount();
  });
```

Do 2b before 2c (bottom-up), so the line numbers stay exact.

- [ ] **Step 3: Run them to make sure they fail.**
Run: `node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test test/threadHeader.test.tsx test/forkHandoff.test.tsx`
Expected: FAIL. "Fork sits in the thread header" is not ok, and "Header Fork must render" is not ok. The first describe test and the card-menu tests pass.

- [ ] **Step 4: Add `HeaderForkControl` to `src/components/ThreadView.tsx`.**

4a. Insert right before `function ReturnToViewButton({` (line 4609):

```tsx
/**
 * Fork / Hand off in the thread header (moved from the Environment tab's
 * Fork card, same behaviour). The caller hides it while the thread is
 * working and on a draft header.
 */
function HeaderForkControl({
  thread,
  providers,
  onFork,
}: {
  thread: ThreadInfo;
  providers: ProviderInfo[];
  onFork: (
    opts?: { provider?: string; model?: string | null },
  ) => void | Promise<void | ThreadInfo | null>;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const others = providers.filter((p) => p.id !== thread.provider);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  useEscapeClose(open, () => setOpen(false));

  return (
    <>
      <button
        type="button"
        className={styles.btn}
        data-thread-fork=""
        title="Fork thread (same harness)"
        onClick={() => void onFork()}
      >
        Fork
      </button>
      {others.length > 0 ? (
        <div className={styles.menuWrap} ref={menuRef}>
          <button
            type="button"
            className={styles.btn}
            data-thread-handoff=""
            aria-haspopup="menu"
            aria-expanded={open}
            title="Hand off to another provider"
            onClick={() => setOpen((v) => !v)}
          >
            Hand off to…
          </button>
          {open && (
            <div className={styles.menu} role="menu" data-thread-handoff-menu="">
              {others.map((p) => {
                const disabled = !p.available;
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={styles.menuItem}
                    role="menuitem"
                    data-handoff-provider={p.id}
                    disabled={disabled}
                    aria-disabled={disabled ? "true" : undefined}
                    title={
                      disabled
                        ? `${p.name} is not installed`
                        : `Hand off to ${p.name}`
                    }
                    onClick={() => {
                      if (disabled) return;
                      setOpen(false);
                      void onFork({ provider: p.id });
                    }}
                  >
                    {p.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </>
  );
}

```

`useRef`, `useState`, `useEffect` (line 1), `useEscapeClose` (line 200), and the `ThreadInfo` / `ProviderInfo` types are already imported. `.btn`, `.menuWrap`, `.menu` and `.menuItem` already exist in `ThreadView.module.css` (lines 606, 477, 514, 527), so no CSS changes are needed.

4b. In the header `.actions` row, change:

```tsx
              Exit spec mode
            </button>
          )}
          {ring?.view.warn ? ringBadge : null}
```
to:
```tsx
              Exit spec mode
            </button>
          )}
          {onFork && !isWorking && !isDraftHeader ? (
            <HeaderForkControl
              thread={thread}
              providers={providers}
              onFork={onFork}
            />
          ) : null}
          {ring?.view.warn ? ringBadge : null}
```

- [ ] **Step 5: Run the tests and typecheck.**
Run: `npx tsc --noEmit && node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test test/threadHeader.test.tsx test/forkHandoff.test.tsx test/threadView.test.tsx test/appWiring.test.tsx test/environmentCards.test.tsx`
Expected: tsc clean, 0 fail. The Environment `ForkCard` tests in `environmentCards.test.tsx` still pass; that card goes in Task 5.

- [ ] **Step 6: Commit.**
```bash
git add src/components/ThreadView.tsx test/threadHeader.test.tsx test/forkHandoff.test.tsx
git commit -m "Thread header: Fork and Hand off to…, hidden while the thread is working"
```

---

### Task 5: Environment tab

**Job:** the selected thread's workspace. The order is fixed: Status header, Run, Checkpoints, Lanes.

**Files:**
- Modify: `src/components/AgentsPanel.tsx`. Apply the edits bottom-up. Line numbers are from `810f9243`; Task 3 added one import line and two `AgentsPanelProps` lines above them, so each sits 3 lines lower by now. Every edit quotes its anchor.
  - the `tab === "git"` branch
  - `GitTab` (2168-2704)
  - `MergeQueueCard` (1911-2166)
  - `CheckpointsCard` (1801-1894)
  - the Recap and drag-and-drop block (1523-1787)
  - `PullCard`, `RepositoryCard` and `ScmCard` (1331-1521)
  - the `LocalServersCard`, `VerifyCard` and `DevServerCard` wrappers
  - `EditorCard` (758-803)
  - `PullRequestsCard`, `ChangesCard` and `DisplayPrefsCard` (520-636)
  - imports and the props interface
- Modify: `src/App.tsx` (add `fetchDiff` to `<AgentsPanel`)
- Modify: `src/uiPrefs.ts:141-142` (comment)
- Delete: `test/envSectionReorder.test.tsx`
- Test: `test/environmentCards.test.tsx`, `test/editorCard.test.tsx`, `test/remoteProject.test.tsx`, `test/mergeQueueChips.test.tsx`, `test/appWiring.test.tsx`, `test/forkHandoff.test.tsx`

**Interfaces:**
- Consumes:
  - `InspectorSection` and `inspector` classes (Task 1)
  - the Spotlight opt-in now living in Settings (Task 2)
- Produces:
  - `GitTab` props:
    - drops `onOpenPrs`, `prsActive`, `providers`, `onFork`, `spotlight` and `setSpotlight`
    - adds `fetchDiff?: () => Promise<DiffResult>`
  - `AgentsPanelProps` adds `fetchDiff?: () => Promise<DiffResult>`
  - `MergeQueueCard` drops `setSpotlight`. It reads `spotlight` directly.
- DOM hooks kept for tests:
  - `data-env-tools`
  - `data-sync-badge`, `data-sync-btn`
  - `data-pull-btn`, `data-pull-result`
  - `data-recap-activity`, `data-recap-pr`
  - `data-scm-card`, `data-scm-badge`, `data-scm-detail`
  - `data-repo-card`, `data-repo-link`
  - `data-editor`, `data-editor-reveal`, `data-editor-open`
  - `data-dev-server`, `data-verify-card`, `data-local-servers`, `data-local-servers-count`
  - `data-checkpoints`, `data-lanes`, `data-remote-unavailable`
- DOM hooks added:
  - `data-env-status`, `data-env-branch`, `data-env-changes`, `data-env-pr`
  - `data-env-error`, `data-env-links`, `data-env-run`, `data-env-empty`

**Where each removed item lives now (verified, see Spec discrepancies):**

| Removed from the tab | Home | Test that proves the home |
|---|---|---|
| Fork, Hand off | Thread header (Task 4) and sidebar card menu (`threadActionMenu.ts:100-114`) | `test/threadHeader.test.tsx` "header Fork / Hand off" (Task 4); `test/forkHandoff.test.tsx` "Header Fork…", "Header Hand off submenu…" (Task 4), "card Fork records threads.fork…" (127), "Hand off to a specific available provider…" (184) |
| Pull requests card | Sidebar Review nav (`Sidebar.tsx:4560-4577`) | rewritten `appWiring.test.tsx` test below |
| Changes card | "N changed files ›" link in the status header | new environmentCards test |
| Footer row (branch, sync) | Status header | `test/syncBadge.test.tsx` unchanged |
| Display | Settings → General (Task 2) | `settingsModal.test.tsx` Display group |
| Spotlight checkbox | Settings → Git (Task 2) | `settingsModal.test.tsx` Spotlight |
| Drag handles, "Reset order", `envSectionOrder` | Removed. The order is fixed. | new fixed-order test |
| Repository, Finder, Editor | **Kept** as small icon links in the status header's link row (discrepancies 2–4, resolved) | `environmentCards` repository tests, `editorCard.test.tsx` |

**Existing tests that assert removed or changed UI:**
- `test/envSectionReorder.test.tsx`: **deleted**.
  - Its non-drag assertions move to `environmentCards.test.tsx`:
    - default visible order → "renders Status, Run, Checkpoints, Lanes in a fixed order"
    - repo info fetched when the card renders null → the existing "repository card / refetches when the selected thread changes"
    - Repository shown once origin resolves → the existing "links owner/repo…"
    - remote hides tools → the new remote test
  - The drag, keyboard and Reset tests cover a removed feature.
- `test/environmentCards.test.tsx`:
  - helper `tab()`
  - pull "shows a hint instead of the button when no thread is selected"
  - recap "lists branch, PR, and status in the facts line", "links the PR number out…", "keeps the PR number plain text…", "omits the PR…", "is hidden when no thread is selected"
  - "pull requests card" ×3
  - "fork card" ×3
  - "display prefs card (#779)" ×2. These already moved to `settingsModal.test.tsx` in Task 2.
  - The facts line's thread **status** is not carried over: the sidebar card and header show it. Its `lastError` moves to `[data-env-error]`.
- `test/editorCard.test.tsx` "Git tab places the Editor card after Local Servers" → "Environment keeps Finder and Editor in the status header".
- `test/remoteProject.test.tsx:88-89` ("Changes" / "Open Git") → `data-env-changes`.
- `test/mergeQueueChips.test.tsx` "opts into Spotlight per repo and previews through spotlightLane" (270-344).
  - The opt-in half moved to Settings in Task 2.
  - The preview half stays.
- `test/appWiring.test.tsx` "Environment PR card opens the pull-requests view" → the sidebar Review nav.
- `test/forkHandoff.test.tsx`: Task 4 already moved its two Environment Fork / Hand off tests to the header. This task adds one test: the inspector has no Fork card, and the only Fork button is the header's.
- `test/editorCard.test.tsx` "enables both buttons for a selected thread and fires the handlers" (lines 70-98). Finder and Editor become icon buttons, so the two `textContent` assertions (lines 90-91) become `aria-label` and `title` assertions with the same strings.

- [ ] **Step 1: Write the failing Environment tests.** In `test/environmentCards.test.tsx`:

1a. Replace the type import and the `tab()` helper (lines 14-105) with:

```tsx
import type {
  CheckpointInfo,
  DiffResult,
  GitPullResult,
  GitRepoInfo,
  MergeLaneInfo,
  ProjectInfo,
  ThreadInfo,
  ThreadSummaryInfo,
} from "../src/shared/ipc";

const project = {
  id: "p1",
  slug: "owner/repo",
  name: "repo",
  path: "/tmp/repo",
} as ProjectInfo;

function thread(over: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id: "t1",
    projectId: "p1",
    title: "ship it",
    branch: "coder/ship-it",
    prNumber: null,
    prUrl: null,
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
    runStartedAt: null,
    archived: false,
    settledOverride: null,
    settledAt: null,
    pinnedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: 1,
    prState: null,
    provider: "claude",
    model: null,
    sessionId: null,
    permissionMode: "default",
    reasoningEffort: null,
    worktreePath: "/tmp/wt",
    ...over,
  } as ThreadInfo;
}

function summary(over: Partial<ThreadSummaryInfo> = {}): ThreadSummaryInfo {
  return {
    id: "t1",
    title: "ship it",
    provider: "claude",
    status: "idle",
    handoffFrom: null,
    lastActivity: null,
    ...over,
  } as ThreadSummaryInfo;
}

function tab(opts: {
  thread?: ThreadInfo | null;
  project?: ProjectInfo;
  repoInfo?: GitRepoInfo;
  onRepoInfo?: (id: string) => Promise<GitRepoInfo>;
  onPull?: (id: string) => Promise<GitPullResult>;
  summaries?: ThreadSummaryInfo[];
  onSummaries?: (input?: unknown) => Promise<ThreadSummaryInfo[]>;
  onFetchDiff?: () => Promise<DiffResult>;
  onViewChanges?: () => void;
  checkpoints?: CheckpointInfo[];
  lanes?: MergeLaneInfo[];
}) {
  const repoInfo = opts.repoInfo ?? { ok: false as const };
  const laneProps = opts.lanes
    ? {
        claimLane: async () => ({
          n: 1,
          port: 3001,
          path: "/tmp/lane-1",
          branch: "lane/1",
        }),
        listLanes: async () => opts.lanes!,
        previewLane: async (input: { lane: number }) => ({
          lane: input.lane,
          sha: "abc",
          files: [],
          path: "/tmp/repo",
        }),
        restorePreview: async () => ({ restored: true }),
        recycleWedgedLanes: async () => [],
      }
    : {};
  return (
    <GitTab
      thread={opts.thread === undefined ? thread() : opts.thread}
      project={opts.project ?? project}
      onViewChanges={opts.onViewChanges ?? (() => {})}
      fetchDiff={opts.onFetchDiff}
      listCheckpoints={async () => opts.checkpoints ?? []}
      restoreCheckpoint={async () => {}}
      listLocalServers={async () => []}
      gitRepoInfo={opts.onRepoInfo ?? (async () => repoInfo)}
      gitPull={opts.onPull ?? (async () => ({ ok: true, summary: "Already up to date" }))}
      listThreadSummaries={
        opts.onSummaries ?? (async () => opts.summaries ?? [summary()])
      }
      listDevScripts={async () => []}
      startDevServer={async () => ({ running: false })}
      stopDevServer={async () => ({ running: false })}
      devServerStatus={async () => ({ running: false })}
      {...laneProps}
    />
  );
}
```

Also:
- change line 7 to `import { describe, it } from "node:test";`
- delete the `getComposerVimEnabled` / `setComposerVimEnabled` import (lines 10-13)
- delete the `ProviderInfo` import

The Display tests that used them are deleted in 1d.

1b. In `describe("pull card")`, replace "shows a hint instead of the button when no thread is selected" (lines 282-288) with:

```tsx
  it("no thread: no Pull button, one empty-state line", async () => {
    const m = await mount(tab({ thread: null }));
    await m.flush();
    assert.equal(m.query("[data-pull-btn]"), null);
    assert.equal(
      m.query("[data-env-empty]")?.textContent,
      "Select a thread to see its workspace.",
    );
    m.unmount();
  });
```

1c. In `describe("recap card")`, replace the five tests "lists branch, PR, and status in the facts line" through "omits the PR from the facts line when none is recorded" (lines 325-378), and "is hidden when no thread is selected" (lines 395-400), with:

```tsx
  it("shows branch and PR in the status header, and the failure line when failed", async () => {
    const m = await mount(
      tab({
        thread: thread({
          prNumber: 7,
          prState: "OPEN",
          status: "failed",
          lastError: "Run error:\n  boom",
        }),
      }),
    );
    await m.flush();
    assert.equal(m.query("[data-env-branch]")?.textContent, "coder/ship-it");
    assert.equal(m.query("[data-env-pr]")?.textContent, "#7 open");
    assert.equal(m.query("[data-env-error]")?.textContent, "Run error: boom");
    m.unmount();
  });

  it("links the PR number out to GitHub when a URL is recorded", async () => {
    const m = await mount(
      tab({
        thread: thread({
          prNumber: 7,
          prState: "OPEN",
          prUrl: "https://github.com/owner/repo/pull/7",
        }),
      }),
    );
    await m.flush();
    const link = m.query("[data-recap-pr]") as HTMLAnchorElement | null;
    assert.ok(link, "PR is a link");
    assert.equal(link!.getAttribute("href"), "https://github.com/owner/repo/pull/7");
    assert.equal((link!.textContent || "").trim(), "#7 open ›");
    m.unmount();
  });

  it("keeps the PR number plain text when no URL is recorded", async () => {
    const m = await mount(
      tab({ thread: thread({ prNumber: 7, prState: "OPEN" }) }),
    );
    await m.flush();
    assert.equal(m.query("[data-recap-pr]"), null);
    assert.equal(m.query("[data-env-pr]")?.textContent, "#7 open");
    m.unmount();
  });

  it("omits the PR when none is recorded", async () => {
    const m = await mount(tab({}));
    await m.flush();
    assert.equal(m.query("[data-env-pr]"), null);
    assert.equal(m.query("[data-env-branch]")?.textContent, "coder/ship-it");
    m.unmount();
  });
```

and

```tsx
  it("is hidden when no thread is selected", async () => {
    const m = await mount(tab({ thread: null }));
    await m.flush();
    assert.equal(m.query("[data-recap-activity]"), null);
    m.unmount();
  });
```

Keep "shows the selected thread's last activity…", "shows the empty state…", "refetches summaries when the thread status changes" and "asks only for its own thread's summary (#1398)" unchanged.

1d. Delete `describe("pull requests card")`, `describe("fork card")` and `describe("display prefs card (#779)")` (lines 418-562, the end of the file). Append:

```tsx
describe("Environment layout (inspector redesign)", () => {
  it("renders Status, Run, Checkpoints, Lanes in a fixed order", async () => {
    const m = await mount(tab({ lanes: [] }));
    await m.flush();
    const pane = m.query("[data-env-tools]")!;
    assert.deepEqual(
      [...pane.children].map((el) => el.getAttribute("aria-label")),
      ["Status", "Run", "Checkpoints", "Lanes"],
    );
    m.unmount();
  });

  it("drops the duplicate cards and the reorder chrome", async () => {
    const m = await mount(tab({}));
    await m.flush();
    for (const sel of [
      "[data-prs-card]",
      "[data-open-prs]",
      "[data-thread-fork-card]",
      "[data-thread-fork]",
      "[data-thread-handoff]",
      "[data-display-prefs]",
      "[data-lane-spotlight]",
      "[data-env-grip]",
      "[data-env-reset]",
      "[data-env-section]",
      "[data-git-status]",
      "[data-recap-card]",
      "[data-recap-facts]",
    ]) {
      assert.equal(m.query(sel), null, `${sel} must be gone`);
    }
    assert.doesNotMatch(m.text(), /Drag to reorder|Reset order|Open Git/);
    m.unmount();
  });

  it("status header: branch, Pull, changed-files link that opens Git", async () => {
    let opened = 0;
    const m = await mount(
      tab({
        onFetchDiff: async () =>
          ({ files: [{}, {}, {}], patch: "", truncated: false }) as unknown as DiffResult,
        onViewChanges: () => {
          opened += 1;
        },
      }),
    );
    await m.flush();
    const status = m.query("[data-env-status]")!;
    assert.equal(status.querySelector("[data-env-branch]")?.textContent, "coder/ship-it");
    assert.ok(status.querySelector("[data-pull-btn]"), "Pull exists nowhere else, so it stays");
    const changes = status.querySelector("[data-env-changes]")!;
    assert.equal(changes.textContent, "3 changed files ›");
    await m.click(changes);
    assert.equal(opened, 1, "the link opens the Git view");
    m.unmount();
  });

  it("changes link reads Changes › until a diff count arrives", async () => {
    const m = await mount(tab({}));
    await m.flush();
    assert.equal(m.query("[data-env-changes]")?.textContent, "Changes ›");
    m.unmount();
  });

  it("checkpoints start collapsed and show their count", async () => {
    const m = await mount(
      tab({
        checkpoints: [
          { sha: "abc1234ffff", turn: 1, message: "turn 1", at: Date.now() },
        ],
      }),
    );
    await m.flush();
    const cp = m.query("[data-checkpoints]") as HTMLDetailsElement;
    assert.equal(cp.tagName, "DETAILS");
    assert.equal(cp.open, false);
    assert.equal(cp.querySelector("[data-section-count]")?.textContent, "1");
    m.unmount();
  });

  it("no thread: one empty line, Lanes still offered for the project", async () => {
    const m = await mount(tab({ thread: null, lanes: [] }));
    await m.flush();
    assert.ok(m.query("[data-env-empty]"));
    assert.equal(m.query("[data-env-status]"), null);
    assert.equal(m.query("[data-env-run]"), null);
    assert.ok(m.query("[data-lanes]"));
    m.unmount();
  });

  // Migrated from envSectionReorder "still hides remote-only tools on an SSH project".
  it("remote project: notice line; no Run, Checkpoints, Lanes, Pull or Finder", async () => {
    const m = await mount(
      tab({
        project: { ...project, remoteHost: "dev@box", remotePath: "/srv/app" },
        lanes: [],
      }),
    );
    await m.flush();
    assert.ok(m.query("[data-remote-unavailable]"));
    assert.ok(m.query("[data-env-changes]"), "changes link stays");
    assert.equal(m.query("[data-env-run]"), null);
    assert.equal(m.query("[data-local-servers]"), null);
    assert.equal(m.query("[data-checkpoints]"), null);
    assert.equal(m.query("[data-lanes]"), null, "lanes are local-only");
    assert.equal(m.query("[data-pull-btn]"), null);
    assert.equal(m.query("[data-editor]"), null);
    m.unmount();
  });
});
```

1e. Replace `describe("Git tab places the Editor card after Local Servers", …)` (`test/editorCard.test.tsx:100-130`) with:

```tsx
describe("Environment keeps Finder and Editor in the status header", () => {
  it("renders both links in the header and fires the App callbacks", async () => {
    let revealed = 0;
    let opened = 0;
    const m = await mount(
      <GitTab
        thread={thread()}
        project={project}
        onViewChanges={() => {}}
        listCheckpoints={async () => []}
        restoreCheckpoint={async () => {}}
        listLocalServers={async () => []}
        revealInFinder={async () => {
          revealed += 1;
        }}
        openInEditor={async () => {
          opened += 1;
        }}
      />,
    );
    await m.flush();
    assert.ok(
      m.query("[data-env-status] [data-editor]"),
      "Finder/Editor live in the status header (Finder has no other home)",
    );
    await m.click(m.query("[data-editor-reveal]"));
    await m.click(m.query("[data-editor-open]"));
    assert.equal(revealed, 1);
    assert.equal(opened, 1);
    m.unmount();
  });
});
```

Also in `test/editorCard.test.tsx`, replace lines 90-91:

```tsx
    assert.equal((reveal.textContent || "").trim(), "Open in Finder");
    assert.equal((open.textContent || "").trim(), "Open in Editor");
```
with:
```tsx
    // Icon buttons: the label lives in aria-label and the tooltip.
    assert.equal(reveal.getAttribute("aria-label"), "Open in Finder");
    assert.equal(reveal.getAttribute("title"), "Open in Finder");
    assert.equal(open.getAttribute("aria-label"), "Open in Editor");
    assert.equal(open.getAttribute("title"), "Open in Editor");
```

1f. In `test/remoteProject.test.tsx`, replace lines 88-89 with:

```tsx
    assert.ok(html.includes("data-env-changes"), "the changes link stays on remotes");
```

1g. In `test/mergeQueueChips.test.tsx`, replace the test "opts into Spotlight per repo and previews through spotlightLane" (lines 270-344) with:

```tsx
  it("collapses with a 0 count when no lanes are claimed, opens once lanes exist", async () => {
    const empty = await mount(card({ lanes: [] }));
    await empty.flush();
    const section = empty.query("[data-lanes]") as HTMLDetailsElement;
    assert.equal(section.tagName, "DETAILS");
    assert.equal(section.open, false);
    assert.match(section.querySelector("summary")?.textContent ?? "", /Lanes\s*0/);
    empty.unmount();
    const full = await mount(card({ lanes: [lane()] }));
    await full.flush();
    assert.equal((full.query("[data-lanes]") as HTMLDetailsElement).open, true);
    full.unmount();
  });

  // The opt-in half moved to Settings → Git (settingsModal.test.tsx Spotlight).
  it("previews through spotlightLane when the project's Spotlight flag is on", async () => {
    const spots: { projectId: string; lane: number }[] = [];
    const previews: { projectId: string; lane: number }[] = [];
    const on = await mount(
      card({
        lanes: [lane()],
        spotlight: true,
        spotlightLane: async (input) => {
          spots.push(input);
          return {
            lane: input.lane,
            sha: "spot",
            files: ["from-a.txt"],
            path: "/tmp/repo",
            spotlight: true,
          };
        },
        preview: async (input) => {
          previews.push(input);
          return {
            lane: input.lane,
            sha: "abc",
            files: ["src/a.ts"],
            path: "/tmp/repo",
          };
        },
      }),
    );
    await on.flush();
    assert.equal(on.query("[data-lane-spotlight]"), null, "the opt-in lives in Settings");
    await on.click(on.query("[data-lane-preview='1']"));
    assert.deepEqual(spots, [{ projectId: "p1", lane: 1 }]);
    assert.deepEqual(previews, []);
    on.unmount();
  });
```

Also delete `setSpotlight` from the `card()` options type and from the `<MergeQueueCard` element (`setSpotlight={opts.setSpotlight}`).

1h. In `test/appWiring.test.tsx`, replace "Environment PR card opens the pull-requests view" with:

```tsx
  it("pull requests open from the sidebar Review nav, not an Environment card", async () => {
    const fake = createFakeCoder();
    const m = await boot(fake);
    try {
      await expandAgents(m);
      assert.equal(
        m.query('[data-view-nav="prs"]'),
        null,
        "left bar must not keep a Pull requests row",
      );
      assert.equal(m.query("[data-open-prs]"), null, "Environment no longer duplicates it");
      const review = m.query('[data-view-nav="review"]');
      assert.ok(review, "the sidebar Review nav is the PR list's home");
      await m.click(review as HTMLElement);
      await m.flush();
      await inAct(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await m.flush();
      assert.ok(m.query("[data-pr-list]"), "PR list must render");
    } finally {
      m.unmount();
    }
  });
```

1i. In `test/forkHandoff.test.tsx`, insert after "Header Fork also hits threads.fork without provider" (added in Task 4), inside the same `describe`:

```tsx
  it("the inspector has no Fork card; the header and card menu are the homes", async () => {
    const d = decoy();
    const s = source();
    const o = otherProjectThread();
    const fake = createFakeCoder({
      projects: [
        project({ id: "p1", slug: "acme/one", name: "one", path: "/tmp/one" }),
        project({ id: "p2", slug: "acme/two", name: "two", path: "/tmp/two" }),
      ],
      providers,
      threads: [d, s, o],
      details: {
        "t-decoy": detail({ thread: d }),
        "t-source-fork": detail({ thread: s, messages: STARTED }),
        "t-p2": detail({ thread: o }),
      },
    });
    const m = await boot(fake);
    await selectThread(m, "source handoff thread");
    assert.equal(m.query("[data-thread-fork-card]"), null, "no Environment Fork card");
    const forks = m.queryAll("[data-thread-fork]");
    assert.equal(forks.length, 1, "exactly one Fork button on screen");
    assert.ok(forks[0]!.closest("[data-thread-header]"), "and it is the header's");
    await openCardMenu(m, "t-source-fork");
    assert.ok(
      document.querySelector('[data-fork-btn="t-source-fork"]'),
      "card menu keeps Fork",
    );
    assert.ok(
      document.querySelector('[data-handoff-provider="grok"]'),
      "card menu keeps Hand off",
    );
    m.unmount();
  });
```

1j. Delete the drag-reorder suite:

```bash
git rm test/envSectionReorder.test.tsx
```

- [ ] **Step 2: Run them to make sure they fail.**
Run: `node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test test/environmentCards.test.tsx test/editorCard.test.tsx test/remoteProject.test.tsx test/mergeQueueChips.test.tsx test/appWiring.test.tsx test/forkHandoff.test.tsx`
Expected: FAIL, for example "drops the duplicate cards…" (`[data-prs-card]` still present when wired) and the fixed-order test (still `data-env-section` wrappers).

- [ ] **Step 3: Rebuild the Environment code in `src/components/AgentsPanel.tsx`, bottom-up.**

3a. In the `tab === "git"` branch, replace the whole `<GitTab … />` element with:

```tsx
        <GitTab
          thread={thread}
          project={project}
          onViewChanges={onViewChanges}
          fetchDiff={fetchDiff}
          listCheckpoints={listCheckpoints}
          restoreCheckpoint={restoreCheckpoint}
          listLocalServers={listLocalServers}
          revealInFinder={revealInFinder}
          openInEditor={openInEditor}
          gitSyncInfo={gitSyncInfo}
          gitFetch={gitFetch}
          gitRepoInfo={gitRepoInfo}
          gitPull={gitPull}
          listThreadSummaries={listThreadSummaries}
          listDevScripts={listDevScripts}
          startDevServer={startDevServer}
          stopDevServer={stopDevServer}
          devServerStatus={devServerStatus}
          setVerifyCommand={setVerifyCommand}
          runVerify={runVerify}
          claimLane={claimLane}
          listLanes={listLanes}
          previewLane={previewLane}
          restorePreview={restorePreview}
          recycleWedgedLanes={recycleWedgedLanes}
          spotlightLane={spotlightLane}
        />
```

In the `AgentsPanel` destructuring:
- delete `activeView,`, `onOpenPrs,`, `onFork,` and `setSpotlight,`
- add `fetchDiff,` after `onViewChanges,`

Their interface entries stay until Task 8.

3b. Replace `export function GitTab(…) { … }` (lines 2169-2705) with:

```tsx
export function GitTab({
  thread,
  project,
  onViewChanges,
  fetchDiff,
  listCheckpoints,
  restoreCheckpoint,
  listLocalServers,
  revealInFinder,
  openInEditor,
  gitSyncInfo,
  gitFetch,
  gitRepoInfo,
  gitPull,
  listThreadSummaries,
  listDevScripts,
  startDevServer,
  stopDevServer,
  devServerStatus,
  setVerifyCommand,
  runVerify,
  claimLane,
  listLanes,
  previewLane,
  restorePreview,
  recycleWedgedLanes,
  spotlightLane,
}: {
  thread: ThreadInfo | null;
  project: ProjectInfo | null;
  onViewChanges: () => void;
  /** Selected thread's diff; only `files.length` is read ("N changed files ›"). */
  fetchDiff?: () => Promise<DiffResult>;
  listCheckpoints: (threadId: string) => Promise<CheckpointInfo[]>;
  restoreCheckpoint: (threadId: string, sha: string) => Promise<void>;
  listLocalServers: (threadId: string) => Promise<LocalServerInfo[]>;
  revealInFinder?: () => Promise<void>;
  openInEditor?: () => Promise<void>;
  gitSyncInfo?: (threadId: string) => Promise<GitSyncInfo>;
  gitFetch?: (threadId: string) => Promise<void>;
  gitRepoInfo?: (threadId: string) => Promise<GitRepoInfo>;
  gitPull?: (threadId: string) => Promise<GitPullResult>;
  /** threads:summaries passthrough for the one-line recap (#1398 scoped). */
  listThreadSummaries?: (input?: ThreadSummariesInput) => Promise<ThreadSummaryInfo[]>;
  claimLane?: (input: { threadId: string }) => Promise<MergeLaneClaim>;
  listLanes?: (input: { projectId: string }) => Promise<MergeLaneInfo[]>;
  previewLane?: (input: {
    projectId: string;
    lane: number;
  }) => Promise<MergeLanePreview>;
  restorePreview?: (input: { projectId: string }) => Promise<MergeLaneRestore>;
  recycleWedgedLanes?: (input: {
    projectId: string;
  }) => Promise<MergeLaneRecycle[]>;
  spotlightLane?: (input: {
    projectId: string;
    lane: number;
  }) => Promise<MergeLanePreview>;
  listDevScripts: (threadId: string) => Promise<string[]>;
  startDevServer: (threadId: string, script: string) => Promise<DevServerState>;
  stopDevServer: (threadId: string) => Promise<DevServerState>;
  devServerStatus: (threadId: string) => Promise<DevServerState>;
  setVerifyCommand?: (
    threadId: string,
    command: string | null,
  ) => Promise<void>;
  runVerify?: (threadId: string) => Promise<VerifyResult>;
}) {
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([]);
  const [checkpointsLoading, setCheckpointsLoading] = useState(false);
  const [checkpointError, setCheckpointError] = useState<string | null>(null);
  const [restoreConfirm, setRestoreConfirm] = useState<CheckpointInfo | null>(
    null,
  );
  const [restorePending, setRestorePending] = useState(false);
  const closeRestoreConfirm = useCallback(() => {
    if (restorePending) return;
    setRestoreConfirm(null);
  }, [restorePending]);
  useEscapeClose(
    restoreConfirm != null && !restorePending,
    closeRestoreConfirm,
  );
  const restoreDialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(restoreConfirm != null, restoreDialogRef);
  const [now, setNow] = useState(() => Date.now());
  const [sync, setSync] = useState<GitSyncInfo | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pullResult, setPullResult] = useState<GitPullResult | null>(null);
  const [changed, setChanged] = useState<number | null>(null);
  const [activity, setActivity] = useState<{ text: string; at: number } | null>(
    null,
  );

  const threadId = thread?.id ?? null;
  const threadStatus = thread?.status ?? null;
  const isWorking = threadStatus === "working";

  // Clear per-thread state when the selected thread changes so a stale
  // error from row A never shows on row B.
  useEffect(() => {
    setCheckpoints([]);
    setCheckpointError(null);
    setRestoreConfirm(null);
    setRestorePending(false);
    setSync(null);
    setSyncing(false);
    setPulling(false);
    setPullResult(null);
    setChanged(null);
  }, [threadId]);

  // Relative ages tick (same 60s cadence as the sidebar).
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const refreshCheckpoints = useCallback(async () => {
    if (!thread?.id || !thread.worktreePath) {
      setCheckpoints([]);
      return;
    }
    setCheckpointsLoading(true);
    try {
      const list = await listCheckpoints(thread.id);
      setCheckpoints(list);
      setCheckpointError(null);
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Failed to load checkpoints";
      setCheckpointError(msg);
    } finally {
      setCheckpointsLoading(false);
    }
  }, [thread?.id, thread?.worktreePath, listCheckpoints]);

  // Fetch on tab mount / thread change / after a run settles (status).
  // GitTab only mounts while the Environment tab is selected.
  useEffect(() => {
    void refreshCheckpoints();
  }, [refreshCheckpoints, thread?.status]);

  const refreshSync = useCallback(async () => {
    if (!thread?.id || !gitSyncInfo) {
      setSync(null);
      return;
    }
    try {
      const info = await gitSyncInfo(thread.id);
      setSync(info);
    } catch {
      setSync({ hasUpstream: false });
    }
  }, [thread?.id, gitSyncInfo]);

  useEffect(() => {
    void refreshSync();
  }, [refreshSync, thread?.status]);

  const handleSync = async () => {
    if (!thread || !gitFetch || syncing) return;
    setSyncing(true);
    try {
      await gitFetch(thread.id);
      await refreshSync();
    } catch {
      // Keep the last badge; fetch errors stay quiet.
    } finally {
      setSyncing(false);
    }
  };

  // One-line recap: this thread's last assistant line, scoped (#1398).
  useEffect(() => {
    let cancelled = false;
    if (!threadId || !listThreadSummaries) {
      setActivity(null);
      return;
    }
    listThreadSummaries({ threadIds: [threadId] })
      .then((list) => {
        if (cancelled) return;
        const entry = Array.isArray(list)
          ? list.find((s) => s && s.id === threadId)
          : undefined;
        setActivity(entry?.lastActivity ?? null);
      })
      .catch(() => {
        if (!cancelled) setActivity(null);
      });
    return () => {
      cancelled = true;
    };
  }, [threadId, threadStatus, listThreadSummaries]);

  // "N changed files ›": the same git:diff the Git view and the details card
  // read. Thread switch and status change only, never on a timer.
  useEffect(() => {
    if (!threadId || !fetchDiff) {
      setChanged(null);
      return;
    }
    let live = true;
    fetchDiff()
      .then((diff) => {
        if (live) {
          setChanged(Array.isArray(diff?.files) ? diff.files.length : null);
        }
      })
      .catch(() => {
        if (live) setChanged(null);
      });
    return () => {
      live = false;
    };
  }, [threadId, threadStatus, fetchDiff]);

  // `git pull --ff-only`; failures (dirty tree, no upstream, diverged)
  // arrive in-band.
  const handlePull = async () => {
    if (!threadId || !gitPull || pulling) return;
    setPulling(true);
    setPullResult(null);
    try {
      setPullResult(await gitPull(threadId));
    } catch (err) {
      setPullResult({
        ok: false,
        reason:
          err instanceof Error && err.message ? err.message : "Pull failed",
      });
    } finally {
      setPulling(false);
    }
  };

  const handleRestoreConfirm = async () => {
    if (!thread || !restoreConfirm || restorePending || isWorking) return;
    const cp = restoreConfirm;
    setRestorePending(true);
    setCheckpointError(null);
    try {
      await restoreCheckpoint(thread.id, cp.sha);
      setRestoreConfirm(null);
      await refreshCheckpoints();
      // Refresh the center Changes surface (same open path bumps nonce).
      onViewChanges();
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Restore failed";
      setCheckpointError(msg);
      setRestoreConfirm(null);
    } finally {
      setRestorePending(false);
    }
  };

  const remote = Boolean(project?.remoteHost);
  // Lanes are local-only and project-scoped, so they show without a thread too.
  const lanes =
    remote ||
    !project ||
    !claimLane ||
    !listLanes ||
    !previewLane ||
    !restorePreview ||
    !recycleWedgedLanes ? null : (
      <MergeQueueCard
        threadId={threadId}
        projectId={project.id}
        claimLane={claimLane}
        listLanes={listLanes}
        previewLane={previewLane}
        restorePreview={restorePreview}
        recycleWedgedLanes={recycleWedgedLanes}
        spotlight={project.spotlight === true}
        spotlightLane={spotlightLane}
      />
    );

  if (!thread) {
    return (
      <div className={inspector.pane} data-env-tools="">
        <p className={inspector.empty} data-env-empty="">
          Select a thread to see its workspace.
        </p>
        {lanes}
      </div>
    );
  }

  const syncLabelText = sync ? syncLabel(sync) : null;
  const branchLabel = thread.branch ?? project?.slug ?? thread.provider;
  const changesLabel =
    changed == null
      ? "Changes"
      : changed === 0
        ? "No changed files"
        : `${changed} changed ${changed === 1 ? "file" : "files"}`;
  const prLabel =
    thread.prNumber == null
      ? null
      : thread.prState
        ? `#${thread.prNumber} ${thread.prState.toLowerCase()}`
        : `#${thread.prNumber}`;

  return (
    <>
      <div className={inspector.pane} data-env-tools="">
        <section
          className={inspector.section}
          aria-label="Status"
          data-env-status=""
        >
          <div className={inspector.row}>
            <span
              className={styles.gitStatusLine}
              data-env-branch=""
              title={branchLabel}
            >
              {branchLabel}
            </span>
            {syncLabelText ? (
              <span className={styles.syncBadge} data-sync-badge="">
                {syncLabelText}
              </span>
            ) : null}
            <span className={inspector.action}>
              {gitFetch ? (
                <button
                  type="button"
                  className={styles.syncBtn}
                  data-sync-btn=""
                  onClick={() => void handleSync()}
                  disabled={syncing}
                  title="Fetch from remote"
                >
                  {syncing ? "Syncing…" : "Sync"}
                </button>
              ) : null}
              {!remote && gitPull ? (
                <button
                  type="button"
                  className={styles.syncBtn}
                  data-pull-btn=""
                  onClick={() => void handlePull()}
                  disabled={pulling}
                  title="Pull from upstream (fast-forward only)"
                >
                  {pulling ? (
                    <>
                      <span className={styles.btnSpinner} aria-hidden />
                      Pulling…
                    </>
                  ) : (
                    "Pull"
                  )}
                </button>
              ) : null}
            </span>
          </div>
          {pullResult ? (
            <p
              className={pullResult.ok ? styles.pullResult : styles.pullError}
              data-pull-result=""
              role={pullResult.ok ? undefined : "alert"}
            >
              {pullResult.ok ? pullResult.summary : pullResult.reason}
            </p>
          ) : null}
          <div className={inspector.row}>
            <button
              type="button"
              className={inspector.linkBtn}
              data-env-changes=""
              onClick={onViewChanges}
            >
              {changesLabel} ›
            </button>
            {prLabel ? (
              <span data-env-pr="">
                {thread.prUrl ? (
                  // Link out only when a URL was recorded; never invent one.
                  <a
                    className={styles.recapPrLink}
                    data-recap-pr=""
                    href={thread.prUrl}
                    target="_blank"
                    rel="noreferrer"
                    title={thread.prUrl}
                  >
                    {prLabel} ›
                  </a>
                ) : (
                  prLabel
                )}
              </span>
            ) : null}
          </div>
          <p className={inspector.line} data-recap-activity="">
            {activity?.text ?? "No activity yet"}
          </p>
          {thread.status === "failed" && thread.lastError ? (
            <p
              className={styles.pullError}
              data-env-error=""
              role="alert"
              title={thread.lastError}
            >
              {thread.lastError.replace(/\s+/g, " ").trim()}
            </p>
          ) : null}
          <ScmNotice project={project} />
          {remote ? (
            <p className={inspector.line} data-remote-unavailable="">
              Not available on remote projects: dev server, verification,
              checkpoints and lanes.
            </p>
          ) : null}
          <div className={inspector.row} data-env-links="">
            <RepositoryLink threadId={thread.id} gitRepoInfo={gitRepoInfo} />
            {remote ? null : (
              <EditorCard
                hasThread
                onReveal={() => void revealInFinder?.()}
                onOpen={() => void openInEditor?.()}
              />
            )}
          </div>
        </section>
        {remote ? null : (
          <InspectorSection title="Run" data-env-run="">
            <DevServerCard
              threadId={thread.id}
              listDevScripts={listDevScripts}
              startDevServer={startDevServer}
              stopDevServer={stopDevServer}
              devServerStatus={devServerStatus}
            />
            {setVerifyCommand && runVerify ? (
              <VerifyCard
                thread={thread}
                setVerifyCommand={setVerifyCommand}
                runVerify={runVerify}
              />
            ) : null}
            <LocalServersCard
              threadId={thread.id}
              listLocalServers={listLocalServers}
            />
          </InspectorSection>
        )}
        {remote ? null : (
          <CheckpointsCard
            thread={thread}
            checkpoints={checkpoints}
            loading={checkpointsLoading}
            restorePending={restorePending}
            cardError={checkpointError}
            isWorking={isWorking}
            onRestoreRequest={(cp) => {
              if (isWorking || restorePending) return;
              setCheckpointError(null);
              setRestoreConfirm(cp);
            }}
            onDismissError={() => setCheckpointError(null)}
            now={now}
          />
        )}
        {lanes}
      </div>
      {restoreConfirm && (
        <div
          className={styles.confirmOverlay}
          role="presentation"
          onClick={closeRestoreConfirm}
        >
          <div
            ref={restoreDialogRef}
            className={styles.confirmDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="restore-checkpoint-title"
            tabIndex={-1}
            data-restore-confirm={restoreConfirm.sha}
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="restore-checkpoint-title"
              className={styles.confirmTitle}
            >
              Restore turn {restoreConfirm.turn} ({shortSha(restoreConfirm.sha)}
              )?
            </h2>
            <p className={styles.confirmBody}>
              This resets the worktree and the conversation to this checkpoint.
              Later messages and later checkpoints&apos; work will be lost. The
              main repository is not touched.
            </p>
            <div className={styles.confirmActions}>
              <button
                type="button"
                className={styles.confirmDanger}
                data-restore-confirm-submit=""
                disabled={restorePending || isWorking}
                aria-busy={restorePending || undefined}
                onClick={() => void handleRestoreConfirm()}
              >
                {restorePending ? "Restoring…" : "Restore checkpoint"}
              </button>
              <button
                type="button"
                className={styles.confirmCancel}
                data-restore-confirm-cancel=""
                disabled={restorePending}
                onClick={closeRestoreConfirm}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
```

3c. `MergeQueueCard` (1912-2167):
- Delete the `setSpotlight,` parameter and its type member (`setSpotlight?: (input: { projectId: string; enabled: boolean; }) => Promise<MergeSpotlight>;`).
- Delete the `spotlightOn` state and its effect (lines 1951-1955).
- Change `if (spotlightOn && spotlightLane) {` to `if (spotlight && spotlightLane) {`.
- Delete the whole `{setSpotlight ? ( <label … data-lane-spotlight-label=""> … </label> ) : null}` block (lines 2132-2149).
- Replace the opening wrapper (lines 2000-2010):
  ```tsx
      <section className={styles.gitCard} data-lanes="">
        <div className={styles.gitCardLabel}>
          <svg {...LABEL_ICON_PROPS} className={styles.labelIcon}>
            <path d="M3 4.5h6.5" />
            <path d="M3 8h10" />
            <path d="M3 11.5h6.5" />
            <circle cx="12.5" cy="4.5" r="1.4" />
            <circle cx="12.5" cy="11.5" r="1.4" />
          </svg>
          Lanes
        </div>
  ```
  with:
  ```tsx
      <InspectorSection
        title="Lanes"
        count={lanes.length}
        collapsible
        defaultOpen={lanes.length > 0}
        data-lanes=""
      >
  ```
- Change its closing `</section>` (the one right before `  );\n}` at the end of `MergeQueueCard`) to `</InspectorSection>`.

3d. `CheckpointsCard`: replace the opening wrapper (lines 1827-1832):
```tsx
    <section className={styles.gitCard} data-checkpoints="">
      <div className={styles.gitCardLabel}>
        <svg {...LABEL_ICON_PROPS} className={styles.labelIcon}>
          <path d="M4.5 2.5h7a.5.5 0 0 1 .5.5v10l-4-2.6L4 13V3a.5.5 0 0 1 .5-.5Z" />
        </svg>
        Checkpoints
      </div>
```
with:
```tsx
    <InspectorSection
      title="Checkpoints"
      count={checkpoints.length}
      collapsible
      defaultOpen={false}
      data-checkpoints=""
    >
```
Then change its closing `</section>` to `</InspectorSection>`.

3e. Delete lines 1523-1788: the `RecapCard` doc comment and function, `ENV_DRAG_MIME`, `ENV_REORDER_HELP_ID`, `isEnvDrag`, `envDragSectionId`, `dropEdgeFor`, `envSectionFilled`, `visibleEnvSectionIds` and `EnvSection`. Stop at the blank line before `/** Byte-equal to electron/worktrees.js restoreCheckpoint run-active guard. */`.

3f. Delete `PullCard` and its doc comment (lines 1438-1522).

3g. Replace `RepositoryCard` and its doc comment (lines 1364-1436) with:

```tsx
/**
 * Repository link: the thread root's git origin as owner/repo, linking to
 * the host. Renders nothing without an origin. No other surface shows it.
 */
function RepositoryLink({
  threadId,
  gitRepoInfo,
}: {
  threadId: string | null;
  gitRepoInfo?: (threadId: string) => Promise<GitRepoInfo>;
}) {
  const [info, setInfo] = useState<GitRepoInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!threadId || !gitRepoInfo) {
      setInfo(null);
      return;
    }
    gitRepoInfo(threadId)
      .then((res) => {
        if (!cancelled) setInfo(res && typeof res === "object" ? res : null);
      })
      .catch(() => {
        if (!cancelled) setInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [threadId, gitRepoInfo]);

  if (!info || !info.ok) return null;

  return (
    <a
      className={styles.repoLink}
      href={info.webUrl}
      target="_blank"
      rel="noreferrer"
      title={info.webUrl}
      data-repo-card=""
      data-repo-link=""
    >
      <span className={styles.repoSlug}>
        {info.owner}/{info.repo}
      </span>
      <svg
        width="12"
        height="12"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className={styles.repoExternal}
      >
        <path d="M6.5 3.5H4A1.5 1.5 0 0 0 2.5 5v7A1.5 1.5 0 0 0 4 13.5h7a1.5 1.5 0 0 0 1.5-1.5V9.5" />
        <path d="M9.5 2.5h4v4" />
        <path d="M13.5 2.5 8 8" />
      </svg>
    </a>
  );
}
```

3h. Replace `ScmCard` and its doc comment (lines 1332-1362) with:

```tsx
/**
 * Per-project source-control notice (issue #521): one inline line, only for
 * Jujutsu (unsupported). Plain git is the assumed default and renders nothing.
 */
function ScmNotice({ project }: { project: ProjectInfo | null }) {
  const scm = project?.scm;
  if (!scm || scm.kind !== "jj") return null;
  return (
    <p className={inspector.line} data-scm-card="" title={scm.detail}>
      <span className={styles.scmBadge} data-scm-badge={scm.support}>
        jj · unsupported
      </span>
      {scm.detail ? <span data-scm-detail=""> {scm.detail}</span> : null}
    </p>
  );
}
```

3i. Change the three Run blocks from cards to blocks:
- **`LocalServersCard`.** Replace lines 1295-1306:
  ```tsx
      <section className={styles.gitCard} data-local-servers="">
        <div className={`${styles.gitCardLabel} ${styles.serverLabel}`}>
          <svg {...LABEL_ICON_PROPS} className={styles.labelIcon}>
            <rect x="3" y="3" width="10" height="4" rx="1" />
            <rect x="3" y="9" width="10" height="4" rx="1" />
            <path d="M5.5 5h.01M5.5 11h.01" />
          </svg>
          Local servers
          <span className={styles.serverCount} data-local-servers-count="">
            {servers.length}
          </span>
        </div>
  ```
  with:
  ```tsx
      <div className={inspector.block} data-local-servers="">
        <div className={inspector.subhead}>
          Local servers
          <span className={styles.serverCount} data-local-servers-count="">
            {servers.length}
          </span>
        </div>
  ```
  and its closing `</section>` with `</div>`.
- **`VerifyCard`.** Replace lines 1143-1150 (`<section className={styles.gitCard} data-verify-card="">` through the `Verification` label's `</div>`) with:
  ```tsx
      <div className={inspector.block} data-verify-card="">
        <div className={inspector.subhead}>Verification</div>
  ```
  and its closing `</section>` with `</div>`.
- **`DevServerCard`.** Replace lines 968-975 (`<section className={styles.gitCard} data-dev-server="">` through the `Dev server` label's `</div>`) with:
  ```tsx
      <div className={inspector.block} data-dev-server="">
        <div className={inspector.subhead}>Dev server</div>
  ```
  and its closing `</section>` with `</div>`.

3j. Replace `EditorCard` (lines 759-804) with the icon-button version (decided 2026-10-04: small icon links):

```tsx
/** Finder + editor icon links for the selected thread (status header row). */
export function EditorCard({
  hasThread,
  onReveal,
  onOpen,
}: {
  hasThread: boolean;
  onReveal: () => void;
  onOpen: () => void;
}) {
  return (
    <span className={inspector.row} data-editor="">
      {!hasThread ? (
        <span className={inspector.muted} data-editor-hint="">
          Select a thread to open its folder.
        </span>
      ) : null}
      <button
        type="button"
        className={inspector.iconBtn}
        data-editor-reveal=""
        aria-label="Open in Finder"
        title="Open in Finder"
        onClick={onReveal}
        disabled={!hasThread}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M2.5 4.5A1.5 1.5 0 0 1 4 3h2.5l1.5 1.5h4A1.5 1.5 0 0 1 13.5 6v5.5A1.5 1.5 0 0 1 12 13H4a1.5 1.5 0 0 1-1.5-1.5v-7Z" />
        </svg>
      </button>
      <button
        type="button"
        className={inspector.iconBtn}
        data-editor-open=""
        aria-label="Open in Editor"
        title="Open in Editor"
        onClick={onOpen}
        disabled={!hasThread}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m5.5 5-3 3 3 3M10.5 5l3 3-3 3" />
        </svg>
      </button>
    </span>
  );
}
```

3k. Delete `PullRequestsCard`, `ChangesCard` and `DisplayPrefsCard` (lines 521-637, from `function PullRequestsCard({` through the blank line before `export function ForkCard({`). `ForkCard` is exported and is deleted in Task 8.

3l. Props interface: after `onViewChanges: () => void;` (line 229), add:

```tsx
  /** Selected thread's working diff, for the Environment "N changed files ›" link. */
  fetchDiff?: () => Promise<DiffResult>;
```

3m. Imports:
- Delete `type DragEvent as ReactDragEvent,` and `type MutableRefObject,` from the `react` import.
- Delete the `../uiPrefs` import (lines 99-108) and the `../envSectionOrder` import (lines 109-118).
- Add `DiffResult,` to the `../shared/ipc` type import.
- Add after `import { SkillsTab } from "./SkillsTab";`:

```tsx
import { InspectorSection } from "./InspectorSection";
import inspector from "./Inspector.module.css";
```

Then run `npx tsc --noEmit` and delete exactly the unused locals and imports it reports. `type ReactNode` is the expected one if nothing else uses it.

- [ ] **Step 4: Wire `fetchDiff` in App.** In `src/App.tsx`, in the `<AgentsPanel` element, change:

```tsx
        onViewChanges={openChanges}
        listCheckpoints={listCheckpoints}
```
to
```tsx
        onViewChanges={openChanges}
        fetchDiff={fetchDiff}
        listCheckpoints={listCheckpoints}
```

`fetchDiff` is already destructured from `useCoder()`, and it is a stable `useCallback` (`src/useCoder.ts:3096`), so `memo(AgentsPanel)` holds.

- [ ] **Step 5: Fix the stale comment.** In `src/uiPrefs.ts:141-142`, change `Environment can turn it off so a paste lands in the textarea as text.` to `Settings → General → Display can turn it off so a paste lands in the textarea as text.`

- [ ] **Step 6: Run the tests, typecheck and build.**
Run: `npx tsc --noEmit && node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test test/environmentCards.test.tsx test/editorCard.test.tsx test/remoteProject.test.tsx test/mergeQueueChips.test.tsx test/appWiring.test.tsx test/forkHandoff.test.tsx test/syncBadge.test.tsx test/devServer.test.tsx test/localServers.test.tsx test/verifyCard.test.ts test/checkpoints.test.tsx test/agentsCollapse.test.tsx test/envSectionOrder.test.ts && npx vite build`
Expected: tsc clean, 0 fail, `✓ built`. `envSectionOrder.test.ts` still passes, because the module is deleted in Task 8.

If a `test/checkpoints.test.tsx` focus test fails because jsdom will not focus a control inside the now-closed Checkpoints `<details>`, open the section in that test right after mount. That is the user's real first step anyway:

```tsx
    (m.query("[data-checkpoints]") as HTMLDetailsElement).open = true;
```

Add it right before the first `[data-checkpoint-restore]` click in each failing test. Do not change `CheckpointsCard`'s `defaultOpen={false}`.

- [ ] **Step 7: Commit.**
```bash
git add -A src/components/AgentsPanel.tsx src/App.tsx src/uiPrefs.ts test/environmentCards.test.tsx test/editorCard.test.tsx test/remoteProject.test.tsx test/mergeQueueChips.test.tsx test/appWiring.test.tsx test/forkHandoff.test.tsx test/envSectionReorder.test.tsx
git commit -m "Environment tab: fixed status header, Run, Checkpoints, Lanes; drop duplicates and reordering"
```

---
### Task 6: Agents tab

**Job:** who is working on this thread, and their progress. The order is: Session line, Team (crew leads only) or a "Lead: <title> ›" line (crew workers), Tasks, Subagents, Hypotheses (collapsed). A workflow gets its phase view inside one section.

**Files:**
- Modify: `src/components/AgentsPanel.tsx`. Line numbers are from `810f9243`, and Task 5 shifted everything below line 521 up, so locate each edit by its quoted anchor:
  - `SessionCard` (410-519)
  - `HypothesisLedgerCard` (2779-2828)
  - `CrewTaskList` (2834-2880)
  - the `AgentsContent` render (`const subagentSection =` through the workflow `return`, 3115-3543)
  - the `format` and `contextRing` imports
- Test: `test/teamView.test.tsx`

**Interfaces:**
- Consumes: `InspectorSection` and `inspector` classes (Task 1). Task 5 already imported both.
- Produces:
  - `SessionLine({ thread, usage, providers, role? })`, which replaces `SessionCard`
  - DOM hooks: `[data-session-line]` (the line `<p>`, inside `section[aria-label="Session"]`), `[data-session-tokens]`, `[data-workflow]`, `[data-crew-lead]` (the Lead line button, inside `section[aria-label="Lead"]`)
  - Team, Tasks and Subagents are `InspectorSection`s with `aria-label` equal to their titles
  - Hypotheses is a collapsed `<details data-hypothesis-ledger>`
- Leave the `AgentsContent` effects and handlers alone: the project-scoped summaries poll, crew tasks, the `isCrewLead` crew-integration effect with its `integrationSeq` guard, the `CrewIntegration` callbacks (which also bump `integrationSeq`), `team`, `wait` and `groups`. The perf branch owns them. Every edit below moves JSX only; the `<CrewIntegration … />` element is kept byte-for-byte.

**Existing tests that assert removed or changed UI** (all in `test/teamView.test.tsx`):
- "worker: links back to the orchestrator row" (142-166)
  - The worker-side Team section is replaced by a "Lead: <title> ›" line (discrepancy 11, resolved).
  - Every assertion is kept: the "Worker" chip, the orchestrator title, and "clicking selects the orchestrator" (now on `[data-crew-lead]`).
  - Added: no `[aria-label="Team"]` for a worker, and no Lead line when the lead is missing.
- "plain thread: no team section, SessionCard unchanged" (168-177). `/Session/` text becomes `[data-session-line]`.
- "plain thread: lists recorded hypotheses newest-first by status" (667-729). The `data-env-grip` and `data-env-list` assertions (lines 704-712) are replaced by "collapsed `<details>` by default". Every row assertion is kept.
- The SessionCard `unmetered` and `usage not reported` tests (287-336) stay unchanged. They match text the session line still shows.

- [ ] **Step 1: Write the failing tests.** In `test/teamView.test.tsx`:

1a. Replace "worker: links back to the orchestrator row" (lines 142-166) with:

```tsx
  it("worker: Worker chip and a Lead line back to the orchestrator; no Team section", async () => {
    const selected: string[] = [];
    const m = await mount(
      content(
        thread({
          id: "t-work",
          title: "Fork: Plan the fix",
          handoffFrom: "t-orch",
          orchWorker: true,
        }),
        [ORCHESTRATOR, WORKER],
        (id) => selected.push(id),
      ),
    );
    await m.flush();
    assert.match(
      m.query("[data-session-line]")?.textContent ?? "",
      /Worker/,
      "selected card carries the Worker chip",
    );
    assert.equal(m.query('[aria-label="Team"]'), null, "Team is for crew leads only");
    const lead = m.query("[data-crew-lead]");
    assert.ok(lead, "a worker links back to its lead");
    assert.equal(lead.textContent, "Lead: Plan the fix ›", "orchestrator row title");
    await m.click(lead);
    assert.deepEqual(selected, ["t-orch"], "clicking the Lead line selects the orchestrator");
    m.unmount();
  });

  it("worker whose lead is not in the project shows no Lead line", async () => {
    const m = await mount(
      content(
        thread({
          id: "t-work",
          title: "Fork: Plan the fix",
          handoffFrom: "t-orch",
          orchWorker: true,
        }),
        [WORKER],
      ),
    );
    await m.flush();
    assert.equal(m.query("[data-crew-lead]"), null);
    assert.equal(m.query('[aria-label="Team"]'), null);
    m.unmount();
  });

1b. In "plain thread: no team section, SessionCard unchanged" (lines 168-177), replace `assert.match(text, /Session/, "plain session card still renders");` with:

```tsx
    assert.ok(m.query("[data-session-line]"), "plain session line still renders");
```

1c. In "plain thread: lists recorded hypotheses newest-first by status", replace lines 704-712 (from `assert.equal(card.querySelector("[data-env-grip]")` through `assert.equal(m.query("[data-env-list]"), null);`) with:

```tsx
    assert.equal(card.tagName, "DETAILS");
    assert.equal(
      (card as HTMLDetailsElement).open,
      false,
      "hypotheses start collapsed",
    );
    assert.equal(card.querySelector("[data-section-count]")?.textContent, "3");
```

1d. Append inside `describe("Agents team view", …)`:

```tsx
  it("session line: provider · status · turns · cost; tokens muted; no Model, Permission or Context", async () => {
    const m = await mount(
      <AgentsContent
        workflow={null}
        thread={thread({ model: "opus-x", permissionMode: "acceptEdits" })}
        usage={{
          model: "opus-x",
          inputTokens: 1200,
          outputTokens: 34,
          costUsd: 0.5,
          turns: 2,
          contextTokens: 50_000,
          contextWindow: 200_000,
        }}
        providers={PROVIDERS}
        rosterKey=""
        listThreadSummaries={async () => []}
      />,
    );
    await m.flush();
    assert.equal(
      m.query("[data-session-line]")?.textContent,
      "Claude Code · idle · 2 turns · $0.50",
    );
    assert.equal(
      m.query("[data-session-tokens]")?.textContent,
      "1,200 in · 34 out tokens",
    );
    const text = m.text();
    assert.doesNotMatch(text, /opus-x/, "model lives in the composer");
    assert.doesNotMatch(text, /Permission|Accept edits/, "permission lives in the composer");
    assert.doesNotMatch(text, /Context|of 200/, "context lives in the header ring");
    m.unmount();
  });

  it("crew lead: Session, Team, Tasks, Subagents, Hypotheses in that order", async () => {
    const m = await mount(
      <AgentsContent
        workflow={null}
        thread={thread({
          subagents: [
            {
              id: "s1",
              description: "Scan the repo",
              agentType: null,
              status: "running",
            },
          ],
          hypotheses: [
            {
              id: "h1",
              claim: "Flush races the stream",
              status: "validated",
              reason: "",
              at: Date.now(),
            },
          ],
        })}
        usage={null}
        providers={PROVIDERS}
        rosterKey="t-orch:idle,t-work:working"
        listThreadSummaries={async () => [ORCHESTRATOR, WORKER]}
        listCrewTasks={async () => ({
          rootThreadId: "t-orch",
          tasks: [
            {
              id: "T1",
              title: "Split the parser",
              needs: [],
              status: "open",
              owner: null,
              note: "",
              attempts: [],
              createdAt: 1,
              updatedAt: 1,
              blocked: false,
            },
          ],
        })}
      />,
    );
    await m.flush();
    // [data-session-line] is the <p>; its section is a direct child of the pane.
    const pane = m.query("[data-session-line]")!.parentElement!.parentElement!;
    assert.deepEqual(
      [...pane.children].map((el) => el.getAttribute("aria-label")),
      ["Session", "Team", "Tasks", "Subagents", "Hypotheses"],
    );
    const team = m.query('[aria-label="Team"]')!;
    assert.equal(team.querySelector("[data-section-count]")?.textContent, "1");
    m.unmount();
  });
```

- [ ] **Step 2: Run them to make sure they fail.**
Run: `node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test test/teamView.test.tsx`
Expected: FAIL. `[data-session-line]` is missing, and hypotheses render as a `SECTION`.

- [ ] **Step 3: Implement in `src/components/AgentsPanel.tsx`.**

3a. In the workflow branch of `AgentsContent` (anchor `<section className={styles.workflow}>`), replace:

```tsx
        <section className={styles.workflow}>
          <div className={styles.workflowHead}>
            <div>
              <div className={styles.workflowLabel}>Workflow</div>
              <div className={styles.workflowName}>{workflow.name}</div>
            </div>
            <div className={styles.settled}>
              {workflow.settled}/{workflow.total} settled
            </div>
          </div>

          <div
```
with:
```tsx
        <InspectorSection
          title={`Workflow · ${workflow.name}`}
          action={
            <span className={styles.settled}>
              {workflow.settled}/{workflow.total} settled
            </span>
          }
          data-workflow=""
        >
          <div className={styles.workflow}>
          <div
```

Then replace the pipeline's closing, the anchor:
```tsx
            })}
          </div>
        </section>

        <div className={styles.groups}>
```
with:
```tsx
            })}
          </div>
          </div>
          <div className={styles.groups}>
```

Finally, replace the groups' closing, the anchor:
```tsx
          })}
        </div>
        <CrewTaskList tasks={crewTasks} ownerTitle={crewOwnerTitle} />
        {hypothesisSection}
      </div>
```
with:
```tsx
          })}
          </div>
        </InspectorSection>
        <CrewTaskList tasks={crewTasks} ownerTitle={crewOwnerTitle} />
        {hypothesisSection}
      </div>
```

3b. In the plain-thread `return`, change `<SessionCard thread={thread} usage={usage} providers={providers} />` to `<SessionLine thread={thread} usage={usage} providers={providers} />`.

3c. In the `team?.kind === "worker"` branch, change `<SessionCard` to `<SessionLine`, and replace the Team block:

```tsx
          <section className={styles.teamSection} aria-label="Team">
            <div className={styles.sessionLabel}>Team</div>
            <ul className={styles.teamList}>
              <TeamRow
                summary={team.orchestrator}
                role="Orchestrator"
                providers={providers}
                onSelect={onSelectThread}
              />
            </ul>
          </section>
```
with the Lead line (decided 2026-10-04; `team.kind === "worker"` already means the lead exists in the same project):

```tsx
          <section className={inspector.section} aria-label="Lead">
            <button
              type="button"
              className={inspector.linkBtn}
              data-crew-lead={team.orchestrator.id}
              title={team.orchestrator.title}
              onClick={() => onSelectThread?.(team.orchestrator.id)}
            >
              Lead: {team.orchestrator.title} ›
            </button>
          </section>
```

3d. In the `team?.kind === "orchestrator"` branch:
- Change `<SessionCard` to `<SessionLine`.
- Replace:
  ```tsx
            <section className={styles.teamSection} aria-label="Team">
              <div className={styles.sessionLabel}>Team</div>
  ```
  with:
  ```tsx
            <InspectorSection
              title="Team"
              count={team.workers.length + team.doneWorkers.length}
            >
  ```
- Delete the `          </section>` line that directly follows the "N done" toggle's `)}`, so `CrewIntegration` (Integrate, Verify, Land) sits under the roster inside the Team section.
- Then change:
  ```tsx
            ) : null}
            <CrewTaskList tasks={crewTasks} ownerTitle={crewOwnerTitle} />
  ```
  (the end of the `{crewIntegration ? (<CrewIntegration … />) : null}` expression; this anchor is unique) to:
  ```tsx
            ) : null}
            </InspectorSection>
            <CrewTaskList tasks={crewTasks} ownerTitle={crewOwnerTitle} />
  ```

3e. Replace `const pane = \`${styles.scroll} ${styles.inspector}\`;` with `const pane = inspector.pane;`.

3f. In `subagentSection`, replace:
```tsx
      <section className={styles.teamSection} aria-label="Subagents">
        <div className={styles.sessionLabel}>Subagents</div>
```
with:
```tsx
      <InspectorSection title="Subagents" count={subagents.length}>
```
and change its closing `      </section>` (just before `    ) : null;`) to `      </InspectorSection>`.

3g. In `CrewTaskList`, replace:
```tsx
    <section className={styles.teamSection} aria-label="Tasks" data-crew-tasks="">
      <div className={styles.sessionLabel}>Tasks</div>
```
with:
```tsx
    <InspectorSection title="Tasks" count={tasks.length} data-crew-tasks="">
```
and change its closing `</section>` to `</InspectorSection>`.

3h. In `HypothesisLedgerCard`, replace:
```tsx
    <section className={styles.gitCard} data-hypothesis-ledger="">
      <div className={styles.gitCardLabel}>
        <svg {...LABEL_ICON_PROPS} className={styles.labelIcon}>
          <path d="M3.5 4.5 5 6l3-3.5" />
          <path d="M10 5h3" />
          <path d="M4 11.5h3.5M4 11.5 3 12.5M7.5 11.5 8.5 12.5" />
          <path d="M10 12h3" />
        </svg>
        Hypotheses
      </div>
```
with:
```tsx
    <InspectorSection
      title="Hypotheses"
      count={hypotheses.length}
      collapsible
      defaultOpen={false}
      data-hypothesis-ledger=""
    >
```
and change its closing `</section>` to `</InspectorSection>`.

3i. Replace `function SessionCard(…) { … }` (lines 410-519) with the code below. `data-session-line` sits on the first `<p>`, so its `textContent` is exactly the line. With a role chip, it starts with the chip text ("Orchestrator" or "Worker"), which the role tests match by regex.

```tsx
/**
 * One session line: provider · status · turns · cost, and a muted token
 * line. Model and Permission live in the composer; context in the header ring.
 */
function SessionLine({
  thread,
  usage,
  providers,
  role,
}: {
  thread: ThreadInfo;
  usage: SessionUsage | null;
  providers: ProviderInfo[];
  /** Team role chip ("Orchestrator" / "Worker"); absent renders no chip. */
  role?: string;
}) {
  const usageUnreported =
    usage != null &&
    usage.turns > 0 &&
    usage.inputTokens === 0 &&
    usage.outputTokens === 0 &&
    usage.costUsd === 0 &&
    !(Number(usage.contextTokens) > 0);
  const costUnmetered =
    usage != null &&
    usage.costUsd === 0 &&
    (usage.inputTokens > 0 ||
      usage.outputTokens > 0 ||
      Number(usage.contextTokens) > 0);
  const parts = [providerDisplayName(thread.provider, providers), thread.status];
  if (usageUnreported) parts.push("usage not reported");
  else if (usage) {
    parts.push(
      `${usage.turns} ${usage.turns === 1 ? "turn" : "turns"}`,
      costUnmetered ? "unmetered" : formatCostUsd(usage.costUsd),
    );
  } else parts.push("No usage yet");
  return (
    <section className={inspector.section} aria-label="Session">
      <p className={inspector.line} data-session-line="">
        {role ? <span className={styles.roleChip}>{role}</span> : null}
        {parts.join(" · ")}
      </p>
      {usage && !usageUnreported ? (
        <p
          className={`${inspector.line} ${inspector.muted}`}
          data-session-tokens=""
        >
          {usage.inputTokens.toLocaleString()} in ·{" "}
          {usage.outputTokens.toLocaleString()} out tokens
        </p>
      ) : null}
    </section>
  );
}
```

3j. Imports:
- Delete `import { contextRing, threadContextWindow } from "../contextRing";`.
- Delete `permissionModeLabel,` and `shortSessionId,` from the `../format` import.

Run `npx tsc --noEmit` and delete exactly what it reports as unused. `styles.sessionCard`, `teamSection` and the related classes become dead CSS and go in Task 8.

- [ ] **Step 4: Run the tests and typecheck.**
Run: `npx tsc --noEmit && node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test test/teamView.test.tsx test/crewTasks.test.tsx test/crewIntegration.test.tsx test/workflowRetryAgent.test.tsx test/agentsCollapse.test.tsx test/deCardUi.test.ts`
Expected: tsc clean, 0 fail. `deCardUi` still finds `.sessionCard`, `.gitCard` and `.teamSection` in the CSS until Task 8.

- [ ] **Step 5: Commit.**
```bash
git add src/components/AgentsPanel.tsx test/teamView.test.tsx
git commit -m "Agents tab: one session line, Team for crew leads, Lead line for workers, collapsed hypotheses"
```

---
### Task 7: Memory tab

**Job:** this project's memories. The tab is:
- one toolbar row: search, type, `+`
- the review banner, when the queue is non-empty
- the memory list
- a footer line: scope, consolidation status, and a "Code map & config doctor ›" link to Settings

Code map and Config doctor now live only in Settings → Memory (added in Task 2).

**Files:**
- Modify: `src/components/MemoryTab.tsx`. Task 2 shifted lines after 630 by about 50, so locate each edit by its quoted anchor:
  - `MemoryTabProps` (lines 127-128 and 155-166)
  - `ReviewQueueCard` render (`const items: MemoryReviewItem[]` through its closing `}`)
  - `MemoryTab` destructuring, `secondary`, toolbar and both returns
  - imports
- Modify: `src/components/AgentsPanel.tsx`, the `tab === "memory"` branch and the destructuring
- Create: `test/memoryProjectTools.test.tsx`, moved from `test/memoryTab.test.tsx`
- Test: `test/memoryTab.test.tsx`, `test/appWiring.test.tsx`

**Interfaces:**
- Consumes:
  - `InspectorSection`, `InspectorBanner` and `inspector` classes (Task 1)
  - `MemoryProjectTools` (Task 2)
  - `onOpenSettings` (Task 3)
- Produces:
  - `MemoryTabProps` drops `projectId`, `loadCodeMap`, `lintAgentConfig`, `previewAgentConfig` and `writeAgentConfig`, and adds `onOpenProjectTools?: () => void`
  - DOM hooks:
    - `[data-memory-add]` (the `+`, `aria-label="Add memory"`)
    - `[data-review-banner]`, `[data-review-open]` (the banner action)
    - `[data-review-queue]` (the opened queue), `[data-review-close]`
    - `[data-memory-footer]`, `[data-memory-project-tools-link]`
  - Kept: `data-memory-list`, `data-memory-scroll`, `data-memory-consolidation`, `data-review-activity`, `data-needs-your-call`

**Existing tests that assert removed or moved UI:**
- **Moved verbatim to `test/memoryProjectTools.test.tsx`** (Step 1), with every assertion kept. Only the mount changes, and the memory-list props it no longer takes are dropped. The moved blocks:
  - `SAMPLE_REPORT` through the end of "MemoryTab config doctor project switch #1136" (`memoryTab.test.tsx:563-898`)
  - "MemoryTab code map" (`:1117-1405`)
  - "MemoryTab browsing #1123 / does not fetch map or doctor detail until those disclosures open" (`:1490-1525`). Its last line, `assert.ok(m.query("[data-memory-list]"))`, cannot hold on a component without a list, so it is dropped. The new layout test asserts the list renders.
  - In "still shows the map when the memory server is down" (renamed "renders the map with no memory server involved"), `assert.match(m.text(), /Memory server is not running/)` is dropped. The map and the memory list no longer share a component. The down state stays covered by `memoryTab.test.tsx` "says the server is down and offers a retry".
- `"Add memory"` is now the `+` button (four `m.byText("Add memory")` calls). These selectors switch to `[data-memory-add]`.
- "MemoryTab review queue": three tests change:
  - "lists an open pair as needing a call…": the chip text becomes the banner text plus the section count.
  - "renders the auto-resolution activity line…": the chip text becomes the section count.
  - "shows the activity line when the queue is empty" is inverted. There is no banner for an empty queue (discrepancy 10).
- "MemoryTab inspector layout" (`:1407-1488`) is rewritten for the new layout.
- The scope-label tests (193-235) are unchanged. They query `[class*="filterLabel"]`, which moves from the toolbar to the footer.

- [ ] **Step 1: Move the code map and doctor tests.** Run this before any other edit to `test/memoryTab.test.tsx`:

```bash
{
cat <<'HDR'
/**
 * Code map + config doctor, now in Settings → Memory → Project tools
 * (inspector tabs redesign). Moved verbatim from test/memoryTab.test.tsx;
 * only the mount changed from <MemoryTab …> to <MemoryProjectTools …>,
 * dropping the memory-list props it no longer takes.
 *
 * Run: node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test test/memoryProjectTools.test.tsx
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { inAct, mount, unmountAll } from "./support/dom.ts";
import { MemoryProjectTools } from "../src/components/MemoryTab";
import type {
  AgentConfigDoctorReport,
  AgentConfigPreview,
  AgentConfigWriteResult,
  ProjectCodeMap,
} from "../src/shared/ipc";

afterEach(unmountAll);

async function openDoctor(m: Awaited<ReturnType<typeof mount>>) {
  const summary = m.query("[data-config-doctor] summary");
  assert.ok(summary, "config doctor disclosure must exist");
  await m.click(summary);
}

async function openMap(m: Awaited<ReturnType<typeof mount>>) {
  const summary = m.query("[data-code-map] summary");
  assert.ok(summary, "code map disclosure must exist");
  await m.click(summary);
}

HDR
sed -n '563,898p' test/memoryTab.test.tsx
echo
sed -n '1117,1405p' test/memoryTab.test.tsx
echo
echo 'describe("MemoryProjectTools browsing #1123", () => {'
sed -n '1490,1522p' test/memoryTab.test.tsx
sed -n '1524,1525p' test/memoryTab.test.tsx
echo '});'
} > test/memoryProjectTools.test.tsx
sed -i '' -e '1490,1526d' -e '1117,1406d' -e '563,899d' test/memoryTab.test.tsx
perl -0pi -e '
  s/\n[ \t]*recentMemory=\{async \(\) => \{\n[ \t]*throw new Error\("Memory server is not running\."\);\n[ \t]*\}\}//g;
  s/\n[ \t]*(?:searchMemory|recentMemory|getMemory|updateMemory|removeMemory|storeMemory)=\{[^\n]*\}(?=\n)//g;
  s/<MemoryTab\b/<MemoryProjectTools/g;
  s/mount\(tab\(\)\)/mount(<MemoryProjectTools projectId="p1" projectSlug="coder" \/>)/g;
  s/describe\("MemoryTab /describe("MemoryProjectTools /g;
  s/still shows the map when the memory server is down/renders the map with no memory server involved/g;
  s/\n[ \t]*assert\.match\(m\.text\(\), \/Memory server is not running\/\);//g;
' test/memoryProjectTools.test.tsx
grep -c "<MemoryProjectTools" test/memoryProjectTools.test.tsx
grep -nE "searchMemory|recentMemory|getMemory|updateMemory|removeMemory|storeMemory|entry\(|Memory server is not running" test/memoryProjectTools.test.tsx
```

Expected output:
- `8` from the first grep (7 former `<MemoryTab` mounts plus the former `tab()`)
- nothing from the second grep

Line 1523 (`assert.ok(m.query("[data-memory-list]"));`) is the one assertion intentionally left behind (see above).

Then, in `test/memoryTab.test.tsx`:
- delete the now-unused `openDoctor` and `openMap` helpers (lines 121-131)
- remove `AgentConfigDoctorReport`, `AgentConfigPreview`, `AgentConfigWriteResult` and `ProjectCodeMap` from its type import

- [ ] **Step 2: Write the failing Memory tests.**

2a. `sed -i '' 's/m\.byText("Add memory")/m.query("[data-memory-add]")/g' test/memoryTab.test.tsx`

2b. In "lists an open pair as needing a call and resolves keep-both", replace:

```tsx
    await openReview(m);
    const card = m.query("[data-review-queue]");
    assert.ok(card, "queue card must render");
    assert.ok(
      card.textContent?.includes("1 needs your call"),
      `expected needs-your-call badge, got: ${card.textContent}`,
    );
```
with:
```tsx
    assert.equal(
      m.query("[data-review-open]")?.textContent,
      "1 memory needs review ›",
      "one-line banner before opening",
    );
    await openReview(m);
    const card = m.query("[data-review-queue]");
    assert.ok(card, "queue card must render");
    assert.ok(card.textContent?.includes("Needs your call"), `got: ${card.textContent}`);
    assert.equal(card.querySelector("[data-section-count]")?.textContent, "1");
```

2c. In "renders the auto-resolution activity line and keeps the queue buttons", replace `assert.ok(card?.textContent?.includes("1 needs your call"));` with:

```tsx
    assert.equal(card?.querySelector("[data-section-count]")?.textContent, "1");
```

2d. Replace the whole test "shows the activity line when the queue is empty" with the three tests below:

```tsx
  it("shows no banner for an empty queue, even with auto-resolved activity", async () => {
    const m = await mount(
      <MemoryTab
        projectSlug="coder"
        searchMemory={async () => []}
        recentMemory={async () => []}
        getMemory={async (input) => entry({ id: input.id })}
        updateMemory={async () => ({ id: "x" })}
        removeMemory={async () => {}}
        storeMemory={async () => ({ id: "x" })}
        maintenanceMemory={async () =>
          maintenanceReport({
            autoResolved: {
              last7Days: 1,
              invalidated: 1,
              kept: 0,
              byRule: { semantic_dup: 1 },
            },
          })
        }
      />,
    );
    assert.equal(m.query("[data-review-open]"), null, "banner only for a non-empty queue");
    assert.equal(m.query("[data-review-queue]"), null);
    assert.equal(m.query("[data-review-activity]"), null);
    m.unmount();
  });

  it("hides the banner when the report fails to load (no stale count)", async () => {
    const m = await mount(
      <MemoryTab
        projectSlug="coder"
        searchMemory={async () => []}
        recentMemory={async () => []}
        getMemory={async (input) => entry({ id: input.id })}
        updateMemory={async () => ({ id: "x" })}
        removeMemory={async () => {}}
        storeMemory={async () => ({ id: "x" })}
        maintenanceMemory={async () => {
          throw new Error("maintenance down");
        }}
      />,
    );
    assert.equal(m.query("[data-review-open]"), null);
    assert.equal(m.query("[data-review-queue]"), null);
    m.unmount();
  });

  it("Close folds the opened queue back into the banner", async () => {
    const m = await mount(
      <MemoryTab
        projectSlug="coder"
        searchMemory={async () => []}
        recentMemory={async () => []}
        getMemory={async (input) => entry({ id: input.id })}
        updateMemory={async () => ({ id: "x" })}
        removeMemory={async () => {}}
        storeMemory={async () => ({ id: "x" })}
        maintenanceMemory={async () =>
          maintenanceReport({
            queue: { open: 2, oldestAgeDays: 1, items: [QUEUE_ITEM] },
          })
        }
      />,
    );
    assert.equal(m.query("[data-review-open]")?.textContent, "2 memories need review ›");
    await openReview(m);
    assert.ok(m.query("[data-review-queue]"));
    await m.click(m.query("[data-review-close]"));
    assert.equal(m.query("[data-review-queue]"), null);
    assert.ok(m.query("[data-review-open]"));
    m.unmount();
  });
```

2e. Replace `describe("MemoryTab inspector layout", …)` with:

```tsx
describe("MemoryTab inspector layout", () => {
  it("toolbar row, review banner, list, footer; no map or doctor in the tab", async () => {
    let toolsOpened = 0;
    const m = await mount(
      <MemoryTab
        projectSlug="coder"
        consolidation={{ memoryConsolidateDoneAt: Date.now() - 2 * 3_600_000 }}
        searchMemory={async () => []}
        recentMemory={async () => [entry()]}
        getMemory={async (input) => entry({ id: input.id })}
        updateMemory={async () => ({ id: "x" })}
        removeMemory={async () => {}}
        storeMemory={async () => ({ id: "x" })}
        maintenanceMemory={async () =>
          maintenanceReport({
            queue: { open: 1, oldestAgeDays: 1, items: [QUEUE_ITEM] },
          })
        }
        onOpenProjectTools={() => {
          toolsOpened += 1;
        }}
      />,
    );
    await m.flush();
    const toolbar = m.query('[class*="searchRow"]');
    assert.ok(toolbar, "search toolbar must render");
    assert.ok(toolbar.querySelector('input[type="search"]'));
    assert.ok(toolbar.querySelector('select[aria-label="Filter memory type"]'));
    assert.equal(toolbar.querySelector("[data-memory-add]")?.textContent, "+");
    assert.equal(toolbar.querySelector("[data-review-open]"), null);
    const scroll = m.query("[data-memory-scroll]");
    assert.ok(scroll, "one scrolling pane must exist");
    const banner = scroll.querySelector("[data-review-banner]");
    const list = scroll.querySelector("[data-memory-list]");
    assert.ok(banner, "review banner scrolls with the list");
    assert.ok(list, "memories must be in the scroll pane");
    assert.ok(
      Boolean(banner.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING),
      "banner sits above the list",
    );
    assert.equal(m.query("[data-code-map]"), null, "code map moved to Settings → Memory");
    assert.equal(m.query("[data-config-doctor]"), null, "doctor moved to Settings → Memory");
    const footer = m.query("[data-memory-footer]");
    assert.ok(footer, "footer line");
    assert.ok(
      Boolean(scroll.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING),
      "footer below the scroll",
    );
    assert.match(footer.textContent ?? "", /Last consolidation 2h ago/);
    await m.click(footer.querySelector("[data-memory-project-tools-link]"));
    assert.equal(toolsOpened, 1);
    await m.click(m.query("[data-memory-add]"));
    assert.ok(
      scroll.querySelector('input[placeholder="Title"]'),
      "the remember form opens in place inside the scroll",
    );
    m.unmount();
  });
});
```

2f. In `test/appWiring.test.tsx`, append inside `describe("App memory wiring", …)`:

```tsx
  it("Memory footer opens Settings → Memory → Project tools on this project", async () => {
    const fake = createFakeCoder({
      projects: [project({ id: "p1", slug: "owner/repo" })],
      threads: [thread({ id: "t1", projectId: "p1" })],
    });
    const m = await boot(fake);
    await expandAgents(m);
    const target = m.query('button[aria-label="Select thread: first thread"]');
    assert.ok(target, "the thread card must be present");
    await m.click(target);
    await m.click(m.query('[data-panel-tab="memory"]'));
    const link = m.query("[data-memory-project-tools-link]");
    assert.ok(link, "the Memory footer links to Project tools");
    await m.click(link);
    assert.equal(
      m.query("[data-settings-pane]")?.getAttribute("data-settings-pane"),
      "memory",
    );
    assert.equal(
      (
        m.query(
          '[data-project-picker="project-tools-project"]',
        ) as HTMLSelectElement | null
      )?.value,
      "p1",
      "the picker defaults to the selected thread's project",
    );
    m.unmount();
  });
```

- [ ] **Step 3: Run them to make sure they fail.**
Run: `node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test test/memoryTab.test.tsx test/memoryProjectTools.test.tsx test/appWiring.test.tsx`
Expected:
- `memoryProjectTools.test.tsx` PASSES (it is a move)
- `memoryTab.test.tsx` FAILS (`[data-memory-add]` missing, the banner missing)
- the new appWiring test FAILS (no footer link)

- [ ] **Step 4: Implement in `src/components/MemoryTab.tsx`.**

4a. Imports. After `import styles from "./MemoryTab.module.css";`, add:

```tsx
import inspector from "./Inspector.module.css";
import { InspectorBanner, InspectorSection } from "./InspectorSection";
```

4b. In `MemoryTabProps`:
- delete the `projectId` member and its doc comment (`/** Project id for the config doctor. Absent = no doctor card. */ projectId?: string | null;`)
- delete the four members `loadCodeMap?` through `writeAgentConfig?`
- add:

```tsx
  /** Opens Settings → Memory → Project tools (code map + config doctor). */
  onOpenProjectTools?: () => void;
```

4c. In `ReviewQueueCard`, replace everything from `  const items: MemoryReviewItem[] = report?.queue.items ?? [];` to the function's closing `}` with:

```tsx
  const items: MemoryReviewItem[] = report?.queue.items ?? [];
  const open = report?.queue.open ?? 0;
  const activity = report?.autoResolved
    ? autoResolvedActivity(report.autoResolved)
    : null;

  if (!opened) {
    // One line, only for a queue that loaded non-empty: a failed load never
    // shows a stale count.
    if (error || !report || open === 0) return null;
    return (
      <InspectorBanner
        data-review-banner=""
        actionLabel={`${open} ${open === 1 ? "memory needs" : "memories need"} review`}
        onAction={() => {
          setOpened(true);
          if (!detailLoaded) void load(true);
        }}
        actionProps={{ "data-review-open": "" }}
      />
    );
  }

  return (
    <InspectorSection
      title="Needs your call"
      count={open}
      data-review-queue=""
      action={
        <>
          <button
            type="button"
            className={styles.retryBtn}
            onClick={() => void load(true)}
          >
            Refresh
          </button>
          <button
            type="button"
            className={styles.retryBtn}
            data-review-close=""
            onClick={() => setOpened(false)}
          >
            Close
          </button>
        </>
      }
    >
      {error ? (
        <p className={styles.formError} role="alert">
          {error}
        </p>
      ) : null}
      {activity ? (
        <p className={styles.doctorMeta} data-review-activity="">
          {activity}
        </p>
      ) : null}
      {items.length > 0 ? (
        <ul className={styles.queueList} data-needs-your-call="">
          {items.map((item) => (
            <li key={item.id} className={styles.queueItem}>
              <p className={styles.queuePair}>
                <span className={styles.queueKind}>{item.kind.replace(/_/g, " ")}</span>
                {" · "}
                {item.a.title || item.a.id}
                {" ↔ "}
                {item.b.title || item.b.id}
              </p>
              {resolveMemory ? (
                <div className={styles.doctorActions}>
                  <button
                    type="button"
                    className={styles.retryBtn}
                    disabled={busyId === item.id}
                    onClick={() => void onResolve(item.id, "noop")}
                  >
                    Keep both
                  </button>
                  <button
                    type="button"
                    className={styles.retryBtn}
                    disabled={busyId === item.id}
                    onClick={() => void onResolve(item.id, "update")}
                  >
                    Mark reviewed
                  </button>
                  <button
                    type="button"
                    className={styles.dangerBtn}
                    disabled={busyId === item.id}
                    onClick={() => void onResolve(item.id, "invalidate")}
                  >
                    Invalidate older
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.mapEmpty}>Nothing left to review.</p>
      )}
    </InspectorSection>
  );
}
```

4d. In the `MemoryTab({ … }: MemoryTabProps)` destructuring:
- delete `projectId,`, `loadCodeMap,`, `lintAgentConfig,`, `previewAgentConfig,` and `writeAgentConfig,`
- add `onOpenProjectTools,`

4e. Replace the whole `const secondary = ( … );` (the Task 2 version that holds `MemoryProjectTools` and `ReviewQueueCard`) with:

```tsx
  const review = maintenanceMemory ? (
    <ReviewQueueCard
      projectSlug={projectSlug}
      maintenanceMemory={maintenanceMemory}
      resolveMemory={resolveMemory}
    />
  ) : null;

  const consolidationLine =
    consolidation !== undefined ? consolidationStatus(consolidation) : null;
  const footer = (
    <footer className={inspector.footer} data-memory-footer="">
      <span className={styles.filterLabel} title="Memory is scoped to this project">
        {scopeLabel(projectSlug)}
      </span>
      {consolidationLine ? (
        <span
          data-memory-consolidation={consolidationLine.failed ? "failed" : "ok"}
          role={consolidationLine.failed ? "alert" : "status"}
        >
          {consolidationLine.text}
        </span>
      ) : null}
      {onOpenProjectTools ? (
        <button
          type="button"
          className={inspector.linkBtn}
          data-memory-project-tools-link=""
          onClick={onOpenProjectTools}
        >
          {"Code map & config doctor ›"}
        </button>
      ) : null}
    </footer>
  );
```

4f. In `toolbar`, replace:

```tsx
      <span className={styles.filterLabel} title="Memory is scoped to this project">
        {scopeLabel(projectSlug)}
      </span>
      <button
        type="button"
        className={styles.addBtn}
        aria-expanded={adding}
        onClick={() => setAdding((on) => !on)}
      >
        {adding ? "Close" : "Add memory"}
      </button>
```
with:
```tsx
      <button
        type="button"
        className={styles.addBtn}
        data-memory-add=""
        aria-label="Add memory"
        title={adding ? "Close the form" : "Remember something"}
        aria-expanded={adding}
        onClick={() => setAdding((on) => !on)}
      >
        {adding ? "×" : "+"}
      </button>
```

4g. In the `if (serverDown) { return ( … ) }` branch, replace:

```tsx
          {secondary}
        </div>
      </div>
    );
  }
```
with:
```tsx
        </div>
        {footer}
      </div>
    );
  }
```

4h. In the main return, replace:

```tsx
        {rememberForm}

      <section className={styles.section} data-memory-list="">
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>Memories</h2>
          <span className={styles.sectionMeta}>{entryCountLabel}</span>
        </div>
      {consolidation !== undefined ? (() => {
        const c = consolidationStatus(consolidation);
        return (
          <p
            className={styles.searchHint}
            data-memory-consolidation={c.failed ? "failed" : "ok"}
            role={c.failed ? "alert" : "status"}
          >
            {c.text}
          </p>
        );
      })() : null}
```
with:
```tsx
        {review}
        {rememberForm}

      <InspectorSection
        title="Memories"
        action={<span className={styles.sectionMeta}>{entryCountLabel}</span>}
        data-memory-list=""
      >
```

and replace the end of the component:

```tsx
      </div>
      </section>
      {secondary}
      </div>
    </div>
  );
}
```
with:
```tsx
      </div>
      </InspectorSection>
      </div>
      {footer}
    </div>
  );
}
```

`MemoryProjectTools`, `CodeMapCard` and `ConfigDoctorCard` stay in this file; Settings imports `MemoryProjectTools`. Run `npx tsc --noEmit` and delete exactly what it reports unused.

- [ ] **Step 5: Rewire `src/components/AgentsPanel.tsx`.**
- In the `AgentsPanel` destructuring, delete `loadCodeMap,`, `lintAgentConfig,`, `previewAgentConfig,` and `writeAgentConfig,`. The interface entries go in Task 8.
- In the `tab === "memory"` branch:
  - delete the `projectId={project?.id ?? null}` prop and the four `loadCodeMap` / `lintAgentConfig` / `previewAgentConfig` / `writeAgentConfig` props
  - add after `resolveMemory={resolveMemory}`:

```tsx
          onOpenProjectTools={
            onOpenSettings ? () => onOpenSettings("memory") : undefined
          }
```

- [ ] **Step 6: Run the tests, typecheck and build.**
Run: `npx tsc --noEmit && node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test test/memoryTab.test.tsx test/memoryProjectTools.test.tsx test/memoryCard.test.ts test/settingsModal.test.tsx test/appWiring.test.tsx test/agentsCollapse.test.tsx test/deCardUi.test.ts && npx vite build`
Expected: tsc clean, 0 fail, `✓ built`. In `agentsCollapse.test.tsx:891-895`, the scope label "one" is still inside the Memory root: it moved to the footer, which is the scroll's sibling.

- [ ] **Step 7: Commit.**
```bash
git add src/components/MemoryTab.tsx src/components/AgentsPanel.tsx test/memoryTab.test.tsx test/memoryProjectTools.test.tsx test/appWiring.test.tsx
git commit -m "Memory tab: toolbar +, review banner, footer; project tools live in Settings"
```

---
### Task 8: Delete the now-unused code

By now `tsc` has already forced out the non-exported dead code: drag handles, cards and the `EnvSection` wrapper (Task 5); `SessionCard` (Task 6). This task removes what the compiler cannot see:
- exported leftovers
- interface-only props and the App props that feed them
- the `envSectionOrder` module
- dead CSS

**Files:**
- Delete: `src/envSectionOrder.ts`, `test/envSectionOrder.test.ts`
- Modify: `src/components/AgentsPanel.tsx`:
  - `ForkCard` (exported, unused since Task 5)
  - `LABEL_ICON_PROPS`
  - `AgentsPanelProps` members
  - type imports
- Modify: `src/App.tsx` (`<AgentsPanel` props)
- Modify: `src/components/skillsLibrary.ts:3` (`SkillsView`)
- Modify: `src/components/AgentsPanel.module.css`, `src/components/MemoryTab.module.css`, `src/components/SkillsTab.module.css` (dead classes)
- Test: `test/inspectorSection.test.tsx` (guard), `test/deCardUi.test.ts` (updated class list)

**Interfaces:**
- `AgentsPanelProps` loses these props:
  - `settings`, `saveSettings`
  - `listMcpServers`, `saveMcpServer`, `removeMcpServer`, `setMcpEnabled`, `listMcpCatalog`, `pickMcpImport`, `previewMcpImport`, `installMcpImport`, `discardMcpImport`
  - `addSkill`, `listSkillCatalog`, `pickSkillImport`, `previewSkillImport`, `installSkillImport`, `discardSkillImport`
  - `detectHarnessSources`, `previewHarnessImport`, `installHarnessImport`, `discardHarnessImport`
  - `loadCodeMap`, `lintAgentConfig`, `previewAgentConfig`, `writeAgentConfig`
  - `activeView`, `onOpenPrs`, `onFork`, `spotlight`, `setSpotlight`
- It keeps `listSkills`, `removeSkill`, `syncSkills`, the lane callbacks, `spotlightLane`, `revealInFinder`, `openInEditor`, `fetchDiff` and `onOpenSettings`.

**Existing tests that assert removed code:**
- `test/envSectionOrder.test.ts` (whole file): the module is deleted, and the order is fixed by spec.
- `test/deCardUi.test.ts:139-142`:
  - The `sessionCard`, `gitCard` and `teamSection` tuples point at deleted classes. They are replaced by `Inspector.module.css` `section` and `banner`, with the same "no 1px --border tile" assertion.
  - `workflow` stays, because it is still used inside the Workflow section.

- [ ] **Step 1: Write the failing guard.** Append to `test/inspectorSection.test.tsx`:

```tsx
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("inspector cleanup", () => {
  it("has no reorder module, drag MIME, Fork card or settings plumbing left", () => {
    assert.equal(fs.existsSync(path.join(ROOT, "src/envSectionOrder.ts")), false);
    const panel = fs.readFileSync(
      path.join(ROOT, "src/components/AgentsPanel.tsx"),
      "utf8",
    );
    for (const gone of [
      "envSectionOrder",
      "ENV_DRAG_MIME",
      "data-env-grip",
      "function ForkCard",
      "saveSettings",
      "listMcpServers",
      "lintAgentConfig",
      "onOpenPrs",
      "setSpotlight",
    ]) {
      assert.equal(panel.includes(gone), false, `${gone} must be gone from AgentsPanel.tsx`);
    }
    const lib = fs.readFileSync(
      path.join(ROOT, "src/components/skillsLibrary.ts"),
      "utf8",
    );
    assert.equal(lib.includes("SkillsView"), false);
  });

  it("nothing reads the old coder.envSectionOrder key", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name) && fs.readFileSync(full, "utf8").includes("coder.envSectionOrder")) {
          hits.push(full);
        }
      }
    };
    walk(path.join(ROOT, "src"));
    assert.deepEqual(hits, [], "a stale key is ignored: no code may read it");
  });
});
```

Move the three new `import` lines to the top of the file with the other imports.

- [ ] **Step 2: Run it to make sure it fails.**
Run: `node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test test/inspectorSection.test.tsx`
Expected: FAIL on `src/envSectionOrder.ts` existing (and, after that, `saveSettings must be gone`).

- [ ] **Step 3: Delete the module and its unit test.**

```bash
git rm src/envSectionOrder.ts test/envSectionOrder.test.ts
```

- [ ] **Step 4: Trim `src/components/AgentsPanel.tsx`.**
- Delete `export function ForkCard({ … })` entirely (anchor `export function ForkCard({`, through the `}` before `export function EditorCard({`).
- Delete `const LABEL_ICON_PROPS = { … } as const;` and its doc comment `/** Shared props for the 14px line icons in Environment card labels. */`.
- In `interface AgentsPanelProps`, delete these members and their doc comments:
  - `settings`, `saveSettings`
  - `listMcpServers`, `saveMcpServer`, `removeMcpServer`, `setMcpEnabled`, `listMcpCatalog`, `pickMcpImport`, `previewMcpImport`, `installMcpImport`, `discardMcpImport`
  - `addSkill`, `listSkillCatalog`, `pickSkillImport`, `previewSkillImport`, `installSkillImport`, `discardSkillImport`
  - `detectHarnessSources`, `previewHarnessImport`, `installHarnessImport`, `discardHarnessImport`
  - `loadCodeMap`, `lintAgentConfig`, `previewAgentConfig`, `writeAgentConfig`
  - `activeView`, `onOpenPrs`, `onFork`, `spotlight`, `setSpotlight`
- Delete the `/** Skills tab: settings surface for MCP servers + skills CRUD. */` comment that headed them.
- From the `../shared/ipc` type import, delete these now-unused names:
  - `AppSettings`
  - `McpCatalogEntry`, `McpImportPreview`, `McpInstallRequest`, `McpInstallResult`, `McpPreviewImportInput`, `McpServerDefinition`, `McpServerSaveInput`
  - `MergeSpotlight`
  - `AgentConfigDoctorReport`, `AgentConfigPreview`, `AgentConfigWriteResult`, `ProjectCodeMap`
  - `SkillCatalogEntry`, `SkillImportPreview`, `SkillInstallRequest`, `SkillInstallResult`, `SkillPreviewImportInput`, `SkillTarget`, `SkillWrite`
  - `HarnessSourceId`, `HarnessSourceInfo`, `HarnessImportPreview`, `HarnessInstallRequest`, `HarnessInstallResult`
- Then run `npx tsc --noEmit` and delete exactly what it still reports.

- [ ] **Step 5: Trim App's `<AgentsPanel` element.** In `src/App.tsx`, inside `<AgentsPanel … />` only, delete these props:

```
loadCodeMap={loadCodeMap}
lintAgentConfig={lintAgentConfig}
previewAgentConfig={previewAgentConfig}
writeAgentConfig={writeAgentConfig}
settings={settings}
saveSettings={saveSettings}
listMcpServers={listMcpServers}
saveMcpServer={saveMcpServer}
removeMcpServer={removeMcpServer}
setMcpEnabled={setMcpEnabled}
listMcpCatalog={listMcpCatalog}
pickMcpImport={pickMcpImport}
previewMcpImport={previewMcpImport}
installMcpImport={installMcpImport}
discardMcpImport={discardMcpImport}
addSkill={addSkill}
listSkillCatalog={listSkillCatalog}
pickSkillImport={pickSkillImport}
previewSkillImport={previewSkillImport}
installSkillImport={installSkillImport}
discardSkillImport={discardSkillImport}
detectHarnessSources={detectHarnessSources}
previewHarnessImport={previewHarnessImport}
installHarnessImport={installHarnessImport}
discardHarnessImport={discardHarnessImport}
setSpotlight={setSpotlight}
activeView={view}
onOpenPrs={openPrs}
onFork={handleForkOpen}
```

Do not touch the Sidebar's `activeView={view}` or the ThreadView's `onFork={handleForkOpen}`. Each variable stays in use elsewhere: the `SettingsModal` `skills` / `projectTools` / `onSetSpotlight` props, the Sidebar `onOpenReview={openPrs}` and the ThreadView `onFork`. Confirm with `npx tsc --noEmit`.

- [ ] **Step 6: Drop `SkillsView`.** Delete line 3 of `src/components/skillsLibrary.ts`: `export type SkillsView = "library" | "catalog" | "mcp" | "add";`.

- [ ] **Step 7: Find and delete dead CSS.** List the classes defined in each module that its components no longer reference:

```bash
node -e '
const fs = require("fs");
const pairs = {
  "src/components/AgentsPanel.module.css": ["src/components/AgentsPanel.tsx"],
  "src/components/MemoryTab.module.css": ["src/components/MemoryTab.tsx"],
  "src/components/SkillsTab.module.css": ["src/components/SkillsTab.tsx", "src/components/SkillsSections.tsx"],
  "src/components/Inspector.module.css": ["src/components/InspectorSection.tsx", "src/components/AgentsPanel.tsx", "src/components/MemoryTab.tsx", "src/components/SkillsTab.tsx"],
};
for (const [css, users] of Object.entries(pairs)) {
  const defs = new Set([...fs.readFileSync(css, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]));
  const src = users.map((f) => fs.readFileSync(f, "utf8")).join("\n");
  const dead = [...defs].filter((c) => !new RegExp("\\." + c + "\\b").test(src));
  console.log(css + ": " + (dead.join(" ") || "(none)"));
}'
```

For every class it prints, delete each CSS rule whose selector list only mentions dead classes. For a selector list that mixes dead and live classes, delete only the dead selectors from the list. Expected candidates:
- AgentsPanel:
  - `envScroll`, `envToolbar`, `envHint`, `envReset`, `envSrOnly`, `envList`, `envSection`, `envGrip`, `envBody`
  - `gitCard`, `gitCardLabel`, `labelIcon`
  - `gitStatus`
  - `sessionCard`, `sessionHead`, `sessionLabel`, `sessionId`, `sessionTitle`, `sessionMeta`, `sessionRow`, `sessionProvider`, `usageBlock`, `usageList`, `usageEmpty`, `cost`
  - `teamSection`, `inspector`
  - `workflowHead`, `workflowLabel`, `workflowName`
  - `serverLabel`, `recapActivity`, `recapFacts`, `scmCard`, `menu`, `menuItem`, `menuWrap`, `checkboxLabel`
- MemoryTab: `reviewChip`, `disclosureSummary` (only if CodeMapCard/ConfigDoctorCard no longer use it; the script decides), `searchHint` (kept if still used by the short-query hint)
- SkillsTab: `viewBtn`, `filterRow`, `filterChip`
- Inspector: `(none)`

Re-run the script until it prints `(none)` for all four modules.

- [ ] **Step 8: Update `test/deCardUi.test.ts`.** In "transcript, composer, kanban, memory, skills cards drop --border tiles":
- after `const agents = loadCss("src/components/AgentsPanel.module.css");`, add `const inspector = loadCss("src/components/Inspector.module.css");`
- replace the three tuples
  ```ts
        ["AgentsPanel", agents, "sessionCard"],
        ["AgentsPanel", agents, "gitCard"],
  ```
  and
  ```ts
        ["AgentsPanel", agents, "teamSection"],
  ```
  with:
  ```ts
        ["Inspector", inspector, "section"],
        ["Inspector", inspector, "banner"],
  ```
- keep `["AgentsPanel", agents, "workflow"]`

If Step 7 kept any of `sessionCard`, `gitCard` or `teamSection` alive, leave that tuple in place instead.

- [ ] **Step 9: Run everything touched, typecheck and build.**
Run: `npx tsc --noEmit && node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test test/inspectorSection.test.tsx test/deCardUi.test.ts test/environmentCards.test.tsx test/teamView.test.tsx test/memoryTab.test.tsx test/skillsTab.test.tsx test/settingsModal.test.tsx test/appWiring.test.tsx test/agentsCollapse.test.tsx test/mergeQueueChips.test.tsx test/checkpoints.test.tsx && npx vite build`
Expected: tsc clean, 0 fail, `✓ built`.

- [ ] **Step 10: Commit.**
```bash
git add -A src test
git commit -m "Remove envSectionOrder, the Fork card, dead inspector props and CSS"
```

---

### Task 9: Full verification and screenshot pass

**Files:** none changed. If a screenshot shows a defect, fix it in the file named by the checklist item, add a test, and commit separately.

- [ ] **Step 1: Run every suite that covers the renderer.**
Run: `npm run typecheck && npm run test:renderer && npx vite build`
Expected:
- typecheck clean, including the `sync-ipc-preload --check`, because no IPC changed
- renderer `fail 0`
- vite `✓ built`

`npm run test:electron` is not needed: no `electron/` file changed. Run it anyway if `git diff --stat main...HEAD -- electron` is non-empty.

- [ ] **Step 2: Start the dev renderer.**
Run (background): `npx vite --port 5391 --strictPort`
Wait until `curl -s -o /dev/null -w '%{http_code}' http://localhost:5391/` prints `200`.

- [ ] **Step 3: Write the screenshot script.** Create `/tmp/inspector-shots.cjs`. It lives outside the repo, so it is not committed.

```js
const { chromium } = require("playwright"); // resolve from the npx-cached playwright package
const fs = require("fs");

(async () => {
  const out = process.argv[2] || "/tmp/inspector-shots";
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto("http://localhost:5391/");
  const skip = page.getByRole("button", { name: "Skip" });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.locator("[data-thread-card]").first().click();
  await page.waitForTimeout(600);
  await page.locator("[data-thread-header]").first().screenshot({ path: `${out}/header.png` });
  const expand = page.locator("[data-agents-expand]");
  if (await expand.isVisible().catch(() => false)) await expand.click();

  for (const tab of ["git", "agents", "memory", "skills"]) {
    await page.click(`[data-panel-tab="${tab}"]`);
    await page.waitForTimeout(800);
    await page.locator("#inspector-tabpanel").screenshot({ path: `${out}/tab-${tab}.png` });
  }

  // Manage › must land on Skills & MCP.
  await page.click("[data-skills-manage]");
  await page.waitForTimeout(600);
  console.log("manage pane:", await page.getAttribute("[data-settings-pane]", "data-settings-pane"));
  await page.keyboard.press("Escape");

  // Memory footer link must land on Memory with the project picker.
  await page.click('[data-panel-tab="memory"]');
  await page.click("[data-memory-project-tools-link]");
  await page.waitForTimeout(600);
  console.log("tools pane:", await page.getAttribute("[data-settings-pane]", "data-settings-pane"));
  await page.keyboard.press("Escape");

  for (const pane of ["general", "git", "memory", "skills"]) {
    await page.locator('button[title="Settings"]').first().click();
    await page.click(`[data-settings-nav="${pane}"]`);
    await page.waitForTimeout(800);
    await page.locator("[data-settings]").screenshot({ path: `${out}/settings-${pane}.png` });
    await page.keyboard.press("Escape");
  }
  await browser.close();
})();
```

- [ ] **Step 4: Take the screenshots.**
Run: `node /tmp/inspector-shots.cjs /tmp/inspector-shots`
Expected output:
```
manage pane: skills
tools pane: memory
```
and nine PNGs in `/tmp/inspector-shots`.

- [ ] **Step 5: Check each screenshot.** Open each PNG with the Read tool and check it against this list. Fix anything that fails, in the file named.
- `header.png`:
  - "Fork" and "Hand off to…" sit in the header actions row, next to the git step, styled like "Exit spec mode".
  - They are absent if the demo thread is working; pick an idle thread if so.
  - File: `ThreadView.tsx` `HeaderForkControl`.
- `tab-git.png`:
  - The status header is first: branch, sync badge, Sync, Pull, "N changed files ›", a recap line, and Finder/Editor (plus owner/repo when the demo has an origin).
  - The link row holds the owner/repo link and two small icon buttons (Finder, Editor) with tooltips.
  - Then Run: Dev server, Verification, Local servers.
  - Then Checkpoints collapsed with a count, then Lanes (collapsed, "Lanes 0", when none are claimed).
  - No drag grips, no "Reset order", no Fork, Pull requests, Changes or Display cards, no footer row.
  - File: `AgentsPanel.tsx` `GitTab`.
- `tab-agents.png`:
  - One session line ("provider · status · N turns · $x") and one muted token line.
  - No Model, Permission or Context rows.
  - On a crew worker thread: a "Lead: <title> ›" line and no Team section.
  - Sections share one heading style.
  - File: `AgentsPanel.tsx` `SessionLine` / `AgentsContent`.
- `tab-memory.png`:
  - One toolbar row: search, type, `+`.
  - The review banner, if the demo queue is non-empty.
  - The list (title, type pill, age).
  - The footer: scope, consolidation and "Code map & config doctor ›".
  - No code map or doctor in the tab.
  - File: `MemoryTab.tsx`.
- `tab-skills.png`:
  - One toolbar row: search, count, Filter, Manage ›.
  - No chips and no view buttons.
  - A drift banner only when something is out of sync.
  - The installed list.
  - Files: `SkillsTab.tsx`, `SkillsTab.module.css`.
- `settings-general.png`: a "Display" group with the four checkboxes. File: `SettingsModal.tsx` `DisplayPrefsSection`.
- `settings-git.png`: a "Spotlight" section with a project picker and one checkbox. File: `SpotlightSection`.
- `settings-memory.png`: the server status first, then "Project tools" with a picker, Code map and Config doctor. File: `SettingsModal.tsx` memory pane.
- `settings-skills.png`: Curated skills, MCP servers (built-in, curated, added, add form), Import from other tools, Add skill. The nav entry reads "Skills & MCP". Files: `SkillsTab.tsx` `SkillsManager`, `SettingsModal.tsx`.
- In every tab: section spacing and heading type match. The `.section` hairline comes from `Inspector.module.css`, with no double borders. The filter menu popover is not clipped by the toolbar.

- [ ] **Step 6: Stop the dev server** (kill the background `vite` process).

- [ ] **Step 7: Push and open the PR.**
- Title: "Inspector tabs: one job per tab, config moved to Settings, Fork in the header".
- The body:
  - lists the four tab changes, the four Settings additions and the header Fork / Hand off
  - links the spec
  - copies the "Spec discrepancies" list with the decisions taken
  - attaches the nine screenshots
  - ends with the Claude Code footer
- Run `npx vite build` once more right before pushing.
