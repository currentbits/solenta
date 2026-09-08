/**
 * #736 de-card: boxed in-page surfaces are fill + space, not 1px tiles.
 * Controls (buttons, inputs, popovers) keep --border. Structural seams
 * use --border-soft. Dark --border stays quieter than the old #2a3242.
 *
 * Run: node --import=./test/support/disable-grok-mcp.mjs --experimental-strip-types --test --test-timeout=20000 test/deCardUi.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadCss(rel: string): string {
  return fs
    .readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function ruleBody(css: string, className: string): string {
  const re = new RegExp(`\\.${className}(?![\\w-])\\s*\\{`);
  const match = re.exec(css);
  if (!match) return "";
  const brace = match.index + match[0].length - 1;
  const end = css.indexOf("}", brace);
  if (end < 0) return "";
  return css.slice(brace + 1, end);
}

function allRuleBodies(css: string, className: string): string[] {
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

describe("tokens", () => {
  it("dark --border is softer than the old #2a3242 tile edge", () => {
    const css = loadCss("src/index.css");
    const root = css.slice(0, css.indexOf(":root[data-theme"));
    const border = /--border:\s*(#[0-9a-fA-F]{3,8})/.exec(root)?.[1];
    const soft = /--border-soft:\s*(#[0-9a-fA-F]{3,8})/.exec(root)?.[1];
    assert.ok(border, "dark --border must be set");
    assert.ok(soft, "dark --border-soft must be set");
    assert.notEqual(
      border.toLowerCase(),
      "#2a3242",
      "dark --border must not stay at the high-contrast #2a3242",
    );
    assert.notEqual(border, soft, "--border and --border-soft stay distinct");
  });
});

describe("structural seams", () => {
  it("pane and section dividers use --border-soft, not --border", () => {
    const cases: Array<[string, string, RegExp]> = [
      ["src/App.module.css", "agentsRail", /border-left:\s*1px solid var\(--border-soft\)/],
      ["src/components/AgentsPanel.module.css", "panel", /border-left:\s*1px solid var\(--border-soft\)/],
      ["src/components/AgentsPanel.module.css", "tabs", /border-bottom:\s*1px solid var\(--border-soft\)/],
      ["src/components/AgentsPanel.module.css", "footer", /border-top:\s*1px solid var\(--border-soft\)/],
      ["src/components/ThreadView.module.css", "header", /border-bottom:\s*1px solid var\(--border-soft\)/],
      ["src/components/ThreadView.module.css", "changesHead", /border-bottom:\s*1px solid var\(--border-soft\)/],
      ["src/components/KanbanView.module.css", "header", /border-bottom:\s*1px solid var\(--border-soft\)/],
    ];
    for (const [file, name, re] of cases) {
      const body = ruleBody(loadCss(file), name);
      assert.ok(body, `${file} .${name} must exist`);
      assert.match(body, re, `${file} .${name} must use --border-soft`);
      assert.doesNotMatch(
        body,
        /border-(top|bottom|left|right):\s*1px solid var\(--border\)/,
        `${file} .${name} must not use --border for a seam`,
      );
    }
  });
});

describe("boxed surfaces flatten to fill, not outline", () => {
  it("transcript, composer, kanban, memory, skills cards drop --border tiles", () => {
    const thread = loadCss("src/components/ThreadView.module.css");
    const composer = loadCss("src/components/Composer.module.css");
    const kanban = loadCss("src/components/KanbanView.module.css");
    const memory = loadCss("src/components/MemoryTab.module.css");
    const skills = loadCss("src/components/SkillsTab.module.css");
    const agents = loadCss("src/components/AgentsPanel.module.css");

    for (const [file, css, name] of [
      ["ThreadView", thread, "card"],
      ["ThreadView", thread, "emptyGlyph"],
      ["ThreadView", thread, "diffComment"],
      ["Composer", composer, "card"],
      ["KanbanView", kanban, "column"],
      ["SkillsTab", skills, "preview"],
      ["SkillsTab", skills, "instructionCode"],
      ["AgentsPanel", agents, "sessionCard"],
      ["AgentsPanel", agents, "gitCard"],
      ["AgentsPanel", agents, "workflow"],
      ["AgentsPanel", agents, "teamSection"],
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

    const expanded =
      /\.card\[data-expanded="true"\]\s*\{([^}]*)\}/.exec(memory)?.[1] ?? "";
    assert.ok(expanded, "MemoryTab .card[data-expanded=true] must exist");
    assert.doesNotMatch(
      expanded,
      /border-color:\s*var\(--border\)/,
      "expanded memory rows stay fill-only",
    );
  });
});

describe("controls keep --border", () => {
  it("buttons, inputs, and popovers stay outlined", () => {
    const thread = loadCss("src/components/ThreadView.module.css");
    const composer = loadCss("src/components/Composer.module.css");
    const agents = loadCss("src/components/AgentsPanel.module.css");
    const memory = loadCss("src/components/MemoryTab.module.css");

    for (const [file, css, name] of [
      ["ThreadView", thread, "iconBtn"],
      ["ThreadView", thread, "menuBtn"],
      ["ThreadView", thread, "btn"],
      ["ThreadView", thread, "menu"],
      ["ThreadView", thread, "titleInput"],
      ["Composer", composer, "pill"],
      ["AgentsPanel", agents, "collapseBtn"],
      ["AgentsPanel", agents, "gitBtn"],
      ["MemoryTab", memory, "searchInput"],
    ] as const) {
      const bodies = allRuleBodies(css, name);
      assert.ok(bodies.length > 0, `${file} .${name} must exist`);
      assert.ok(
        bodies.some(hasTileBorder),
        `${file} .${name} must keep border: 1px solid var(--border)`,
      );
    }
  });
});
