import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  allLinkedPrsSettled,
  anyLinkedPrOpen,
  normalizePrLinks,
  upsertPrLink,
} from "../src/prLinks.ts";

describe("normalizePrLinks", () => {
  it("falls back to the legacy prNumber row", () => {
    assert.deepEqual(
      normalizePrLinks({
        prNumber: 12,
        prUrl: "https://github.com/acme/app/pull/12",
        prState: "OPEN",
      }),
      [
        {
          number: 12,
          url: "https://github.com/acme/app/pull/12",
          state: "OPEN",
        },
      ],
    );
  });

  it("keeps extra PRs including another repo and does not duplicate primary", () => {
    const links = normalizePrLinks({
      prNumber: 12,
      prUrl: "https://github.com/acme/app/pull/12",
      prState: "OPEN",
      prLinks: [
        { number: 12, url: "https://github.com/acme/app/pull/12", state: "OPEN" },
        { number: 4, repo: "acme/other", url: "https://github.com/acme/other/pull/4" },
      ],
    });
    assert.equal(links.length, 2);
    assert.equal(links[0]!.number, 12);
    assert.equal(links[1]!.repo, "acme/other");
  });
});

describe("upsertPrLink", () => {
  it("replaces the same repo+number and appends a new one", () => {
    const once = upsertPrLink([], { number: 3, state: "OPEN" });
    const twice = upsertPrLink(once, { number: 3, state: "MERGED", url: "https://x/3" });
    assert.equal(twice.length, 1);
    assert.equal(twice[0]!.state, "MERGED");
    assert.equal(upsertPrLink(twice, { number: 9 }).length, 2);
  });
});

describe("linked PR settle", () => {
  it("settles only when every link is terminal", () => {
    assert.equal(
      allLinkedPrsSettled([
        { number: 1, state: "MERGED" },
        { number: 2, state: "CLOSED" },
      ]),
      true,
    );
    assert.equal(
      allLinkedPrsSettled([
        { number: 1, state: "MERGED" },
        { number: 2, state: "OPEN" },
      ]),
      false,
    );
    assert.equal(
      allLinkedPrsSettled([{ number: 1, state: "MERGED" }], false),
      false,
    );
    assert.equal(anyLinkedPrOpen([{ number: 1, state: "OPEN" }]), true);
    assert.equal(allLinkedPrsSettled([]), false);
  });
});
