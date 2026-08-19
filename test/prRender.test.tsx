/**
 * Sidebar thread-card structure, rendered from real components.
 *
 * The PR chip, branch text and status-badge assertions that used to live here
 * died with #566: rows are one line (dot + title + age) and sidebarPrBadge is
 * no longer wired into Sidebar. What survives is the card's interaction
 * contract: a stretch-select overlay under a pointer-events:none body, hover
 * actions as real sibling buttons (never nested interactives), and the shell
 * attribute hooks.
 *
 * Run: node --import=./test/support/render.mjs --test test/prRender.test.tsx
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Sidebar, ThreadCard } from "../src/components/Sidebar";
import type { ProjectInfo, ThreadInfo, ProviderInfo } from "../src/shared/ipc";

const project: ProjectInfo = {
  id: "p1",
  slug: "owner/repo",
  name: "repo",
  path: "/tmp/repo",
};

const providers: ProviderInfo[] = [
  {
    id: "claude",
    name: "Claude Code",
    available: true,
    supportsResume: true,
    models: [],
    modelInfo: [],
    efforts: [],
  },
];

/** Recent activity so inactivity auto-settle does not fold the card away. */
const FRESH = Date.now();

function thread(over: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id: "t1",
    projectId: "p1",
    title: "add pr support",
    branch: "coder/add-pr-support-abc123",
    prNumber: null,
    prUrl: null,
    status: "idle",
    createdAt: FRESH,
    updatedAt: FRESH,
    runStartedAt: null,
    archived: false,
    settledOverride: null,
    settledAt: null,
    pinnedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: null,
    prState: null,
    provider: "claude",
    model: null,
    sessionId: null,
    permissionMode: "default",
    reasoningEffort: null,
    worktreePath: null,
    ...over,
  };
}

function renderSidebar(t: ThreadInfo): string {
  return renderToStaticMarkup(
    <Sidebar
      appName="Solenta"
      searchPlaceholder="Search"
      projectsHeader="Projects"
      projects={[project]}
      threads={[t]}
      providers={providers}
      activeThreadId={t.id}
      onSelectThread={() => {}}
      onCreateThread={() => {}}
      onAddProject={() => {}}
      searchThreads={async () => []}
    />,
  );
}

/** Slice the single thread card markup by data-thread-card id. */
function extractCard(html: string, id = "t1"): string {
  const marker = `data-thread-card="${id}"`;
  const at = html.indexOf(marker);
  assert.ok(at >= 0, `expected data-thread-card="${id}" in markup`);
  const start = html.lastIndexOf("<div", at);
  assert.ok(start >= 0, "card open tag");
  let depth = 0;
  let i = start;
  while (i < html.length) {
    if (html.startsWith("</div>", i)) {
      depth -= 1;
      i += 6;
      if (depth === 0) return html.slice(start, i);
      continue;
    }
    if (html.startsWith("<div", i)) {
      depth += 1;
      i = html.indexOf(">", i) + 1;
      continue;
    }
    i += 1;
  }
  throw new Error("unclosed thread card");
}

/**
 * Body of a CSS class rule. Matches `.name {` only (not `.nameRow` / `.nameSep`).
 * Returns empty string if missing.
 */
function cssRuleBody(css: string, className: string): string {
  // Strip comments FIRST, before locating the rule. Stripping only the slice
  // leaves two holes: a comment shaped like a rule hijacks the lookup, and a
  // `}` inside a comment truncates the body. A comment must never be able to
  // satisfy OR defeat an assertion about the code.
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = new RegExp(`\\.${className}(?![\\w-])\\s*\\{`);
  const m = re.exec(clean);
  if (!m) return "";
  const brace = m.index + m[0].length - 1;
  const end = clean.indexOf("}", brace);
  if (end < 0) return "";
  return clean.slice(brace + 1, end);
}

function assertNoNestedInteractive(html: string): void {
  // Self-closing-ish opens: <button ...> or <a ...>; closes: </button> </a>
  const opens = [...html.matchAll(/<\/?button\b|<\/?a\b/g)];
  let depth = 0;
  for (const m of opens) {
    const tag = m[0];
    if (tag.startsWith("</")) {
      depth -= 1;
    } else {
      depth += 1;
      assert.ok(
        depth <= 1,
        `interactive element nested inside another at index ${m.index}`,
      );
    }
  }
}

