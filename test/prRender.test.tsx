/**
 * Renders real components to markup and asserts the PR feature is actually
 * wired to them.
 *
 * These exist because a reviewer proved that passing `prNumber: null` into the
 * sidebar badge, or `thread={null}` into the PR card, deletes every visible
 * part of this feature while the suite, tsc and vite build all stay green. The
 * pure decisions in src/prUi.ts were well tested; nothing checked that the
 * components call them with real data.
 *
 * Round 27 also covers the two PR-badge layout debts: PR chip must not live
 * inside the truncating branch span, and each card is one select tab stop
 * (stretch button) plus a separately focusable PR link.
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
      appName="Coder"
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
  // leaves two holes: a comment shaped like a rule hijacks the lookup (so a
  // commented-out .cardSelect block can hide a real z-index and ship a dead PR
  // link green), and a `}` inside a comment truncates the body and fails on a
  // declaration that is right there. A comment must never be able to satisfy
  // OR defeat an assertion about the code.
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

describe("sidebar PR badge (rendered)", () => {
  it("renders a real link to the PR when the thread has one", () => {
    const html = renderSidebar(
      thread({
        prNumber: 842,
        prUrl: "https://github.com/owner/repo/pull/842",
      }),
    );
    assert.ok(html.includes("PR #842"), "the PR number must be visible");
    assert.ok(
      html.includes('href="https://github.com/owner/repo/pull/842"'),
      "the badge must link to the PR",
    );
  });

  it("opens the PR link safely, outside the app", () => {
    const html = renderSidebar(
      thread({ prNumber: 7, prUrl: "https://github.com/owner/repo/pull/7" }),
    );
    const anchor = html.slice(
      html.indexOf("<a "),
      html.indexOf("</a>") + 4,
    );
    assert.ok(anchor.includes('target="_blank"'), "must leave the app window");
    // noreferrer implies noopener: without it the opened page gets window.opener.
    assert.ok(
      anchor.includes('rel="noreferrer"') || anchor.includes('rel="noopener'),
      `PR link needs rel=noreferrer, got: ${anchor}`,
    );
  });

  it("shows the number without a link when the url is missing", () => {
    const html = renderSidebar(thread({ prNumber: 99, prUrl: null }));
    assert.ok(html.includes("PR #99"), "number still shown");
    assert.ok(
      !html.includes("<a "),
      "must not invent a link when there is no url",
    );
  });

  it("shows no PR chip at all when the thread has no PR", () => {
    const html = renderSidebar(thread());
    assert.ok(!html.includes("PR #"), "no PR chip without a PR");
  });

  it("does not nest interactive elements inside the thread card", () => {
    // A nested <a> or <button> inside a <button> is invalid HTML and drops
    // clicks. This shipped once already, in a different component.
    const html = renderSidebar(
      thread({ prNumber: 5, prUrl: "https://github.com/owner/repo/pull/5" }),
    );
    const card = extractCard(html, "t1");
    assertNoNestedInteractive(card);
  });
});

describe("sidebar thread card: PR chip vs long branch (round 27)", () => {
  const longBranch =
    "coder/" + "very-long-slugified-title-segment-".repeat(4) + "abcdef";

  it("keeps the PR chip outside the truncating branch element", () => {
    assert.ok(longBranch.length >= 120, "fixture must be long enough");
    const html = renderSidebar(
      thread({
        branch: longBranch,
        prNumber: 842,
        prUrl: "https://github.com/owner/repo/pull/842",
      }),
    );
    const card = extractCard(html);

    assert.ok(card.includes("PR #842"), "PR chip must be present in the card");
    assert.ok(
      card.includes('href="https://github.com/owner/repo/pull/842"'),
      "PR link href must be present",
    );
    assert.ok(card.includes(longBranch), "long branch text must still render");

    // Truncation class is on .branch only. The PR <a> must not be a child of it.
    const branchMatch = card.match(
      /<span class="branch">([\s\S]*?)<\/span>/,
    );
    assert.ok(branchMatch, "expected a .branch span to carry truncation");
    assert.equal(
      branchMatch[1],
      longBranch,
      "branch span must hold only the branch name (not the PR chip)",
    );
    assert.ok(
      !branchMatch[1].includes("<a"),
      "PR link must not live inside the truncating .branch element",
    );
    assert.ok(
      !branchMatch[1].includes("PR #"),
      "PR label must not live inside the truncating .branch element",
    );

    // PR chip must still be a real anchor elsewhere in the card.
    assert.ok(
      /<a\b[^>]*>[\s\S]*PR #842[\s\S]*<\/a>/.test(card),
      "PR chip must be its own anchor outside .branch",
    );
  });

  it("truncates only .branch in CSS (ellipsis stays; chip is a flex sibling)", () => {
    const cssPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../src/components/Sidebar.module.css",
    );
    const css = fs.readFileSync(cssPath, "utf8");
    const branch = cssRuleBody(css, "branch");
    const branchRow = cssRuleBody(css, "branchRow");
    const prLink = cssRuleBody(css, "prLink");

    assert.ok(
      /overflow\s*:\s*hidden/.test(branch),
      ".branch must keep overflow:hidden for ellipsis",
    );
    assert.ok(
      /text-overflow\s*:\s*ellipsis/.test(branch),
      ".branch must keep text-overflow:ellipsis",
    );
    assert.ok(
      /white-space\s*:\s*nowrap/.test(branch),
      ".branch must keep white-space:nowrap",
    );
    assert.ok(
      /display\s*:\s*flex/.test(branchRow),
      ".branchRow must be a flex row so the chip can sit outside truncation",
    );
    // Load-bearing and easy to delete by accident: without min-width:0 this
    // flex item's automatic minimum size is the full untruncated branch width,
    // so nothing truncates and the chip lands outside the card. Measured at
    // ~1065px on a 266px card, i.e. the round 26 bug verbatim.
    assert.ok(
      /min-width\s*:\s*0/.test(branchRow),
      ".branchRow must allow shrink (min-width:0) or the chip is pushed out of the card",
    );
    // flex-grow on .branch inflates a short branch past its text and strands
    // the chip in dead space (measured: 83.5px gap after "main").
    const branchFlex = /flex\s*:\s*([^;]+)/.exec(branch);
    assert.ok(branchFlex, ".branch must declare flex");
    assert.equal(
      branchFlex[1].trim().split(/\s+/)[0],
      "0",
      ".branch must not grow, or a short branch strands the PR chip to the right",
    );
    assert.ok(
      /flex-shrink\s*:\s*0/.test(prLink),
      ".prLink must not shrink away when the branch is long",
    );
  });
});

describe("sidebar thread card: select + settle + PR link (round 39)", () => {
  it("has stretch-select and settle buttons, plus the PR link as an anchor", () => {
    // With onSetSettled wired, cards gain a settle hover control. Without it
    // (this static Sidebar render) only select remains — pass via ThreadCard.
    const html = renderToStaticMarkup(
      <ThreadCard
        thread={thread({
          prNumber: 842,
          prUrl: "https://github.com/owner/repo/pull/842",
          status: "failed",
        })}
        slug="owner/repo"
        providers={providers}
        active={false}
        now={1}
        onSelect={() => {}}
        onSetSettled={() => {}}
      />,
    );
    const card = html;

    assert.ok(
      /class="cardSelect"/.test(card) || /cardSelect/.test(card),
      "stretch select button must be present",
    );
    assert.ok(
      /aria-label="Settle thread"/.test(card),
      "settle hover control must be present with Settle thread label",
    );
    const buttons = card.match(/<button\b/g) ?? [];
    assert.equal(
      buttons.length,
      2,
      `expected 2 buttons (stretch-select + settle), got ${buttons.length}`,
    );

    const anchors = card.match(/<a\b/g) ?? [];
    assert.equal(
      anchors.length,
      1,
      "PR link is an <a>; no extra anchors",
    );
    assert.ok(
      card.includes("PR #842"),
      "the one anchor must be the PR chip",
    );

    // Empty stretch button: select control must not wrap the branch/meta text.
    const buttonChunk = card.match(/<button\b[\s\S]*?<\/button>/);
    assert.ok(buttonChunk, "select button present");
    assert.ok(
      !buttonChunk[0].includes("PR #842"),
      "PR must not be nested inside the select button",
    );
    assert.ok(
      !buttonChunk[0].includes("coder/"),
      "branch text must not be nested inside the select button",
    );
    assert.ok(
      !buttonChunk[0].includes("Done"),
      "status badge must not be a second button; it sits under the stretch hit target",
    );
  });

  it("keeps the select overlay UNDER the card body so the PR link stays clickable", () => {
    // The overlay is position:absolute inset:0 across the whole card. The link
    // survives only because .cardBody paints above it. Raise the overlay and
    // elementFromPoint at the link flips to the button: clicking the PR link
    // would select the thread instead of opening the PR, which is worse than
    // the invisible-chip bug this round fixes.
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
      `the select overlay must paint UNDER cardBody or it swallows the PR link (select=${zSel[1]}, body=${zBody[1]})`,
    );
  });

  it("wires the meta row into the same select hit target (structure + CSS)", () => {
    const html = renderSidebar(
      thread({
        prNumber: 11,
        prUrl: "https://github.com/owner/repo/pull/11",
        // failed, not done: done threads now fold under the settled toggle,
        // and this test needs a status badge visible in the default view.
        status: "failed",
        branch: "coder/meta-click-select-abcdef",
      }),
    );
    const card = extractCard(html);

    // Meta (branch + status) lives in .cardBody, sibling of the stretch button.
    // That is what makes a meta-row click select the thread (with pointer-events).
    assert.ok(
      /class="cardSelect"/.test(card),
      "stretch select button class must be present",
    );
    assert.ok(
      /class="cardBody"/.test(card),
      "cardBody wrapper must hold non-interactive content",
    );
    assert.ok(
      /class="cardMeta"/.test(card),
      "cardMeta row must still exist",
    );
    // cardMeta is inside cardBody (not a second select button).
    const bodyStart = card.indexOf('class="cardBody"');
    const metaStart = card.indexOf('class="cardMeta"');
    const selectStart = card.indexOf('class="cardSelect"');
    assert.ok(bodyStart >= 0 && metaStart >= 0 && selectStart >= 0);
    assert.ok(
      metaStart > bodyStart,
      "cardMeta must be inside cardBody so the stretch button covers it",
    );
    // Sibling, not wrapper. The old form was `selectStart < bodyStart || ...`,
    // whose first disjunct is unconditionally true because the overlay always
    // precedes the body in the markup: it could never fail.
    const selectChunk = card.match(/<button\b[\s\S]*?<\/button>/);
    assert.ok(selectChunk, "select button present");
    assert.ok(
      !selectChunk[0].includes("cardBody"),
      "cardSelect must be a sibling of cardBody, not wrap it",
    );
    // Stretch select + settle hover; no metaSelect maze. PR stays an <a>.
    assert.equal(
      (card.match(/<button\b/g) ?? []).length,
      1,
      "without onSetSettled only the stretch select button is present",
    );
    // Fixture is failed (fresh done no longer folds; MERGED would).
    assert.ok(card.includes("Failed"), "status badge still renders");

    const cssPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../src/components/Sidebar.module.css",
    );
    const css = fs.readFileSync(cssPath, "utf8");
    const cardSelect = cssRuleBody(css, "cardSelect");
    const cardBody = cssRuleBody(css, "cardBody");
    const prLink = cssRuleBody(css, "prLink");

    assert.ok(
      /position\s*:\s*absolute/.test(cardSelect),
      ".cardSelect must stretch over the card (position:absolute)",
    );
    assert.ok(
      /inset\s*:\s*0/.test(cardSelect),
      ".cardSelect must cover the full card (inset:0) so meta clicks select",
    );
    assert.ok(
      /pointer-events\s*:\s*none/.test(cardBody),
      ".cardBody must let clicks fall through to the stretch select button",
    );
    assert.ok(
      /pointer-events\s*:\s*auto/.test(prLink),
      ".prLink must re-enable pointer-events so the chip stays clickable",
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
        thread={thread({
          archived: true,
          status: "failed",
          prNumber: 3,
          prUrl: "https://github.com/owner/repo/pull/3",
        })}
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
    assert.ok(card.includes("Failed"), "status badge still shows");
    assert.ok(card.includes("archived"), "archived tag still shows");
    // Still one select button + PR link after the layout fix.
    assert.equal((card.match(/<button\b/g) ?? []).length, 1);
    assert.equal((card.match(/<a\b/g) ?? []).length, 1);
  });

  it("keeps the PR badge outside the truncating branch span", () => {
    // Round 26 nested PR #N inside .branch (overflow:ellipsis). Long branch
    // names then clipped the badge off the end. The PR must be a sibling of
    // the branch text, not a child of the ellipsis span.
    const longBranch =
      "coder/very-long-feature-branch-name-that-would-eat-the-pr-badge-abc12345";
    const html = renderSidebar(
      thread({
        branch: longBranch,
        prNumber: 842,
        prUrl: "https://github.com/owner/repo/pull/842",
      }),
    );
    assert.ok(html.includes("PR #842"), "PR number must still render");
    assert.ok(
      html.includes(longBranch),
      "branch text must still render in markup",
    );

    // Structural: the branch span must contain only the branch string, not
    // the PR anchor. Mutation that re-nests the <a> fails this.
    const branchSpan = html.match(
      /<span class="branch"[^>]*>([\s\S]*?)<\/span>/,
    );
    assert.ok(branchSpan, "branch span must exist");
    assert.equal(
      branchSpan![1].trim(),
      longBranch,
      `branch span must be branch-only, got: ${branchSpan![1]}`,
    );
    assert.ok(
      !branchSpan![1].includes("<a"),
      "PR link must not live inside the ellipsis span",
    );
    assert.ok(
      html.includes('href="https://github.com/owner/repo/pull/842"'),
      "PR link still present as a sibling",
    );
  });
});
