/**
 * PR hover card (#1771): hovering a PR link/pill/ref shows title, state,
 * checks, review decision, +/- lines and author after a fetch delay, cached
 * ~60s and deduped, failing quietly when the fetch errors.
 *
 * Run: node --import=./test/support/render.mjs --experimental-strip-types --test test/prHoverCard.test.tsx
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { inAct, mount } from "./support/dom.ts";
import {
  clearPrHoverCache,
  PrHoverFetchContext,
  PrHoverTarget,
  type PrDetailFetcher,
} from "../src/components/PrHoverCard.tsx";
import type { PrDetailResult } from "../src/shared/ipc.ts";

const HOVER_WAIT_MS = 500;

function okResult(overrides: Partial<Extract<PrDetailResult, { ok: true }>["pr"]> = {}): PrDetailResult {
  return {
    ok: true,
    pr: {
      number: 482,
      title: "Ship the thing",
      body: "",
      url: "https://github.com/acme/demo/pull/482",
      state: "OPEN",
      isDraft: false,
      headRefName: "feat/ship",
      comments: [],
      ...overrides,
    },
  };
}

function hovered(fetchDetail: PrDetailFetcher, repo = "acme/demo", number = 482) {
  return (
    <PrHoverFetchContext.Provider value={fetchDetail}>
      <PrHoverTarget projectPath="/repo" repo={repo} number={number}>
        <a href="https://github.com/acme/demo/pull/482">PR #482</a>
      </PrHoverTarget>
    </PrHoverFetchContext.Provider>
  );
}

async function wait(ms: number) {
  await inAct(() => new Promise((r) => setTimeout(r, ms)));
}

describe("PrHoverTarget", () => {
  beforeEach(() => clearPrHoverCache());
  afterEach(() => clearPrHoverCache());

  it("shows the card after hovering, once the fetch resolves", async () => {
    let calls = 0;
    const fetchDetail: PrDetailFetcher = async () => {
      calls++;
      return okResult();
    };
    const m = await mount(hovered(fetchDetail));
    assert.equal(m.query('[data-pr-hover-card]'), null, "no card before hover");
    await m.hover(m.query("a"));
    await wait(HOVER_WAIT_MS);
    const card = m.query("[data-pr-hover-card]");
    assert.ok(card, "card shown after the hover delay");
    assert.match(card!.textContent || "", /Ship the thing/);
    assert.match(card!.textContent || "", /#482/);
    assert.equal(calls, 1);
  });

  it("closes on mouse-out", async () => {
    const fetchDetail: PrDetailFetcher = async () => okResult();
    const m = await mount(hovered(fetchDetail));
    const anchor = m.query("a");
    await m.hover(anchor);
    await wait(HOVER_WAIT_MS);
    assert.ok(m.query("[data-pr-hover-card]"));
    await inAct(() => {
      anchor!.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    });
    assert.equal(m.query("[data-pr-hover-card]"), null);
  });

  it("the cache prevents a second fetch for the same PR", async () => {
    let calls = 0;
    const fetchDetail: PrDetailFetcher = async () => {
      calls++;
      return okResult();
    };
    const a = await mount(hovered(fetchDetail));
    await a.hover(a.query("a"));
    await wait(HOVER_WAIT_MS);
    assert.equal(calls, 1);

    const b = await mount(hovered(fetchDetail));
    await b.hover(b.query("a"));
    await wait(HOVER_WAIT_MS);
    assert.equal(calls, 1, "second hover on the same PR reused the cache");
    assert.ok(b.query("[data-pr-hover-card]"), "cached result still renders");
  });

  it("fails quietly when the fetch rejects", async () => {
    const fetchDetail: PrDetailFetcher = async () => {
      throw new Error("boom");
    };
    const m = await mount(hovered(fetchDetail));
    await m.hover(m.query("a"));
    await wait(HOVER_WAIT_MS);
    assert.equal(m.query("[data-pr-hover-card]"), null, "no card on a failed fetch");
    // The underlying link/children are still there and unaffected.
    assert.match(m.text(), /PR #482/);
  });

  it("fails quietly when the IPC answers ok:false", async () => {
    const fetchDetail: PrDetailFetcher = async () => ({ ok: false, reason: "PR not found" });
    const m = await mount(hovered(fetchDetail));
    await m.hover(m.query("a"));
    await wait(HOVER_WAIT_MS);
    assert.equal(m.query("[data-pr-hover-card]"), null);
  });

  it("does not fetch before the hover delay elapses", async () => {
    let calls = 0;
    const fetchDetail: PrDetailFetcher = async () => {
      calls++;
      return okResult();
    };
    const m = await mount(hovered(fetchDetail));
    await m.hover(m.query("a"));
    // Well under the 400ms delay.
    await wait(100);
    assert.equal(calls, 0, "no fetch until the hover delay elapses");
    assert.equal(m.query("[data-pr-hover-card]"), null);
  });
});
