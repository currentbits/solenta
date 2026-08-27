/**
 * Secondary-view flatten: in-page grouping is type/space/hover, not card+border.
 * Same contract as the daily driver (#727), later pass (#728).
 * Spec: docs/superpowers/specs/2026-08-27-flatten-secondary-views-design.md
 *
 * Run: node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test --test-timeout=20000 test/flattenSecondaryViews.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const MODULES = [
  "src/components/MemoryTab.module.css",
  "src/components/SkillsTab.module.css",
  "src/components/SettingsModal.module.css",
  "src/components/KanbanView.module.css",
  "src/components/FleetView.module.css",
  "src/components/DigestView.module.css",
  "src/components/PlanboardView.module.css",
  "src/components/InsightsView.module.css",
  "src/components/UsageView.module.css",
  "src/components/AutomationsView.module.css",
] as const;

/** Floating frames and actual form fields may still be card+1px --border. */
const ALLOW_TILE = new Set([
  "modal",
  "settingsModal",
  "searchInput",
  "select",
  "titleInput",
  "bodyInput",
  "input",
  "textarea",
  "navSearch",
  "projectSelect",
  "startMode",
  "sort",
]);

function loadCss(rel: string): string {
  return fs
    .readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function ruleBody(css: string, className: string): string {
  for (const rule of topLevelRules(css)) {
    const parts = rule.selector.split(",");
    for (const part of parts) {
      if (part.trim() === `.${className}`) return rule.body;
    }
  }
  return "";
}

function hasTileBorder(body: string): boolean {
  return /border:\s*1px solid var\(--border\)/.test(body);
}

function hasCardFill(body: string): boolean {
  return /background:\s*var\(--card\)/.test(body);
}

function classNamesIn(selector: string): string[] {
  return [...selector.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]);
}

function topLevelRules(css: string): { selector: string; body: string }[] {
  const rules: { selector: string; body: string }[] = [];
  let i = 0;
  while (i < css.length) {
    const brace = css.indexOf("{", i);
    if (brace < 0) break;
    const selector = css.slice(i, brace).trim();
    let depth = 0;
    let j = brace;
    for (; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    const body = css.slice(brace + 1, j);
    if (selector.startsWith("@")) {
      i = j + 1;
      continue;
    }
    if (selector) rules.push({ selector, body });
    i = j + 1;
  }
  return rules;
}

function assertNotTile(css: string, className: string, file: string): void {
  const body = ruleBody(css, className);
  assert.ok(body, `${file} .${className} must exist`);
  assert.equal(
    hasTileBorder(body),
    false,
    `${file} .${className} must not use border: 1px solid var(--border)`,
  );
  assert.equal(
    hasCardFill(body),
    false,
    `${file} .${className} must not use background: var(--card)`,
  );
}

describe("secondary views cannot grow in-page tiles", () => {
  it("no in-page rule pairs --card fill with a 1px --border except inputs and modal frames", () => {
    for (const rel of MODULES) {
      const css = loadCss(rel);
      for (const rule of topLevelRules(css)) {
        if (!hasTileBorder(rule.body) || !hasCardFill(rule.body)) continue;
        const names = classNamesIn(rule.selector);
        const illicit = names.filter((n) => !ALLOW_TILE.has(n));
        assert.deepEqual(
          illicit,
          [],
          `${rel} ${rule.selector.trim()} is an in-page tile (card+1px --border)`,
        );
      }
    }
  });
});

describe("Memory / Skills / Settings inner grouping", () => {
  it("memory entries and doctor are not boxed cards", () => {
    const css = loadCss("src/components/MemoryTab.module.css");
    assertNotTile(css, "card", "MemoryTab");
    assertNotTile(css, "doctor", "MemoryTab");
    assertNotTile(css, "retryBtn", "MemoryTab");
  });

  it("expanded memory entry uses fill, not an outline", () => {
    const css = loadCss("src/components/MemoryTab.module.css");
    // Attribute selectors cannot live in a regex character class.
    const needle = '.card[data-expanded="true"]';
    const idx = css.indexOf(needle);
    assert.ok(idx >= 0, 'MemoryTab .card[data-expanded="true"] must exist');
    const brace = css.indexOf("{", idx);
    const end = css.indexOf("}", brace);
    const body = css.slice(brace + 1, end);
    assert.doesNotMatch(
      body,
      /border-color:\s*var\(--blue-border\)/,
      "expanded memory entry uses fill, not an outline",
    );
  });

  it("skills rows, add-form, preview, and instruction block are not tiles", () => {
    const css = loadCss("src/components/SkillsTab.module.css");
    for (const name of [
      "row",
      "form",
      "preview",
      "instructionCode",
      "ghostBtn",
      "chip",
    ]) {
      assertNotTile(css, name, "SkillsTab");
    }
  });

  it("settings inner rows and chrome buttons are not tiles; the window stays framed", () => {
    const css = loadCss("src/components/SettingsModal.module.css");
    assertNotTile(css, "memoryRow", "SettingsModal");
    assertNotTile(css, "gcCandidate", "SettingsModal");
    assertNotTile(css, "btn", "SettingsModal");
    const modal = ruleBody(css, "settingsModal");
    assert.ok(modal, "SettingsModal .settingsModal must exist");
    assert.equal(
      hasTileBorder(modal),
      true,
      "the settings window keeps a real edge",
    );
  });
});

describe("Kanban / Planboard / dashboard views", () => {
  it("kanban columns are sections, not tiles, and do not recardify thread rows", () => {
    const css = loadCss("src/components/KanbanView.module.css");
    assertNotTile(css, "column", "KanbanView");
    assert.doesNotMatch(
      css,
      /\[data-thread-card\][^{]*\{[^}]*background:\s*var\(--card\)/,
      "kanban must not recardify sidebar thread rows",
    );
  });

  it("planboard columns, issue cards, and live plans are not tiles", () => {
    const css = loadCss("src/components/PlanboardView.module.css");
    for (const name of [
      "column",
      "card",
      "planCard",
      "refresh",
      "retry",
      "start",
    ]) {
      assertNotTile(css, name, "PlanboardView");
    }
  });

  it("fleet and usage segmented chrome is ghost", () => {
    const fleet = loadCss("src/components/FleetView.module.css");
    const usage = loadCss("src/components/UsageView.module.css");
    assertNotTile(fleet, "segment", "FleetView");
    assertNotTile(fleet, "refresh", "FleetView");
    assertNotTile(fleet, "badgeNone", "FleetView");
    assertNotTile(usage, "segment", "UsageView");
    assertNotTile(usage, "refresh", "UsageView");
  });

  it("digest, insights, and automations rows are not tiles", () => {
    const digest = loadCss("src/components/DigestView.module.css");
    const insights = loadCss("src/components/InsightsView.module.css");
    const autos = loadCss("src/components/AutomationsView.module.css");
    assertNotTile(digest, "row", "DigestView");
    assertNotTile(digest, "refresh", "DigestView");
    assertNotTile(digest, "check", "DigestView");
    assertNotTile(digest, "risk", "DigestView");
    assertNotTile(insights, "mode", "InsightsView");
    assertNotTile(insights, "row", "InsightsView");
    assertNotTile(insights, "refresh", "InsightsView");
    assertNotTile(autos, "row", "AutomationsView");
    assertNotTile(autos, "action", "AutomationsView");
  });
});