describe("sidebar thread card: select + actions structure (#566)", () => {
  it("does not nest interactive elements inside the thread card", () => {
    // A nested <a> or <button> inside a <button> is invalid HTML and drops
    // clicks. This shipped once already, in a different component.
    const html = renderToStaticMarkup(
      <ThreadCard
        thread={thread({ status: "failed" })}
        slug="owner/repo"
        providers={providers}
        active={false}
        now={1}
        onSelect={() => {}}
        onSetSettled={() => {}}
        onSetPinned={() => {}}
        onSetSnoozed={() => {}}
        onFork={() => {}}
        onRenameThread={() => {}}
        onSetMuted={() => {}}
        snoozeMenuOpen={true}
        onToggleSnoozeMenu={() => {}}
      />,
    );
    const card = extractCard(html, "t1");
    assertNoNestedInteractive(card);
  });

  it("has stretch-select plus hover actions: pin and one … menu", () => {
    const html = renderToStaticMarkup(
      <ThreadCard
        thread={thread({ status: "failed" })}
        slug="owner/repo"
        providers={providers}
        active={false}
        now={1}
        onSelect={() => {}}
        onSetSettled={() => {}}
        snoozeMenuOpen={true}
        onToggleSnoozeMenu={() => {}}
      />,
    );
    const card = html;

    assert.ok(/cardSelect/.test(card), "stretch select button must be present");
    assert.ok(
      card.includes('data-more-btn="t1"'),
      "single … actions button must be present",
    );
    assert.ok(
      card.includes('data-snooze-menu="t1"'),
      "open menu container must be present",
    );
    assert.ok(
      card.includes('data-settle-item="t1"'),
      "settle lives in the menu now",
    );
    assert.ok(
      card.includes("Settle thread"),
      "settle item keeps its Settle thread label",
    );
    // Only onSetSettled is wired: select + … + settle item. No pin without
    // onSetPinned, no standalone settle arrow, no snooze/handoff buttons.
    const buttons = card.match(/<button\b/g) ?? [];
    assert.equal(
      buttons.length,
      3,
      `expected 3 buttons (stretch-select + more + settle item), got ${buttons.length}`,
    );
    assert.ok(!card.includes("data-snooze-btn"), "old snooze button retired");
    assert.ok(!card.includes("data-handoff-btn"), "old handoff button retired");
    assert.equal(card.match(/<a\b/g), null, "no anchors in a one-line row");

    // Empty stretch button: select control must not wrap the row content.
    // (The title appears in its aria-label; the element itself stays empty.)
    const buttonChunk = card.match(/<button\b[^>]*>([\s\S]*?)<\/button>/);
    assert.ok(buttonChunk, "select button present");
    assert.equal(
      buttonChunk[1],
      "",
      "row content must not be nested inside the select button",
    );
  });

  it("keeps the select overlay UNDER the card body so row controls stay clickable", () => {
    // The overlay is position:absolute inset:0 across the whole card. The
    // body content (dot tooltip target, badges) survives only because
    // .cardBody paints above it.
    const cssPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../src/components/Sidebar.module.css",
    );
    const css = fs.readFileSync(cssPath, "utf8");
    const zSel = /z-index\s*:\s*(-?\d+)/.exec(cssRuleBody(css, "cardSelect"));
    const zBody = /z-index\s*:\s*(-?\d+)/.exec(cssRuleBody(css, "cardBody"));
    assert.ok(zSel, ".cardSelect must declare an explicit z-index");
    assert.ok(zBody, ".cardBody must declare an explicit z-index");
    assert.ok(
      Number(zSel[1]) < Number(zBody[1]),
      `the select overlay must paint UNDER cardBody (select=${zSel[1]}, body=${zBody[1]})`,
    );
  });

  it("wires the row content into the same select hit target (structure + CSS)", () => {
    const html = renderSidebar(
      thread({
        status: "failed",
        branch: "coder/meta-click-select-abcdef",
      }),
    );
    const card = extractCard(html);

    // Row content lives in .cardBody, sibling of the stretch button. That is
    // what makes a row click select the thread (with pointer-events).
    assert.ok(
      /class="cardSelect"/.test(card),
      "stretch select button class must be present",
    );
    assert.ok(
      /class="cardBody"/.test(card),
      "cardBody wrapper must hold non-interactive content",
    );
    // Sibling, not wrapper.
    const selectChunk = card.match(/<button\b[\s\S]*?<\/button>/);
    assert.ok(selectChunk, "select button present");
    assert.ok(
      !selectChunk[0].includes("cardBody"),
      "cardSelect must be a sibling of cardBody, not wrap it",
    );
    // Without action handlers only the stretch select button is present.
    assert.equal(
      (card.match(/<button\b/g) ?? []).length,
      1,
      "without action handlers only the stretch select button is present",
    );
    // Failed state is a dot now, not a text badge.
    assert.ok(
      card.includes('data-status-dot="failed"'),
      "failed thread renders a failed status dot",
    );
    assert.ok(
      card.includes('title="Failed"'),
      "failed dot carries the tooltip",
    );

    const cssPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../src/components/Sidebar.module.css",
    );
    const css = fs.readFileSync(cssPath, "utf8");
    const cardSelect = cssRuleBody(css, "cardSelect");
    const cardBody = cssRuleBody(css, "cardBody");

    assert.ok(
      /position\s*:\s*absolute/.test(cardSelect),
      ".cardSelect must stretch over the card (position:absolute)",
    );
    assert.ok(
      /inset\s*:\s*0/.test(cardSelect),
      ".cardSelect must cover the full card (inset:0) so row clicks select",
    );
    assert.ok(
      /pointer-events\s*:\s*none/.test(cardBody),
      ".cardBody must let clicks fall through to the stretch select button",
    );
    assert.ok(
      /:focus-visible/.test(css) && css.includes(".cardSelect:focus-visible"),
      "select control must have a visible focus style",
    );
  });

  it("keeps archived and active attributes on the card shell", () => {
    // Archived threads are collapsed in Sidebar until the toggle expands them,
    // so render ThreadCard directly for the attribute hooks.
    const html = renderToStaticMarkup(
      <ThreadCard
        thread={thread({ archived: true, status: "failed" })}
        slug="owner/repo"
        providers={providers}
        active={true}
        now={1}
        onSelect={() => {}}
      />,
    );
    const card = extractCard(html);
    assert.ok(
      card.includes('data-archived="true"'),
      "archived styling hook must remain",
    );
    assert.ok(
      card.includes('data-active="true"'),
      "active styling hook must remain",
    );
    assert.ok(
      card.includes('data-status-dot="failed"'),
      "failed dot still shows on the shell",
    );
    // One select button, no anchors on a one-line row.
    assert.equal((card.match(/<button\b/g) ?? []).length, 1);
    assert.equal(card.match(/<a\b/g), null);
  });
});
