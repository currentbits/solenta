import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createWorkflow,
  tick,
  markAgentFailed,
  TOKENS_PER_TICK,
} from "../src/engine.js";
import {
  serializeWorkflow,
  deserializeWorkflow,
} from "../src/serialize.js";
import type { Workflow } from "../src/types.js";

function sampleWorkflow(): Workflow {
  return createWorkflow({
    id: "wf-ser",
    name: "INTEGER-SAFARI",
    phases: [
      { name: "seed", agentCount: 1 },
      { name: "analyze", agentCount: 2, pipelined: true },
      { name: "verify", agentCount: 1 },
    ],
  });
}

describe("serializeWorkflow / deserializeWorkflow", () => {
  it("round-trips a fresh workflow preserving structure", () => {
    const wf = sampleWorkflow();
    const json = serializeWorkflow(wf);
    assert.equal(typeof json, "string");
    const restored = deserializeWorkflow(json);
    assert.deepEqual(restored, wf);
  });

  it("round-trip preserves engine behavior: tick(deserialize(serialize(wf))) deep-equals tick(wf)", () => {
    let wf = sampleWorkflow();
    wf = tick(wf);
    wf = tick(wf);
    // Partial progress with tokens and ticksRunning
    assert.ok(
      wf.phases.some((p) => p.agents.some((a) => a.status === "running")),
    );

    const restored = deserializeWorkflow(serializeWorkflow(wf));
    assert.deepEqual(tick(restored), tick(wf));
  });

  it("round-trip after markAgentFailed preserves failed state and further ticks", () => {
    let wf = sampleWorkflow();
    wf = tick(wf);
    const agentId = wf.phases[0]!.agents[0]!.id;
    wf = markAgentFailed(wf, agentId);

    const restored = deserializeWorkflow(serializeWorkflow(wf));
    assert.deepEqual(restored, wf);
    assert.deepEqual(tick(restored), tick(wf));
  });

  it("produces JSON-safe plain data (JSON.parse succeeds)", () => {
    const wf = sampleWorkflow();
    const json = serializeWorkflow(wf);
    const parsed = JSON.parse(json);
    assert.equal(parsed.id, "wf-ser");
    assert.equal(parsed.phases.length, 3);
    assert.equal(parsed.phases[1].pipelined, true);
  });

  it("throws descriptive Error on missing required fields", () => {
    assert.throws(
      () => deserializeWorkflow(JSON.stringify({ name: "X", phases: [] })),
      /id|missing/i,
    );
    assert.throws(
      () => deserializeWorkflow(JSON.stringify({ id: "x", phases: [] })),
      /name|missing/i,
    );
    assert.throws(
      () => deserializeWorkflow(JSON.stringify({ id: "x", name: "X" })),
      /phases|missing/i,
    );
    assert.throws(
      () =>
        deserializeWorkflow(
          JSON.stringify({
            id: "x",
            name: "X",
            phases: [{ name: "seed" }],
          }),
        ),
      /agents|missing/i,
    );
  });

  it("throws descriptive Error on unknown status values", () => {
    const wf = sampleWorkflow();
    const obj = JSON.parse(serializeWorkflow(wf));
    obj.phases[0].agents[0].status = "flying";
    assert.throws(
      () => deserializeWorkflow(JSON.stringify(obj)),
      /status|flying|unknown/i,
    );
  });

  it("throws on malformed JSON / non-object root", () => {
    assert.throws(() => deserializeWorkflow("not-json"), /JSON|parse|malformed/i);
    assert.throws(() => deserializeWorkflow("null"), /object|malformed/i);
    assert.throws(() => deserializeWorkflow("[]"), /object|malformed/i);
  });

  it("throws on unknown phase name", () => {
    const wf = sampleWorkflow();
    const obj = JSON.parse(serializeWorkflow(wf));
    obj.phases[0].name = "deploy";
    assert.throws(
      () => deserializeWorkflow(JSON.stringify(obj)),
      /phase|deploy|unknown/i,
    );
  });

  it("rejects phases with zero agents (same invariant as createWorkflow)", () => {
    assert.throws(
      () =>
        deserializeWorkflow(
          JSON.stringify({
            id: "empty-agents",
            name: "BAD",
            phases: [{ name: "seed", agents: [] }],
          }),
        ),
      /agent|empty|at least one/i,
    );
  });

  it("rejects duplicate agent ids across the workflow", () => {
    const agent = {
      id: "dup:0",
      model: "sonnet-5",
      status: "pending",
      tokensUsed: 0,
    };
    assert.throws(
      () =>
        deserializeWorkflow(
          JSON.stringify({
            id: "dup-ids",
            name: "DUP",
            phases: [
              { name: "seed", agents: [agent] },
              { name: "analyze", agents: [{ ...agent }] },
            ],
          }),
        ),
      /duplicate.*id|agent id/i,
    );
  });

  it("preserves tokensUsed and ticksRunning through round-trip", () => {
    let wf = sampleWorkflow();
    wf = tick(wf);
    wf = tick(wf);
    const agent = wf.phases[0]!.agents[0]!;
    assert.ok(agent.tokensUsed >= TOKENS_PER_TICK || agent.status === "settled");

    const restored = deserializeWorkflow(serializeWorkflow(wf));
    assert.deepEqual(
      restored.phases[0]!.agents[0],
      wf.phases[0]!.agents[0],
    );
  });
});
