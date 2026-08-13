/**
 * PR UI pure decisions (sidebar badge + Git-tab card).
 * Run: node --experimental-strip-types --test test/prUi.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatChecksRollup, prCardView, sidebarPrBadge } from "../src/prUi.ts";
import type { PrCheckInfo, PrInfo } from "../src/shared/ipc.ts";

const openPr: PrInfo = {
  number: 42,
  url: "https://github.com/acme/app/pull/42",
  state: "OPEN",
  branch: "feat/x",
  created: true,
};

describe("sidebarPrBadge", () => {
  it("returns null when there is no PR number", () => {
    assert.equal(
      sidebarPrBadge({ prNumber: null, prUrl: "https://example.com" }),
      null,
    );
  });

  it("labels the number and links when prUrl is set", () => {
    const badge = sidebarPrBadge({
      prNumber: 842,
      prUrl: "https://github.com/pingdotgg/t3code/pull/842",
    });
    assert.deepEqual(badge, {
      label: "PR #842",
      href: "https://github.com/pingdotgg/t3code/pull/842",
    });
  });

  it("keeps the label but drops the href when prUrl is missing", () => {
    assert.deepEqual(sidebarPrBadge({ prNumber: 7, prUrl: null }), {
      label: "PR #7",
      href: null,
    });
    assert.deepEqual(sidebarPrBadge({ prNumber: 7, prUrl: "   " }), {
      label: "PR #7",
      href: null,
    });
  });
});

describe("prCardView", () => {
  const base = {
    branch: "feat/settings",
    threadPrNumber: null as number | null,
    threadPrUrl: null as string | null,
    live: undefined as PrInfo | null | undefined,
    titleDraft: "Modernize settings",
    busy: false,
  };

  it("prefers live status over recorded thread fields", () => {
    const v = prCardView(base);
    assert.equal(v.showForm, true);
    assert.equal(v.existing, null);
  });

  it("enables create only with branch, non-empty title, not busy, no existing PR", () => {
    assert.equal(prCardView(base).canCreate, true);
    assert.equal(
      prCardView({ ...base, titleDraft: "  " }).canCreate,
      false,
      "blank title",
    );
    assert.equal(
      prCardView({ ...base, branch: null }).canCreate,
      false,
      "no branch",
    );
    assert.equal(
      prCardView({ ...base, branch: "" }).canCreate,
      false,
      "empty branch",
    );
    assert.equal(
      prCardView({ ...base, busy: true }).canCreate,
      false,
      "busy",
    );
  });

  it("shows thread PR fields before live status loads", () => {
    const v = prCardView({
      ...base,
      threadPrNumber: 842,
      threadPrUrl: "https://github.com/acme/app/pull/842",
      live: undefined,
    });
    assert.equal(v.showForm, false);
    assert.equal(v.canCreate, false);
    assert.deepEqual(v.existing, {
      number: 842,
      url: "https://github.com/acme/app/pull/842",
      state: null,
      branch: "feat/settings",
    });
  });

  it("prefers live PrInfo over thread fields", () => {
    const v = prCardView({
      ...base,
      threadPrNumber: 1,
      threadPrUrl: "https://old.example/1",
      live: openPr,
    });
    assert.equal(v.showForm, false);
    assert.deepEqual(v.existing, {
      number: 42,
      url: openPr.url,
      state: "OPEN",
      branch: "feat/x",
    });
  });

  it("carries optional title and diff stats from live PrInfo", () => {
    const v = prCardView({
      ...base,
      live: {
        ...openPr,
        title: "Cache provider usage",
        additions: 464,
        deletions: 63,
        changedFiles: 17,
      },
    });
    assert.deepEqual(v.existing, {
      number: 42,
      url: openPr.url,
      state: "OPEN",
      branch: "feat/x",
      title: "Cache provider usage",
      additions: 464,
      deletions: 63,
      changedFiles: 17,
    });
  });

  it("omits title and stats when live PrInfo does not include them", () => {
    const v = prCardView({
      ...base,
      threadPrNumber: 842,
      threadPrUrl: "https://github.com/acme/app/pull/842",
      live: undefined,
    });
    assert.equal(v.existing?.title, undefined);
    assert.equal(v.existing?.additions, undefined);
    assert.equal(v.existing?.deletions, undefined);
    assert.equal(v.existing?.changedFiles, undefined);
  });

  it("passes through a partial stats set without inventing numbers", () => {
    const v = prCardView({
      ...base,
      live: { ...openPr, additions: 12, changedFiles: 3 },
    });
    assert.equal(v.existing?.additions, 12);
    assert.equal(v.existing?.deletions, undefined);
    assert.equal(v.existing?.changedFiles, 3);
    assert.equal(v.existing?.title, undefined);
  });

  it("treats live null as confirmed absent even if thread fields linger", () => {
    const v = prCardView({
      ...base,
      threadPrNumber: 99,
      threadPrUrl: "https://stale.example/99",
      live: null,
    });
    assert.equal(v.existing, null);
    assert.equal(v.showForm, true);
    assert.equal(v.canCreate, true);
  });
});

describe("a finished PR does not block a follow-up", () => {
  const merged = {
    number: 7,
    url: "https://github.com/owner/repo/pull/7",
    state: "MERGED" as const,
    branch: "coder/x-abc",
    created: false,
  };

  it("keeps the form available once the PR is merged or closed", () => {
    // createPr opens a follow-up after a merge. If the card hides the form the
    // user has no way to ask, and the backend fix is unreachable.
    for (const state of ["MERGED", "CLOSED"] as const) {
      const v = prCardView({
        branch: "coder/x-abc",
        threadPrNumber: 7,
        threadPrUrl: merged.url,
        live: { ...merged, state },
        titleDraft: "Follow-up",
        busy: false,
      });
      assert.equal(v.showForm, true, `${state} must still allow a new PR`);
      assert.equal(v.canCreate, true, `${state} must allow creating`);
      // The history is still shown alongside it.
      assert.equal(v.existing?.number, 7);
      assert.equal(v.existing?.state, state);
    }
  });

  it("still blocks a second PR while one is open", () => {
    const v = prCardView({
      branch: "coder/x-abc",
      threadPrNumber: 7,
      threadPrUrl: merged.url,
      live: { ...merged, state: "OPEN" },
      titleDraft: "Another",
      busy: false,
    });
    assert.equal(v.showForm, false);
    assert.equal(v.canCreate, false);
  });

  it("does not offer a second PR before status has loaded", () => {
    // state is null until prStatus answers; that is unknown, not finished.
    const v = prCardView({
      branch: "coder/x-abc",
      threadPrNumber: 7,
      threadPrUrl: merged.url,
      live: undefined,
      titleDraft: "Another",
      busy: false,
    });
    assert.equal(v.existing?.state, null);
    assert.equal(v.showForm, false, "unknown state must not invite a new PR");
  });
});

describe("formatChecksRollup", () => {
  const checks: PrCheckInfo[] = [
    { name: "test", bucket: "pass" },
    { name: "lint", bucket: "pass" },
    { name: "types", bucket: "pass" },
    { name: "e2e", bucket: "fail" },
  ];

  it("renders only nonzero buckets", () => {
    const { line } = formatChecksRollup(checks);
    assert.equal(line, "Checks: 3 passing · 1 failing");
  });

  it("lists every check in the tooltip", () => {
    const { tooltip } = formatChecksRollup(checks);
    assert.equal(tooltip, "test: pass\nlint: pass\ntypes: pass\ne2e: fail");
  });

  it("hides the line when there are no checks", () => {
    const { line, tooltip } = formatChecksRollup([]);
    assert.equal(line, null);
    assert.equal(tooltip, "");
  });

  it("includes pending without inventing empty buckets", () => {
    const { line } = formatChecksRollup([
      { name: "ci", bucket: "pending" },
      { name: "old", bucket: "cancel" },
    ]);
    assert.equal(line, "Checks: 1 pending · 1 cancelled");
  });
});
