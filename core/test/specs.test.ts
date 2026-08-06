import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildStandardSpec, nameForSeed } from "../src/specs.js";
import { createWorkflow } from "../src/engine.js";

describe("buildStandardSpec", () => {
  it("returns the canonical 5-phase pipeline with expected agent counts", () => {
    const spec = buildStandardSpec("INTEGER-SAFARI");
    assert.equal(spec.name, "INTEGER-SAFARI");
    assert.ok(typeof spec.id === "string" && spec.id.length > 0);
    assert.equal(spec.phases.length, 5);

    const byName = Object.fromEntries(spec.phases.map((p) => [p.name, p]));
    assert.equal(byName.seed!.agentCount, 1);
    assert.equal(byName.analyze!.agentCount, 4);
    assert.equal(byName.verify!.agentCount, 4);
    assert.equal(byName.verify!.pipelined, true);
    assert.equal(byName.judge!.agentCount, 3);
    assert.equal(byName.synthesize!.agentCount, 1);

    // Phase order is fixed
    assert.deepEqual(
      spec.phases.map((p) => p.name),
      ["seed", "analyze", "verify", "judge", "synthesize"],
    );
  });

  it("defaults model to sonnet-5 and createWorkflow accepts the spec", () => {
    const spec = buildStandardSpec("TEST-NAME");
    for (const phase of spec.phases) {
      assert.equal(phase.model ?? "sonnet-5", "sonnet-5");
    }
    const wf = createWorkflow(spec);
    assert.equal(wf.name, "TEST-NAME");
    assert.equal(wf.phases.length, 5);
    assert.equal(
      wf.phases.reduce((n, p) => n + p.agents.length, 0),
      1 + 4 + 4 + 3 + 1,
    );
    for (const phase of wf.phases) {
      for (const agent of phase.agents) {
        assert.equal(agent.model, "sonnet-5");
      }
    }
  });

  it("uses distinct ids for different names", () => {
    const a = buildStandardSpec("ALPHA");
    const b = buildStandardSpec("BETA");
    assert.notEqual(a.id, b.id);
  });

  it("gives distinct workflow ids to two same-named specs", () => {
    const a = buildStandardSpec("INTEGER-SAFARI");
    const b = buildStandardSpec("INTEGER-SAFARI");
    assert.equal(a.name, b.name);
    assert.notEqual(a.id, b.id);

    const wa = createWorkflow(a);
    const wb = createWorkflow(b);
    assert.notEqual(wa.id, wb.id);
  });

  it("accepts an explicit id option that overrides auto-generation", () => {
    const spec = buildStandardSpec("CUSTOM", { id: "wf-pinned-42" });
    assert.equal(spec.id, "wf-pinned-42");
    assert.equal(spec.name, "CUSTOM");
  });
});

describe("nameForSeed", () => {
  it("returns ADJECTIVE-NOUN uppercase with a hyphen", () => {
    const name = nameForSeed(0);
    assert.match(name, /^[A-Z]+-[A-Z]+$/);
  });

  it("is deterministic for the same seed", () => {
    for (const seed of [0, 1, 7, 41, 100, 999]) {
      assert.equal(nameForSeed(seed), nameForSeed(seed));
    }
  });

  it("mostly differs across small consecutive seeds", () => {
    const names = new Set<string>();
    for (let s = 0; s < 24; s++) {
      names.add(nameForSeed(s));
    }
    // At least half of 24 small seeds should produce distinct names
    assert.ok(
      names.size >= 12,
      `expected diverse names, got ${names.size}: ${[...names].join(", ")}`,
    );
  });

  it("uses word lists large enough to cover variety (example shape like INTEGER-SAFARI)", () => {
    // Probe many seeds; we should see multiple distinct adjectives and nouns
    const left = new Set<string>();
    const right = new Set<string>();
    for (let s = 0; s < 200; s++) {
      const [adj, noun] = nameForSeed(s).split("-");
      left.add(adj!);
      right.add(noun!);
    }
    assert.ok(left.size >= 24, `adjectives list too small: ${left.size}`);
    assert.ok(right.size >= 24, `nouns list too small: ${right.size}`);
  });
});
