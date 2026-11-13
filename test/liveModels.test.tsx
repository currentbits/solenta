/**
 * The composer model picker asks the provider's API for new models when it
 * opens, at most once per provider per LIVE_MODELS_TTL_MS, and appends the
 * ids the snapshot list lacks.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import {
  createFakeCoder,
  detail,
  installFakeCoder,
  project,
  thread,
} from "./support/fakeCoder.ts";
import App from "../src/App";
import { withLiveModels } from "../src/liveModels";
import type { ProviderInfo } from "../src/shared/ipc";

const claude: ProviderInfo = {
  id: "claude",
  name: "Claude Code",
  available: true,
  supportsResume: true,
  models: ["claude-opus-5"],
  modelInfo: [
    { id: "claude-opus-5", label: "Opus", description: "Known", vendor: "Anthropic" },
  ],
  efforts: [],
};

describe("withLiveModels", () => {
  it("appends unknown chat models and keeps known rows as they were", () => {
    const [p] = withLiveModels([claude], {
      claude: [
        { id: "claude-opus-5", label: "Claude Opus 5 (API name)" },
        { id: "claude-new-6", label: "Claude New 6", contextTokens: 200000 },
        { id: "text-embedding-3-small", label: "embeddings" },
      ],
    });
    assert.deepEqual(
      p!.modelInfo.map((m) => [m.id, m.label]),
      [
        ["claude-opus-5", "Opus"],
        ["claude-new-6", "Claude New 6"],
      ],
    );
    assert.equal(p!.modelInfo[1]!.contextTokens, 200000);
  });

  it("extends the bare id list when a provider has no modelInfo", () => {
    const bare = { ...claude, id: "x", models: ["a"], modelInfo: [] };
    const [p] = withLiveModels([bare], { x: [{ id: "a", label: "a" }, { id: "b", label: "b" }] });
    assert.deepEqual(p!.models, ["a", "b"]);
  });

  it("returns the same objects when nothing was fetched", () => {
    const list = [claude];
    assert.equal(withLiveModels(list, {}), list);
    assert.equal(withLiveModels(list, { claude: [] })[0], claude);
  });
});

describe("model picker live refresh", () => {
  it("fetches the current provider's models on open, merges them, and throttles", async () => {
    const t = thread({ id: "t1", title: "target", provider: "claude" });
    const fake = createFakeCoder({
      projects: [project({ id: "p1" })],
      threads: [t],
      details: { t1: detail({ thread: t }) },
      providers: [claude],
      fetchedModels: [{ id: "claude-new-6", label: "Claude New 6" }],
    });
    const shell = await mount(<div />);
    installFakeCoder(fake);
    shell.unmount();
    const m = await mount(<App />);
    try {
      await m.flush();
      await m.click(m.query('[data-thread-card="t1"]'));
      await m.flush();
      const trigger = () => m.query('button[aria-label^="Model:"]') as HTMLElement;
      await m.click(trigger());
      await m.flush();
      assert.deepEqual(
        fake.of("providers.fetchModels").map((c) => c.args[0]),
        [{ provider: "claude" }],
      );
      const list = m.query('[role="listbox"][aria-label="Model"]');
      assert.match(list?.textContent ?? "", /Claude New 6/, "fetched model merged into the open list");
      assert.match(list?.textContent ?? "", /Opus/, "snapshot rows stay");

      // Close and reopen inside the throttle window: no second fetch.
      await m.click(trigger());
      await m.flush();
      await m.click(trigger());
      await m.flush();
      assert.equal(fake.of("providers.fetchModels").length, 1);
    } finally {
      m.unmount();
    }
  });
});
