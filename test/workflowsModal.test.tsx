/**
 * WorkflowsModal, mounted for real: effects run, clicks fire, state advances.
 *
 * WorkflowsModal had ZERO render coverage. Creating/deleting templates and
 * mixed-provider phases are product differentiators; a silent mislabel or a
 * dead create path would ship green without a render test.
 *
 * Run: node --import=./test/support/render.mjs --test test/workflowsModal.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { mount, unmountAll } from "./support/dom.ts";
import { WorkflowsModal } from "../src/components/WorkflowsModal";
import type {
  ProviderInfo,
  WorkflowPhaseSpec,
  WorkflowTemplateInfo,
} from "../src/shared/ipc";
import type { WorkflowSaveInput } from "../src/useCoder";

const providers: ProviderInfo[] = [
  {
    id: "claude",
    name: "Claude Code",
    available: true,
    supportsResume: true,
    models: ["opus", "sonnet"],
  },
  {
    id: "codex",
    name: "Codex",
    available: true,
    supportsResume: false,
    models: [],
  },
  {
    id: "grok",
    name: "Grok",
    available: false,
    supportsResume: true,
    models: ["high"],
  },
];

function phase(over: Partial<WorkflowPhaseSpec> = {}): WorkflowPhaseSpec {
  return {
    name: "analyze",
    agentCount: 1,
    instruction: "Do the analysis",
    provider: "claude",
    model: null,
    ...over,
  };
}

function workflow(
  over: Partial<WorkflowTemplateInfo> = {},
): WorkflowTemplateInfo {
  return {
    id: "wf-1",
    name: "Ship checklist",
    builtin: false,
    phases: [phase()],
    ...over,
  };
}

interface Stubs {
  workflows?: WorkflowTemplateInfo[];
  onSave?: (t: WorkflowSaveInput) => Promise<WorkflowTemplateInfo>;
  onRemove?: (id: string) => Promise<void>;
  onClose?: () => void;
  initialSelectedId?: string | null;
}

function modal(stubs: Stubs = {}) {
  return (
    <WorkflowsModal
      open
      onClose={stubs.onClose ?? (() => {})}
      workflows={stubs.workflows ?? [workflow()]}
      providers={providers}
      initialSelectedId={stubs.initialSelectedId}
      onSave={
        stubs.onSave ??
        (async (t) =>
          workflow({
            id: t.id ?? "wf-new",
            name: t.name,
            phases: t.phases,
            builtin: false,
          }))
      }
      onRemove={stubs.onRemove ?? (async () => {})}
    />
  );
}

afterEach(unmountAll);

describe("WorkflowsModal list", () => {
  it("renders the workflows it was given, with their phases", async () => {
    const mixed = workflow({
      id: "wf-mixed",
      name: "Mixed providers",
      phases: [
        phase({ name: "seed", provider: "claude" }),
        phase({ name: "review", provider: "codex" }),
      ],
    });
    const m = await mount(
      modal({
        workflows: [mixed, workflow({ id: "wf-2", name: "Solo path" })],
      }),
    );
    assert.ok(
      m.text().includes("Mixed providers"),
      "list must show the first template name",
    );
    assert.ok(
      m.text().includes("Solo path"),
      "list must show the second template name",
    );
    // Phase names live in controlled <input value=...>, not textContent.
    const phaseNameValues = m
      .queryAll("input")
      .map((el) => (el as HTMLInputElement).value);
    assert.ok(
      phaseNameValues.includes("seed"),
      `phase names must render as input values, got: ${JSON.stringify(phaseNameValues)}`,
    );
    assert.ok(
      phaseNameValues.includes("review"),
      `second phase name must render, got: ${JSON.stringify(phaseNameValues)}`,
    );
    assert.ok(
      m.text().includes("Phases (2/6)"),
      `phase count must show, got: ${m.text().slice(0, 200)}`,
    );
    m.unmount();
  });

  it("shows an empty list state when there are no workflows", async () => {
    const m = await mount(modal({ workflows: [] }));
    // No template rows for known names; the empty open path starts a new draft.
    assert.ok(
      m.byText("New workflow"),
      "empty open must offer creating a workflow",
    );
    // No pre-existing template names from the list.
    assert.equal(
      m.text().includes("Ship checklist"),
      false,
      "empty list must not invent prior templates",
    );
    m.unmount();
  });
});

describe("WorkflowsModal create / select / delete", () => {
  it("selecting a workflow loads it into the editor", async () => {
    const a = workflow({ id: "a", name: "Alpha", phases: [phase({ name: "a1" })] });
    const b = workflow({
      id: "b",
      name: "Beta",
      phases: [phase({ name: "b1", provider: "codex" })],
    });
    const m = await mount(
      modal({ workflows: [a, b], initialSelectedId: "a" }),
    );
    const valuesOf = () =>
      m.queryAll("input").map((el) => (el as HTMLInputElement).value);
    assert.ok(
      valuesOf().includes("a1"),
      `initial selection must load Alpha phase, got: ${JSON.stringify(valuesOf())}`,
    );
    await m.click(m.byText("Beta"));
    assert.ok(
      valuesOf().includes("b1"),
      `selecting Beta must load its phase, got: ${JSON.stringify(valuesOf())}`,
    );
    // Provider select for the selected phase should show codex selected.
    const selects = m.queryAll("select") as HTMLSelectElement[];
    const providerSelect = selects.find((s) =>
      Array.from(s.options).some((o) => o.value === "codex"),
    );
    assert.ok(providerSelect, "provider select must exist");
    assert.equal(
      providerSelect.value,
      "codex",
      "selected workflow phase provider must match the template",
    );
    m.unmount();
  });

  it("creating a new workflow reports through onSave with no id", async () => {
    const calls: WorkflowSaveInput[] = [];
    const m = await mount(
      modal({
        workflows: [workflow()],
        onSave: async (t) => {
          calls.push(t);
          return workflow({
            id: "created-1",
            name: t.name,
            phases: t.phases,
          });
        },
      }),
    );
    await m.click(m.byText("New workflow"));
    const name = m.query("#wf-name");
    assert.ok(name, "name field must render for a new draft");
    await m.type(name, "Brand new plan");
    await m.click(m.byText("Save"));
    assert.equal(calls.length, 1, "save must call onSave once");
    assert.equal(calls[0].name, "Brand new plan");
    assert.equal(
      calls[0].id,
      undefined,
      "a brand-new workflow must not send an id",
    );
    assert.ok(
      Array.isArray(calls[0].phases) && calls[0].phases.length >= 1,
      "save must include phases",
    );
    m.unmount();
  });

  it("deleting asks first, then calls onRemove with the selected id", async () => {
    const removed: string[] = [];
    const m = await mount(
      modal({
        workflows: [
          workflow({ id: "kill-me", name: "Disposable", builtin: false }),
        ],
        onRemove: async (id) => {
          removed.push(id);
        },
      }),
    );
    const del = m.byText("Delete");
    assert.ok(del, "Delete must be available for a non-builtin");
    await m.click(del);
    assert.equal(removed.length, 0, "first click must only arm confirm");
    assert.ok(
      m.byText("Confirm delete"),
      "second-step confirm label must appear",
    );
    await m.click(m.byText("Confirm delete"));
    assert.deepEqual(removed, ["kill-me"]);
    m.unmount();
  });

  it("refuses to delete a builtin template", async () => {
    const removed: string[] = [];
    const m = await mount(
      modal({
        workflows: [
          workflow({
            id: "built",
            name: "Builtin ship",
            builtin: true,
          }),
        ],
        onRemove: async (id) => {
          removed.push(id);
        },
      }),
    );
    const del = m.byText("Builtin (locked)") as HTMLButtonElement | null;
    assert.ok(del, "builtin delete control must show locked label");
    assert.equal(del.disabled, true, "builtin delete must be disabled");
    assert.equal(removed.length, 0);
    m.unmount();
  });
});

describe("WorkflowsModal mixed providers", () => {
  it("renders each phase's provider correctly across mixed providers", async () => {
    const mixed = workflow({
      id: "mix",
      name: "Cross-provider",
      phases: [
        phase({ name: "seed", provider: "claude", model: "sonnet" }),
        phase({ name: "verify", provider: "codex", model: null }),
        phase({ name: "polish", provider: "grok", model: "high" }),
      ],
    });
    const m = await mount(modal({ workflows: [mixed] }));
    const selects = m.queryAll("select") as HTMLSelectElement[];
    // Provider selects: one per phase. Model selects only when models exist.
    const providerValues = selects
      .filter((s) =>
        Array.from(s.options).some((o) => o.value === "claude"),
      )
      .map((s) => s.value);
    assert.deepEqual(
      providerValues,
      ["claude", "codex", "grok"],
      `each phase must keep its own provider, got ${JSON.stringify(providerValues)}`,
    );
    // Unavailable provider is still listed with a marker, not silently dropped.
    assert.ok(
      m.html().includes("not installed"),
      "unavailable provider must be labeled, not hidden",
    );
    m.unmount();
  });
});

describe("WorkflowsModal structure", () => {
  it("never nests interactive elements", async () => {
    const m = await mount(
      modal({
        workflows: [
          workflow({
            phases: [
              phase({ provider: "claude" }),
              phase({ name: "b", provider: "codex" }),
            ],
          }),
        ],
      }),
    );
    const interactives = m.queryAll("button, a");
    // Cardinality guard: a for-loop over an empty collection asserts nothing,
    // so without this the test passes hardest when the component renders null.
    assert.ok(
      interactives.length >= 2,
      `expected interactive elements to check, got ${interactives.length}`,
    );
    for (const el of interactives) {
      assert.equal(
        el.querySelector("button, a, input, textarea, select"),
        null,
        `interactive element nested inside <${el.tagName.toLowerCase()}>`,
      );
    }
    m.unmount();
  });

  it("renders nothing when closed", async () => {
    const m = await mount(
      <WorkflowsModal
        open={false}
        onClose={() => {}}
        workflows={[workflow()]}
        providers={providers}
        onSave={async (t) =>
          workflow({ id: "x", name: t.name, phases: t.phases })
        }
        onRemove={async () => {}}
      />,
    );
    assert.equal(m.html().trim(), "", "closed modal must render null");
    m.unmount();
  });
});
