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

/** Every `.{className} { ... }` body (including nested/media/compound selectors). */
export function allRuleBodies(css: string, className: string): string[] {
  const bodies: string[] = [];
  const re = new RegExp(`\\.${className}(?![\\w-])\\s*\\{`, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(css))) {
    const brace = match.index + match[0].length - 1;
    const end = css.indexOf("}", brace);
    if (end < 0) break;
    bodies.push(css.slice(brace + 1, end));
  }
  return bodies;
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
      const bodies = allRuleBodies(css, name);
      assert.ok(bodies.length > 0, `${file} .${name} must exist`);
      for (const body of bodies) {
        assert.equal(
          hasTileBorder(body),
          false,
          `${file} .${name} must not use border: 1px solid var(--border)`,
        );
      }
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

describe("transcript", () => {
  it("in-page cards are not tiles", () => {
    const css = loadCss("src/components/ThreadView.module.css");
    for (const name of ["card", "planCard", "specCard", "suggestedRow"]) {
      // `.card` also appears in `.body > .card + .card`; check every body.
      const bodies = allRuleBodies(css, name);
      assert.ok(bodies.length > 0, `.${name} must exist`);
      for (const body of bodies) {
        assert.equal(hasTileBorder(body), false, `.${name} must drop 1px --border`);
        if (name !== "specCard") {
          assert.equal(hasCardFill(body), false, `.${name} must drop --card fill`);
        }
        assert.doesNotMatch(body, /box-shadow:/, `.${name} must drop shadow`);
      }
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
