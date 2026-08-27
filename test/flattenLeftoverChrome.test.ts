/**
 * Leftover-chrome flatten: in-page grouping is type/space/hover, not card+border.
 * Same contract as the daily driver (#727) and secondary views (#728).
 * Spec: docs/superpowers/specs/2026-08-27-flatten-leftover-chrome-design.md
 *
 * Run: node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test --test-timeout=20000 test/flattenLeftoverChrome.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const MODULES = [
  "src/components/ActivityView.module.css",
  "src/components/PrListView.module.css",
  "src/components/onboarding/OnboardingModal.module.css",
  "src/components/WorkflowsModal.module.css",
] as const;

/** Floating frames and actual form fields may still be card+1px --border. */
const ALLOW_TILE = new Set([
  "modal",
  "sheet",
  "input",
  "select",
  "textarea",
  "setupInput",
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

describe("leftover chrome cannot grow in-page tiles", () => {
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

describe("Activity / PR list rows and chrome", () => {
  it("activity rows and refresh are not tiles", () => {
    const css = loadCss("src/components/ActivityView.module.css");
    assertNotTile(css, "row", "ActivityView");
    assertNotTile(css, "refresh", "ActivityView");
  });

  it("pr list rows and chrome buttons are not tiles", () => {
    const css = loadCss("src/components/PrListView.module.css");
    for (const name of ["row", "refresh", "retry", "checkout"]) {
      assertNotTile(css, name, "PrListView");
    }
  });
});

describe("Onboarding / Workflows inner grouping", () => {
  it("onboarding inner rows are not tiles; the sheet stays framed", () => {
    const css = loadCss("src/components/onboarding/OnboardingModal.module.css");
    assertNotTile(css, "cliRow", "OnboardingModal");
    assertNotTile(css, "tourCard", "OnboardingModal");
    assertNotTile(css, "btn", "OnboardingModal");
    const sheet = ruleBody(css, "sheet");
    assert.ok(sheet, "OnboardingModal .sheet must exist");
    assert.equal(hasTileBorder(sheet), true, "the onboarding sheet keeps a real edge");
  });

  it("workflows inner phase cards and chrome are not tiles; the window stays framed", () => {
    const css = loadCss("src/components/WorkflowsModal.module.css");
    for (const name of [
      "phaseCard",
      "btn",
      "iconBtn",
      "deleteBtn",
      "newBtn",
    ]) {
      assertNotTile(css, name, "WorkflowsModal");
    }
    const modal = ruleBody(css, "modal");
    assert.ok(modal, "WorkflowsModal .modal must exist");
    assert.equal(hasTileBorder(modal), true, "the workflows window keeps a real edge");
  });
});
