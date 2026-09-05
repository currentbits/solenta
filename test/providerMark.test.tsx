/**
 * Harness logos used on thread cards and next to provider names
 * (filter chips, picker, Best of N).
 *
 * Known ids render a currentColor SVG mark. Unknown ids fall back to the
 * first letter so a custom/future harness still has a glyph. decorative
 * hides the mark from AT when a sibling already names the harness.
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { ProviderMark } from "../src/components/ProviderMark";
import type { ProviderInfo } from "../src/shared/ipc";

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
  {
    id: "grok",
    name: "Grok",
    available: true,
    supportsResume: true,
    models: [],
    modelInfo: [],
    efforts: [],
  },
];

const KNOWN = [
  "claude",
  "codex",
  "grok",
  "cursor",
  "kimi",
  "opencode",
  "muse",
  "simulate",
] as const;

describe("ProviderMark", () => {
  for (const id of KNOWN) {
    it(`renders an SVG mark for ${id}`, async () => {
      const m = await mount(
        <ProviderMark providerId={id} providers={providers} />,
      );
      const el = m.query(`[data-provider-mark="${id}"]`);
      assert.ok(el, `mark for ${id}`);
      assert.ok(el!.querySelector("svg"), `${id} is a logo, not a name`);
      assert.equal((el!.textContent || "").trim(), "");
      m.unmount();
    });
  }

  it("uses the registry display name as the accessible label", async () => {
    const m = await mount(
      <ProviderMark providerId="claude" providers={providers} />,
    );
    const el = m.query('[data-provider-mark="claude"]');
    assert.equal(el?.getAttribute("aria-label"), "Claude Code");
    assert.equal(el?.getAttribute("title"), "Claude Code");
    assert.equal(el?.getAttribute("role"), "img");
    m.unmount();
  });

  it("falls back to a letter when the harness has no mark", async () => {
    const m = await mount(
      <ProviderMark providerId="acme" providers={providers} />,
    );
    const el = m.query('[data-provider-mark="acme"]');
    assert.ok(el);
    assert.equal(el!.querySelector("svg"), null);
    assert.equal((el!.textContent || "").trim(), "A");
    assert.equal(el!.getAttribute("aria-label"), "acme");
    m.unmount();
  });

  it("decorative marks stay silent next to a visible name", async () => {
    const m = await mount(
      <ProviderMark providerId="claude" providers={providers} decorative />,
    );
    const el = m.query('[data-provider-mark="claude"]');
    assert.equal(el?.getAttribute("aria-hidden"), "true");
    assert.equal(el?.getAttribute("aria-label"), null);
    assert.equal(el?.getAttribute("role"), null);
    m.unmount();
  });
});
