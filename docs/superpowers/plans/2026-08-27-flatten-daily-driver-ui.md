# Flatten Daily-Driver UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the daily driver (thread transcript, Environment/Agents pane, composer, chrome buttons) read as a continuous page of type and space instead of a stack of bordered cards, without changing layout or functionality.

**Architecture:** CSS-first flatten. A contract test parses the four CSS modules and forbids in-page `background: var(--card)` + `border: 1px solid var(--border)` except for the composer shell and floating menus. Markup and `data-*-card` attributes stay. Blocking prompts keep a tinted wash, not a 1px tile.

**Tech Stack:** React CSS modules, Node test runner (`node:test`) reading CSS files as text (existing pattern in `test/threadView.test.tsx` and `test/sidebar.test.tsx`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-27-flatten-daily-driver-ui-design.md`
- Identity stays: Inter, existing dark/light tokens, blue accent, three-column shell.
- Functionality stays. Do not remove Plan, Work Log, Recap, Fork, Worktree, or any control.
- Do not restyle sidebar thread rows, Memory, Skills, Settings, Kanban, Fleet, or marketing screenshots.
- No new color tokens. Use `--overlay-hover`, `--border-soft`, `--blue-soft`.
- `data-*-card` attributes stay (tests query them).
- Focus-visible rings stay.
- Visible copy stays em-dash-free.
- Renderer tests: `node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test --test-timeout=20000 <file>`

---

### Task 1: Contract test and ghost chrome

**Files:**
- Create: `test/flattenDailyDriver.test.ts`
- Modify: `src/index.css` (comment above `--card`)
- Modify: `src/components/ThreadView.module.css` (`.iconBtn`, `.menuBtn`, `.paneTabs`, `.btn`, `.iconBtn[data-active="true"]`)
- Modify: `src/App.module.css` (`.agentsToggle`)
- Modify: `src/components/AgentsPanel.module.css` (`.collapseBtn`)

**Interfaces:**
- Consumes: CSS module source as UTF-8 text.
- Produces: `ruleBody(css, className)` helper used by later tasks in the same test file; ghost chrome with transparent borders.

- [ ] **Step 1: Write the failing contract test**

Create `test/flattenDailyDriver.test.ts`:

```ts
/**
 * Daily-driver flatten: in-page grouping is type/space/hover, not card+border.
 * Spec: docs/superpowers/specs/2026-08-27-flatten-daily-driver-ui-design.md
 *
 * Run: node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test --test-timeout=20000 test/flattenDailyDriver.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadCss(rel: string): string {
  return fs
    .readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

export function ruleBody(css: string, className: string): string {
  const re = new RegExp(`\\.${className}(?![\\w-])\\s*\\{`);
  const match = re.exec(css);
  if (!match) return "";
  const brace = match.index + match[0].length - 1;
  const end = css.indexOf("}", brace);
  if (end < 0) return "";
  return css.slice(brace + 1, end);
}

function hasTileBorder(body: string): boolean {
  return /border:\s*1px solid var\(--border\)/.test(body);
}

function hasCardFill(body: string): boolean {
  return /background:\s*var\(--card\)/.test(body);
}

describe("ghost chrome", () => {
  it("icon, menu, Views, and pane-toggle buttons are not 1px tiles", () => {
    const thread = loadCss("src/components/ThreadView.module.css");
    const app = loadCss("src/App.module.css");
    const agents = loadCss("src/components/AgentsPanel.module.css");

    for (const [file, css, name] of [
      ["ThreadView", thread, "iconBtn"],
      ["ThreadView", thread, "menuBtn"],
      ["ThreadView", thread, "paneTabs"],
      ["ThreadView", thread, "btn"],
      ["App", app, "agentsToggle"],
      ["AgentsPanel", agents, "collapseBtn"],
    ] as const) {
      const body = ruleBody(css, name);
      assert.ok(body, `${file} .${name} must exist`);
      assert.equal(
        hasTileBorder(body),
        false,
        `${file} .${name} must not use border: 1px solid var(--border)`,
      );
    }

    const active =
      /\.iconBtn\[data-active="true"\]\s*\{([^}]*)\}/.exec(thread)?.[1] ?? "";
    assert.ok(active, ".iconBtn[data-active=true] must exist");
    assert.doesNotMatch(
      active,
      /border-color:\s*var\(--blue-border\)/,
      "selected chrome uses fill, not an outline",
    );
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run:

```bash
node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test --test-timeout=20000 test/flattenDailyDriver.test.ts
```

Expected: FAIL, `.iconBtn` / `.paneTabs` / `.btn` / `.agentsToggle` / `.collapseBtn` still have `border: 1px solid var(--border)`.

- [ ] **Step 3: Ghost the chrome**

In `src/index.css`, immediately above `--card: #171d29;`:

```css
  /* --card + 1px --border is for floating surfaces and the composer.
     In-page grouping uses type, space, and hover (flatten daily-driver). */
```

In `src/components/ThreadView.module.css`:

`.paneTabs` replace `border: 1px solid var(--border);` and `background: var(--bg-elevated);` with:

```css
  border: 1px solid transparent;
  background: transparent;
```

`.iconBtn` replace `border: 1px solid var(--border);` with:

```css
  border: 1px solid transparent;
```

`.iconBtn[data-active="true"]` replace `border-color: var(--blue-border);` with:

```css
  border-color: transparent;
```

`.menuBtn` replace `border: 1px solid var(--border);` with:

```css
  border: 1px solid transparent;
```

`.btn` replace `border: 1px solid var(--border);` with:

```css
  border: 1px solid transparent;
```

Leave `.btnPrimary` as a solid fill (`border-color: transparent` already). Leave `.btn[data-active="true"]` fill; set its `border-color` to `transparent` if it currently uses `--blue-border`.

In `src/App.module.css` `.agentsToggle`, replace `border: 1px solid var(--border);` with:

```css
  border: 1px solid transparent;
```

In `src/components/AgentsPanel.module.css` `.collapseBtn` (the 30x30 one with the border, around line 86), replace `border: 1px solid var(--border);` with:

```css
  border: 1px solid transparent;
```

Keep `box-shadow: var(--focus-ring)` on `:focus-visible`.

- [ ] **Step 4: Run the test and related header tests**

```bash
node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test --test-timeout=20000 test/flattenDailyDriver.test.ts test/threadHeader.test.tsx test/agentsCollapse.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/flattenDailyDriver.test.ts src/index.css src/components/ThreadView.module.css src/App.module.css src/components/AgentsPanel.module.css
git commit -m "style: ghost daily-driver chrome buttons"
```

---

### Task 2: Flatten Environment and Agents sections

**Files:**
- Modify: `src/components/AgentsPanel.module.css` (`.gitCard`, `.sessionCard`, `.teamSection`, `.workflow`, `.phaseChip`, `.roleChip`, `.panel`)
- Modify: `test/flattenDailyDriver.test.ts`

**Interfaces:**
- Consumes: Task 1 `loadCss` / `ruleBody`.
- Produces: section blocks with labels and gap, no tiles. `data-repo-card` and friends unchanged.

- [ ] **Step 1: Extend the contract test (fails)**

Append to `test/flattenDailyDriver.test.ts`:

```ts
describe("Environment / Agents sections", () => {
  it("git/session/team/workflow blocks are not cards", () => {
    const css = loadCss("src/components/AgentsPanel.module.css");
    for (const name of ["gitCard", "sessionCard", "teamSection", "workflow"]) {
      const body = ruleBody(css, name);
      assert.ok(body, `.${name} must exist`);
      assert.equal(hasTileBorder(body), false, `.${name} must drop 1px --border`);
      assert.equal(hasCardFill(body), false, `.${name} must drop --card fill`);
      assert.doesNotMatch(body, /box-shadow:/, `.${name} must drop shadow`);
    }
  });

  it("right pane seam uses --border-soft", () => {
    const css = loadCss("src/components/AgentsPanel.module.css");
    const panel = ruleBody(css, "panel");
    assert.match(panel, /border-left:\s*1px solid var\(--border-soft\)/);
  });
});
```

Add `hasCardFill` next to `hasTileBorder` if Step 1 of Task 1 did not already export it in the same file (it should: keep both helpers at the top of the file, not nested in the first describe).

- [ ] **Step 2: Run it to make sure it fails**

```bash
node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test --test-timeout=20000 test/flattenDailyDriver.test.ts
```

Expected: FAIL on `.gitCard` still having border + `--card` + shadow.

- [ ] **Step 3: Flatten the section classes**

Replace `.gitCard` with:

```css
.gitCard {
  background: transparent;
  border: none;
  border-radius: 0;
  padding: 4px 2px 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
```

Replace `.sessionCard` with:

```css
.sessionCard {
  background: transparent;
  border: none;
  border-radius: 0;
  padding: 4px 2px 10px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
```

Replace `.teamSection` with:

```css
.teamSection {
  background: transparent;
  border: none;
  border-radius: 0;
  padding: 4px 2px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
```

Replace `.workflow` with:

```css
.workflow {
  background: transparent;
  border: none;
  border-radius: 0;
  padding: 4px 2px 10px;
}
```

`.panel` `border-left: 1px solid var(--border);` → `border-left: 1px solid var(--border-soft);`
`.rail` the same if it uses `--border`.

`.phaseChip` and `.roleChip`: replace `border: 1px solid var(--border);` with `border: 1px solid transparent;`. Keep `.phaseDone` / `.phaseActive` / `.phaseFailed` fills; set their `border-color` to `transparent` (they currently set `--green-border` / `--blue-border` / `--danger-border`).

Keep `.gitCardLabel` as-is (type hierarchy is the grouping).

Do not change Memory/Skills module CSS.

- [ ] **Step 4: Run flatten + environment tests**

```bash
node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test --test-timeout=20000 test/flattenDailyDriver.test.ts test/environmentCards.test.tsx test/teamView.test.tsx test/crewTasks.test.tsx test/devServer.test.tsx test/verifyCard.test.ts test/checkpoints.test.tsx
```

Expected: PASS. `data-repo-card` / `data-prs-card` still present.

- [ ] **Step 5: Commit**

```bash
git add src/components/AgentsPanel.module.css test/flattenDailyDriver.test.ts
git commit -m "style: flatten Environment and Agents section tiles"
```

---

### Task 3: Flatten the transcript

**Files:**
- Modify: `src/components/ThreadView.module.css` (`.card`, `.planCard`, `.specCard`, `.permissionCard`, `.suggestedRow`, `.statusStrip`, `.queuedStrip`, `.userBubble`, `.emptyGlyph`)
- Modify: `test/flattenDailyDriver.test.ts`

**Interfaces:**
- Consumes: Task 1 helpers. `ThreadView.tsx` keeps `styles.card` on events, tools, and Work Log.
- Produces: transcript blocks that are type, not tiles. `[data-plan-card]` still renders.

- [ ] **Step 1: Extend the contract test (fails)**

Append:

```ts
describe("transcript", () => {
  it("in-page cards are not tiles", () => {
    const css = loadCss("src/components/ThreadView.module.css");
    for (const name of ["card", "planCard", "specCard", "suggestedRow"]) {
      const body = ruleBody(css, name);
      assert.ok(body, `.${name} must exist`);
      assert.equal(hasTileBorder(body), false, `.${name} must drop 1px --border`);
      if (name !== "specCard") {
        assert.equal(hasCardFill(body), false, `.${name} must drop --card fill`);
      }
      assert.doesNotMatch(body, /box-shadow:/, `.${name} must drop shadow`);
    }
  });

  it("user bubble keeps a wash and drops the outline", () => {
    const css = loadCss("src/components/ThreadView.module.css");
    const body = ruleBody(css, "userBubble");
    assert.match(body, /background:\s*var\(--blue-soft\)/);
    assert.doesNotMatch(body, /border:\s*1px solid var\(--blue-border\)/);
  });

  it("status strip is a wash, not a box", () => {
    const css = loadCss("src/components/ThreadView.module.css");
    const body = ruleBody(css, "statusStrip");
    assert.match(body, /background:\s*var\(--blue-soft\)/);
    assert.doesNotMatch(body, /border:\s*1px solid/);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test --test-timeout=20000 test/flattenDailyDriver.test.ts
```

Expected: FAIL on `.card` still tiled.

- [ ] **Step 3: Flatten transcript surfaces**

Replace `.card` with:

```css
.card {
  background: transparent;
  border: none;
  border-radius: 0;
  padding: 2px 0;
  box-shadow: none;
}
```

Keep `.card.toolCard { padding: 0; overflow: hidden; max-width: 100%; }`.

`.planCard`: drop `border` and `background: var(--card);` (transparent, no border). Keep padding and gap.

`.specCard`: keep a wash (`background: var(--overlay-soft)` or the existing tint if any), drop `border: 1px solid var(--border-soft)` and `background: var(--card)`. Use:

```css
.specCard {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-radius: var(--radius);
  border: none;
  background: var(--overlay-soft);
  font-size: 12.5px;
}
```

`.permissionCard`: drop `border: 1px solid var(--amber-border);`, keep `background: var(--amber-soft)`.

`.suggestedRow`: replace `border: 1px solid var(--border);` with `border: none;`, keep transparent background, keep padding.

`.statusStrip`: remove `border: 1px solid var(--blue-border);`. Keep `background: var(--blue-soft)`. Do the same for `.statusStripStalled` / `.statusStripQuotaWait` (drop `border-color`, keep wash).

`.queuedStrip`: remove `border: 1px solid var(--border);` and `background: var(--card);`. Use `background: var(--overlay-soft); border: none;`.

`.userBubble`: remove `border: 1px solid var(--blue-border);`. Keep fill and radius. Same for `.userEditTextarea`.

`.emptyGlyph`: remove `border`, `background: var(--card)`, and `box-shadow`. Transparent is fine.

`.toolBody` may keep `border-top: 1px solid var(--border-soft)` (that is a divider on expand, not a tile).

Do not restyle `.menu`, `.confirmDialog`, `.lightboxClose` (floating).

- [ ] **Step 4: Run transcript tests**

```bash
node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test --test-timeout=20000 test/flattenDailyDriver.test.ts test/threadView.test.tsx test/planCard.test.tsx test/suggestedWorkChips.test.tsx test/permissionPrompt.test.tsx test/specCard.test.tsx test/askCard.test.tsx test/teachCard.test.tsx test/feltCard.test.tsx test/queuedFollowup.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/ThreadView.module.css test/flattenDailyDriver.test.ts
git commit -m "style: flatten transcript cards into type and space"
```

---

### Task 4: Composer is the one object

**Files:**
- Modify: `src/components/Composer.module.css` (`.card`, `.pill`, `.pillAccent`)
- Modify: `test/flattenDailyDriver.test.ts`

**Interfaces:**
- Consumes: Task 1 helpers.
- Produces: composer shell with fill + hairline, no drop shadow; ghost pills.

- [ ] **Step 1: Extend the contract test (fails)**

Append:

```ts
describe("composer", () => {
  it("stays an object but does not float on a drop shadow", () => {
    const css = loadCss("src/components/Composer.module.css");
    const card = ruleBody(css, "card");
    assert.ok(card, "composer .card must exist");
    assert.match(card, /background:\s*var\(--card\)/);
    assert.match(card, /border:\s*1px solid var\(--border\)/);
    assert.doesNotMatch(card, /box-shadow:/);
  });

  it("pills are ghost chrome", () => {
    const css = loadCss("src/components/Composer.module.css");
    const pill = ruleBody(css, "pill");
    assert.equal(hasTileBorder(pill), false);
    const accent = ruleBody(css, "pillAccent");
    assert.doesNotMatch(accent, /border-color:\s*var\(--blue-border\)/);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test --test-timeout=20000 test/flattenDailyDriver.test.ts
```

Expected: FAIL on composer `.card` still having `box-shadow` and `.pill` still tiled.

- [ ] **Step 3: Restyle composer**

`.card` remove the line `box-shadow: 0 8px 24px var(--shadow-color);`. Keep fill, radius 14px, hairline, padding, `:focus-within` hairline tint.

`.pill` replace `border: 1px solid var(--border);` with `border: 1px solid transparent;`.

`.pillAccent` replace `border-color: var(--blue-border);` with `border-color: transparent;`. Keep `background: var(--blue-soft)`.

`.pill:focus-visible` box-shadow stays.

- [ ] **Step 4: Run composer + full flatten contract**

```bash
node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test --test-timeout=20000 test/flattenDailyDriver.test.ts test/composer.test.tsx test/bestOfNComposer.test.tsx test/composerStop.test.tsx
```

Expected: PASS.

Then run the renderer suite (or at least the daily-driver files above plus `test/threadView.test.tsx test/environmentCards.test.tsx`).

- [ ] **Step 5: Commit**

```bash
git add src/components/Composer.module.css test/flattenDailyDriver.test.ts
git commit -m "style: drop composer shadow and ghost pills"
```

---

## Self-review

1. Spec coverage: chrome (Task 1), Environment/Agents (Task 2), transcript (Task 3), composer (Task 4). Out of scope (Memory/Skills/screenshots) is explicit and has no task.
2. No TBD/placeholder steps. CSS is the actual replacement.
3. `hasTileBorder` / `hasCardFill` / `loadCss` / `ruleBody` names are stable across tasks. Composer `.card` is the exception that **must** keep `--card` + `--border`.
