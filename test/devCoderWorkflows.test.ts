/**
 * Dev-mode workflows.list / save / remove.
 * Run: node --experimental-strip-types --test test/devCoderWorkflows.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDevCoder } from "../src/devCoder.ts";
import type { WorkflowPhaseSpec, WorkflowTemplateInfo } from "../src/shared/ipc.ts";

function phase(
  overrides: Partial<WorkflowPhaseSpec> & Pick<WorkflowPhaseSpec, "name">,
): WorkflowPhaseSpec {
  return {
    agentCount: 1,
    instruction: "Do the work",
    provider: "claude",
    model: null,
    ...overrides,
  };
}

describe("workflows.list", () => {
  it("seeds the standard builtin with seed/analyze/synthesize", async () => {
    const api = createDevCoder();
    const list = await api.workflows.list();
    assert.ok(list.length >= 1);
    const standard = list.find((t) => t.id === "standard");
    assert.ok(standard, "standard template present");
    assert.equal(standard!.builtin, true);
    assert.equal(standard!.name, "Standard");
    assert.deepEqual(
      standard!.phases.map((p) => ({
        name: p.name,
        agentCount: p.agentCount,
      })),
      [
        { name: "seed", agentCount: 1 },
        { name: "analyze", agentCount: 2 },
        { name: "synthesize", agentCount: 1 },
      ],
    );
    for (const p of standard!.phases) {
      assert.ok(p.instruction.trim().length > 0);
      assert.equal(p.provider, "claude");
    }
  });
});

describe("workflows.save", () => {
  it("creates a new template when id is omitted", async () => {
    const api = createDevCoder();
    const saved = await api.workflows.save({
      name: "Fast",
      phases: [phase({ name: "go", agentCount: 2 })],
    });
    assert.ok(saved.id);
    assert.notEqual(saved.id, "standard");
    assert.equal(saved.builtin, false);
    assert.equal(saved.name, "Fast");
    assert.equal(saved.phases[0]!.agentCount, 2);

    const list = await api.workflows.list();
    assert.ok(list.some((t) => t.id === saved.id));
  });

  it("updates a non-builtin template in place", async () => {
    const api = createDevCoder();
    const created = await api.workflows.save({
      name: "Draft",
      phases: [phase({ name: "a" })],
    });
    const updated = await api.workflows.save({
      id: created.id,
      name: "Draft v2",
      phases: [
        phase({ name: "a", agentCount: 2 }),
        phase({ name: "b", agentCount: 1 }),
      ],
    });
    assert.equal(updated.id, created.id);
    assert.equal(updated.builtin, false);
    assert.equal(updated.name, "Draft v2");
    assert.equal(updated.phases.length, 2);

    const list = await api.workflows.list();
    const row = list.find((t) => t.id === created.id)!;
    assert.equal(row.name, "Draft v2");
    assert.equal(row.phases.length, 2);
  });

  it("saving a builtin with a new name creates a copy keeping that name", async () => {
    const api = createDevCoder();
    const listBefore = await api.workflows.list();
    const standard = listBefore.find((t) => t.id === "standard")!;
    const copy = await api.workflows.save({
      id: standard.id,
      name: "My Standard",
      phases: standard.phases.map((p) => ({ ...p })),
    });
    assert.notEqual(copy.id, "standard");
    assert.equal(copy.builtin, false);
    assert.equal(copy.name, "My Standard");

    const list = await api.workflows.list();
    const stillBuiltin = list.find((t) => t.id === "standard");
    assert.ok(stillBuiltin);
    assert.equal(stillBuiltin!.builtin, true);
    assert.ok(list.some((t) => t.id === copy.id && t.builtin === false));
  });

  it("saving a builtin with the same name appends (copy)", async () => {
    const api = createDevCoder();
    const standard = (await api.workflows.list()).find(
      (t) => t.id === "standard",
    )!;
    const copy = await api.workflows.save({
      id: standard.id,
      name: standard.name,
      phases: standard.phases.map((p) => ({ ...p })),
    });
    assert.notEqual(copy.id, "standard");
    assert.equal(copy.builtin, false);
    assert.equal(copy.name, "Standard (copy)");
  });

  it("rejects 0 phases", async () => {
    const api = createDevCoder();
    await assert.rejects(
      () => api.workflows.save({ name: "Empty", phases: [] }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(
          err.message,
          "Template must have between 1 and 6 phases",
        );
        return true;
      },
    );
  });

  it("rejects more than 6 phases", async () => {
    const api = createDevCoder();
    const phases = Array.from({ length: 7 }, (_, i) =>
      phase({ name: `p${i}` }),
    );
    await assert.rejects(
      () => api.workflows.save({ name: "Too many", phases }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(
          err.message,
          "Template must have between 1 and 6 phases",
        );
        return true;
      },
    );
  });

  it("rejects agentCount outside 1-4", async () => {
    const api = createDevCoder();
    await assert.rejects(
      () =>
        api.workflows.save({
          name: "Bad count",
          phases: [phase({ name: "a", agentCount: 5 })],
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(
          err.message,
          'Phase "a": agentCount must be an integer from 1 to 4',
        );
        return true;
      },
    );
    await assert.rejects(
      () =>
        api.workflows.save({
          name: "Zero count",
          phases: [phase({ name: "a", agentCount: 0 })],
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(
          err.message,
          'Phase "a": agentCount must be an integer from 1 to 4',
        );
        return true;
      },
    );
  });

  it("rejects empty instruction", async () => {
    const api = createDevCoder();
    await assert.rejects(
      () =>
        api.workflows.save({
          name: "No instruction",
          phases: [phase({ name: "a", instruction: "   " })],
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(
          err.message,
          'Phase "a": instruction is required',
        );
        return true;
      },
    );
  });

  it("rejects unknown provider", async () => {
    const api = createDevCoder();
    await assert.rejects(
      () =>
        api.workflows.save({
          name: "Bad provider",
          phases: [phase({ name: "a", provider: "nope" })],
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(
          err.message,
          'Phase "a": unknown provider "nope"',
        );
        return true;
      },
    );
  });

  it("rejects model not in provider list", async () => {
    const api = createDevCoder();
    await assert.rejects(
      () =>
        api.workflows.save({
          name: "Bad model",
          phases: [
            phase({
              name: "a",
              provider: "claude",
              model: "not-a-real-model",
            }),
          ],
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(
          err.message,
          'Phase "a": model "not-a-real-model" is not in provider claude\'s model list',
        );
        return true;
      },
    );
  });

  it("allows null model and unavailable-but-known providers", async () => {
    const api = createDevCoder();
    const saved = await api.workflows.save({
      name: "Grok phase",
      phases: [phase({ name: "a", provider: "grok", model: null })],
    });
    assert.equal(saved.phases[0]!.provider, "grok");
    assert.equal(saved.phases[0]!.model, null);
  });

  it("rejects empty template name with electron wording", async () => {
    const api = createDevCoder();
    await assert.rejects(
      () =>
        api.workflows.save({
          name: "  ",
          phases: [phase({ name: "a" })],
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, "Template name is required");
        return true;
      },
    );
  });

  it("rejects empty phase name with electron wording", async () => {
    const api = createDevCoder();
    await assert.rejects(
      () =>
        api.workflows.save({
          name: "X",
          phases: [phase({ name: "  " })],
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, "Phase 1: name is required");
        return true;
      },
    );
  });
});

describe("workflows.remove", () => {
  it("removes a non-builtin template", async () => {
    const api = createDevCoder();
    const created = await api.workflows.save({
      name: "Temp",
      phases: [phase({ name: "a" })],
    });
    await api.workflows.remove({ id: created.id });
    const list = await api.workflows.list();
    assert.ok(!list.some((t) => t.id === created.id));
  });

  it("rejects removing a builtin", async () => {
    const api = createDevCoder();
    await assert.rejects(
      () => api.workflows.remove({ id: "standard" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(
          err.message,
          "Cannot remove builtin template: standard",
        );
        return true;
      },
    );
    const list = await api.workflows.list();
    assert.ok(list.some((t) => t.id === "standard"));
  });

  it("rejects unknown id", async () => {
    const api = createDevCoder();
    await assert.rejects(
      () => api.workflows.remove({ id: "missing-template" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, "Unknown template: missing-template");
        return true;
      },
    );
  });
});

describe("workflows round-trip shape", () => {
  it("list entries match WorkflowTemplateInfo", async () => {
    const api = createDevCoder();
    const list: WorkflowTemplateInfo[] = await api.workflows.list();
    for (const t of list) {
      assert.equal(typeof t.id, "string");
      assert.equal(typeof t.name, "string");
      assert.equal(typeof t.builtin, "boolean");
      assert.ok(Array.isArray(t.phases));
      for (const p of t.phases) {
        assert.equal(typeof p.name, "string");
        assert.equal(typeof p.agentCount, "number");
        assert.equal(typeof p.instruction, "string");
        assert.equal(typeof p.provider, "string");
        assert.ok(p.model === null || typeof p.model === "string");
      }
    }
  });
});
