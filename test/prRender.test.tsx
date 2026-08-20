/**
 * Sidebar thread-card structure, rendered from real components.
 *
 * T3 three-line card: slug + status label, title, branch/PR/provider.
 * Interaction contract is unchanged: stretch-select overlay under a
 * pointer-events:none body, hover actions as real sibling buttons (never
 * nested interactives), shell attribute hooks.
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
import { buildThreadActionMenuItems } from "../src/threadActionMenu";
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
      />,
    );
    const card = extractCard(html, "t1");
    assertNoNestedInteractive(card);
  });

  it("has stretch-select plus hover actions: snooze, settle, … menu", () => {
    const html = renderToStaticMarkup(
      <ThreadCard
        thread={thread({ status: "failed" })}
        slug="owner/repo"
        providers={providers}
        active={false}
        now={1}
        onSelect={() => {}}
        onSetSettled={() => {}}
        onSetSnoozed={() => {}}
      />,
    );
    const card = html;

    assert.ok(/cardSelect/.test(card), "stretch select button must be present");
    assert.ok(
      card.includes('data-more-btn="t1"'),
      "single … actions button must be present",
    );
    assert.ok(
      card.includes('data-snooze-btn="t1"'),
      "hover snooze button is back (opens the existing presets)",
    );
    assert.ok(
      card.includes('data-settle-btn="t1"'),
      "hover settle check lives next to snooze",
    );
    assert.ok(
      !card.includes("data-snooze-menu"),
      "#592: no in-card snooze menu — presets portal via showContextMenu",
    );
    assert.ok(
      !card.includes("data-more-menu"),
      "#592: no in-card overflow menu — it portals via showContextMenu",
    );
    assert.ok(!card.includes("data-pin-btn"), "hover pin button is retired");
    assert.ok(!card.includes("data-handoff-btn"), "old handoff button retired");
    assert.ok(
      card.includes("data-status-label"),
      "status is a text label, not a dot",
    );
    assert.ok(!card.includes("data-status-dot"));

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
    assert.ok(
      card.includes("data-status-label"),
      "failed thread renders a Failed status label",
    );
    assert.ok(card.includes(">Failed<") || /Failed/.test(card));
    assert.ok(!card.includes("data-status-dot"));
    assert.ok(
      card.includes("data-card-slug"),
      "every card carries its project slug",
    );
    assert.ok(
      card.includes("data-card-branch"),
      "line 3 carries the branch",
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
      card.includes("data-status-label"),
      "failed label still shows on the shell",
    );
    assert.ok(!card.includes("data-status-dot"));
    assert.equal((card.match(/<button\b/g) ?? []).length, 1);
  });

  it("PR badge is a real link and pin lives in the overflow", () => {
    const html = renderToStaticMarkup(
      <ThreadCard
        thread={thread({
          status: "idle",
          prNumber: 42,
          prUrl: "https://github.com/owner/repo/pull/42",
        })}
        slug="owner/repo"
        providers={providers}
        active={false}
        now={1}
        onSelect={() => {}}
        onSetPinned={() => {}}
      />,
    );
    assert.ok(html.includes("data-pr-badge"));
    assert.match(html, /<a\b[^>]*data-pr-badge/);
    assert.match(html, /#42/);
    // Pin lives in the portal menu (#592), not the static card markup.
    const items = buildThreadActionMenuItems({
      thread: thread({ status: "idle" }),
      providers,
      snoozePresets: [],
      isSettled: false,
      canSettle: true,
      showSnooze: false,
      showPin: true,
      showFork: false,
      showRename: false,
      showMute: false,
      showSettle: false,
    });
    assert.ok(
      items.some((i) => i.id === "pin" && i.attrs?.["data-pin-item"] === "t1"),
      "pin lives in the thread-actions menu",
    );
    assert.ok(!html.includes("data-pin-btn"));
    assert.ok(html.includes("data-card-provider"));
  });
});
