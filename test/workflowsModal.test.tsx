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
import { useState } from "react";
import { inAct, mount, unmountAll } from "./support/dom.ts";
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
    modelInfo: [],
    efforts: [],
  },
  {
    id: "codex",
    name: "Codex",
    available: true,
    supportsResume: false,
    models: [],
    modelInfo: [],
    efforts: [],
  },
  {
    id: "grok",
    name: "Grok",
    available: false,
    supportsResume: true,
    models: ["high"],
    modelInfo: [],
    efforts: [],
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
  initialDraft?: {
    name: string;
    phases: WorkflowPhaseSpec[];
  } | null;
}

function modal(stubs: Stubs = {}) {
  return (
    <WorkflowsModal
      open
      onClose={stubs.onClose ?? (() => {})}
      workflows={stubs.workflows ?? [workflow()]}
      providers={providers}
      initialSelectedId={stubs.initialSelectedId}
      initialDraft={stubs.initialDraft}
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

describe("WorkflowsModal distilled draft", () => {
  it("opens as a new template with the supplied name and phases", async () => {
    const m = await mount(
      modal({
        workflows: [workflow({ name: "Ship checklist" })],
        initialDraft: {
          name: "Distilled workflow",
          phases: [phase({ name: "replay", instruction: "Replay what worked" })],
        },
      }),
    );
    const values = m
      .queryAll("input")
      .map((el) => (el as HTMLInputElement).value);
    assert.ok(
      values.includes("Distilled workflow"),
      `name must come from the draft, got: ${JSON.stringify(values)}`,
    );
    assert.ok(
      values.includes("replay"),
      `phase name must come from the draft, got: ${JSON.stringify(values)}`,
    );
    assert.ok(
      m.text().includes("Phases (1/6)"),
      "draft must land as a new unsaved template",
    );
    m.unmount();
  });
});

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

function inputValues(m: { queryAll(sel: string): Element[] }): string[] {
  return m.queryAll("input").map((el) => (el as HTMLInputElement).value);
}

function closeCountOf(m: { query(sel: string): Element | null }): number {
  return Number(m.query("[data-close-count]")?.getAttribute("data-close-count"));
}

function LiveModal({
  workflows,
  onSave,
  onRemove,
  initialSelectedId = "a",
}: {
  workflows: WorkflowTemplateInfo[];
  onSave?: (t: WorkflowSaveInput) => Promise<WorkflowTemplateInfo>;
  onRemove?: (id: string) => Promise<void>;
  initialSelectedId?: string | null;
}) {
  const [open, setOpen] = useState(true);
  const [closeCount, setCloseCount] = useState(0);
  return (
    <>
      <button type="button" data-parent-close="" onClick={() => setOpen(false)}>
        parent-close
      </button>
      <button type="button" data-parent-open="" onClick={() => setOpen(true)}>
        parent-open
      </button>
      <span data-close-count={String(closeCount)} />
      <WorkflowsModal
        open={open}
        onClose={() => {
          setCloseCount((n) => n + 1);
          setOpen(false);
        }}
        workflows={workflows}
        providers={providers}
        initialSelectedId={initialSelectedId}
        onSave={
          onSave ??
          (async (t) =>
            workflow({
              id: t.id ?? "wf-new",
              name: t.name,
              phases: t.phases,
              builtin: false,
            }))
        }
        onRemove={onRemove ?? (async () => {})}
      />
    </>
  );
}

async function mousedownBackdrop(m: {
  query(sel: string): Element | null;
}): Promise<void> {
  const backdrop = m.query('[role="presentation"]');
  if (!backdrop) throw new Error("backdrop not found");
  await inAct(() => {
    backdrop.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );
  });
}

describe("WorkflowsModal dirty drafts", () => {
  it("keeps a dirty name after A → B → A", async () => {
    const a = workflow({
      id: "a",
      name: "Alpha",
      phases: [phase({ name: "a1" })],
    });
    const b = workflow({
      id: "b",
      name: "Beta",
      phases: [phase({ name: "b1" })],
    });
    const m = await mount(
      modal({ workflows: [a, b], initialSelectedId: "a" }),
    );
    await m.type(m.query("#wf-name"), "Alpha edited");
    await m.click(m.byText("Beta"));
    assert.ok(
      inputValues(m).includes("b1"),
      `selecting Beta must load it, got: ${JSON.stringify(inputValues(m))}`,
    );
    await m.click(m.byText("Alpha"));
    assert.ok(
      inputValues(m).includes("Alpha edited"),
      `returning to Alpha must restore the dirty name, got: ${JSON.stringify(inputValues(m))}`,
    );
    m.unmount();
  });

  it("keeps a dirty instruction and phase name after A → B → A", async () => {
    const a = workflow({
      id: "a",
      name: "Alpha",
      phases: [phase({ name: "a1", instruction: "Do the analysis" })],
    });
    const b = workflow({
      id: "b",
      name: "Beta",
      phases: [phase({ name: "b1" })],
    });
    const m = await mount(
      modal({ workflows: [a, b], initialSelectedId: "a" }),
    );
    const phaseName = m
      .queryAll("input")
      .find((el) => (el as HTMLInputElement).value === "a1");
    assert.ok(phaseName, "phase name field must render");
    await m.type(phaseName, "a1 edited");
    await m.type(m.query("textarea"), "Analyze harder");
    await m.click(m.byText("Beta"));
    await m.click(m.byText("Alpha"));
    assert.ok(
      inputValues(m).includes("a1 edited"),
      `dirty phase name must survive A→B→A, got: ${JSON.stringify(inputValues(m))}`,
    );
    const instruction = m.query("textarea") as HTMLTextAreaElement | null;
    assert.equal(
      instruction?.value,
      "Analyze harder",
      "dirty instruction must survive A→B→A",
    );
    m.unmount();
  });

  it("keeps a dirty new draft after New → A → New", async () => {
    const a = workflow({ id: "a", name: "Alpha" });
    const m = await mount(modal({ workflows: [a], initialSelectedId: "a" }));
    await m.click(m.byText("New workflow"));
    await m.type(m.query("#wf-name"), "Brand draft");
    await m.click(m.byText("Alpha"));
    await m.click(m.byText("New workflow"));
    assert.ok(
      inputValues(m).includes("Brand draft"),
      `returning to New must restore the dirty name, got: ${JSON.stringify(inputValues(m))}`,
    );
    m.unmount();
  });

  it("asks before closing a dirty editor; Keep editing stays and Discard closes", async () => {
    const closes: number[] = [];
    const m = await mount(
      modal({
        workflows: [workflow({ id: "a", name: "Alpha" })],
        initialSelectedId: "a",
        onClose: () => {
          closes.push(1);
        },
      }),
    );
    await m.type(m.query("#wf-name"), "Alpha edited");
    await m.click(m.byText("Cancel"));
    assert.equal(closes.length, 0, "dirty Cancel must not close immediately");
    assert.ok(m.byText("Keep editing"), "must offer to keep the draft");
    assert.ok(m.byText("Discard"), "must offer an explicit discard");
    await m.click(m.byText("Keep editing"));
    assert.equal(closes.length, 0, "Keep editing must stay on the draft");
    assert.ok(
      inputValues(m).includes("Alpha edited"),
      "Keep editing must leave the dirty name in place",
    );
    await m.click(m.byText("Cancel"));
    await m.click(m.byText("Discard"));
    assert.equal(closes.length, 1, "Discard must close after an explicit choice");
    m.unmount();
  });

  it("does not restore a discarded draft when the modal reopens", async () => {
    const m = await mount(
      <LiveModal workflows={[workflow({ id: "a", name: "Alpha" })]} />,
    );
    await m.type(m.query("#wf-name"), "Alpha edited");
    await m.click(m.byText("Cancel"));
    await m.click(m.byText("Discard"));
    await m.click(m.query("[data-parent-open]"));
    assert.ok(
      inputValues(m).includes("Alpha"),
      `reopen after discard must load the saved name, got: ${JSON.stringify(inputValues(m))}`,
    );
    assert.equal(
      inputValues(m).includes("Alpha edited"),
      false,
      "an explicit discard must not come back on the next open",
    );
    m.unmount();
  });
});

describe("WorkflowsModal close and session lifetime", () => {
  it("header Close, Escape, backdrop and footer obey one pending and dirty policy", async () => {
    let finish!: (value: WorkflowTemplateInfo) => void;
    const a = workflow({ id: "a", name: "Alpha" });
    const m = await mount(
      <LiveModal
        workflows={[a]}
        onSave={() =>
          new Promise<WorkflowTemplateInfo>((resolve) => {
            finish = resolve;
          })
        }
      />,
    );
    await m.click(m.byText("Save"));
    assert.ok(m.byText("Saving…"), "save must be pending");

    await m.click(m.query('[aria-label="Close"]'));
    assert.equal(closeCountOf(m), 0, "header Close must not close while saving");
    await m.press(m.query('[aria-label="Close"]'), "Escape");
    assert.equal(closeCountOf(m), 0, "Escape must not close while saving");
    await mousedownBackdrop(m);
    assert.equal(closeCountOf(m), 0, "backdrop must not close while saving");
    const cancel = m.byText("Cancel") as HTMLButtonElement | null;
    assert.ok(cancel, "footer Cancel must remain");
    assert.equal(cancel.disabled, true, "footer Cancel must stay disabled while saving");

    await inAct(() => {
      finish(a);
    });
    await m.flush();

    await m.type(m.query("#wf-name"), "Alpha dirty");
    const dirtyTriggers = [
      async () => {
        await m.click(m.byText("Cancel"));
      },
      async () => {
        await m.click(m.query('[aria-label="Close"]'));
      },
      async () => {
        await m.press(m.query('[aria-label="Close"]'), "Escape");
      },
      async () => {
        await mousedownBackdrop(m);
      },
    ];
    for (const trigger of dirtyTriggers) {
      await trigger();
      assert.equal(
        closeCountOf(m),
        0,
        "dirty close must wait for an explicit discard",
      );
      assert.ok(m.byText("Keep editing"), "every close path must show discard");
      await m.click(m.byText("Keep editing"));
    }
    m.unmount();
  });

  it("a late save from a previous session does not replace a newer draft", async () => {
    let finish!: (value: WorkflowTemplateInfo) => void;
    const a = workflow({
      id: "a",
      name: "Alpha",
      phases: [phase({ name: "a1" })],
    });
    const b = workflow({
      id: "b",
      name: "Beta",
      phases: [phase({ name: "b1" })],
    });
    const savedA = workflow({
      id: "a",
      name: "Alpha saved",
      phases: [phase({ name: "a1" })],
    });
    const m = await mount(
      <LiveModal
        workflows={[a, b]}
        onSave={() =>
          new Promise<WorkflowTemplateInfo>((resolve) => {
            finish = resolve;
          })
        }
      />,
    );
    await m.click(m.byText("Save"));
    await m.click(m.query("[data-parent-close]"));
    await m.click(m.query("[data-parent-open]"));
    await m.click(m.byText("Beta"));
    await m.type(m.query("#wf-name"), "Beta draft");
    await inAct(() => {
      finish(savedA);
    });
    await m.flush();
    assert.ok(
      inputValues(m).includes("Beta draft"),
      `late save must not wipe B's draft, got: ${JSON.stringify(inputValues(m))}`,
    );
    assert.equal(
      inputValues(m).includes("Alpha saved"),
      false,
      "late save must not switch the editor to saved A",
    );
    m.unmount();
  });

  it("a failed save from a previous session does not replace a newer draft", async () => {
    let fail!: (err: Error) => void;
    const a = workflow({ id: "a", name: "Alpha" });
    const b = workflow({ id: "b", name: "Beta" });
    const m = await mount(
      <LiveModal
        workflows={[a, b]}
        onSave={() =>
          new Promise<WorkflowTemplateInfo>((_resolve, reject) => {
            fail = reject;
          })
        }
      />,
    );
    await m.click(m.byText("Save"));
    await m.click(m.query("[data-parent-close]"));
    await m.click(m.query("[data-parent-open]"));
    await m.click(m.byText("Beta"));
    await m.type(m.query("#wf-name"), "Beta draft");
    await inAct(() => {
      fail(new Error("host rejected Alpha"));
    });
    await m.flush();
    assert.ok(
      inputValues(m).includes("Beta draft"),
      `failed late save must not wipe B, got: ${JSON.stringify(inputValues(m))}`,
    );
    assert.equal(
      m.text().includes("host rejected Alpha"),
      false,
      "a stale save error must not land on a later editor session",
    );
    m.unmount();
  });

  it("a failed delete from a previous session does not replace a newer draft", async () => {
    let fail!: (err: Error) => void;
    const a = workflow({ id: "a", name: "Alpha" });
    const b = workflow({ id: "b", name: "Beta" });
    const m = await mount(
      <LiveModal
        workflows={[a, b]}
        onRemove={() =>
          new Promise<void>((_resolve, reject) => {
            fail = reject;
          })
        }
      />,
    );
    await m.click(m.byText("Delete"));
    await m.click(m.byText("Confirm delete"));
    await m.click(m.query("[data-parent-close]"));
    await m.click(m.query("[data-parent-open]"));
    await m.click(m.byText("Beta"));
    await m.type(m.query("#wf-name"), "Beta draft");
    await inAct(() => {
      fail(new Error("host rejected delete"));
    });
    await m.flush();
    assert.ok(
      inputValues(m).includes("Beta draft"),
      `failed late delete must not wipe B, got: ${JSON.stringify(inputValues(m))}`,
    );
    assert.equal(
      m.text().includes("host rejected delete"),
      false,
      "a stale delete error must not land on a later editor session",
    );
    m.unmount();
  });

  it("a late delete from a previous session does not replace a newer draft", async () => {
    let finish!: () => void;
    const a = workflow({ id: "a", name: "Alpha" });
    const b = workflow({ id: "b", name: "Beta" });
    const m = await mount(
      <LiveModal
        workflows={[a, b]}
        onRemove={() =>
          new Promise<void>((resolve) => {
            finish = resolve;
          })
        }
      />,
    );
    await m.click(m.byText("Delete"));
    await m.click(m.byText("Confirm delete"));
    await m.click(m.query("[data-parent-close]"));
    await m.click(m.query("[data-parent-open]"));
    await m.click(m.byText("Beta"));
    await m.type(m.query("#wf-name"), "Beta draft");
    await inAct(() => {
      finish();
    });
    await m.flush();
    assert.ok(
      inputValues(m).includes("Beta draft"),
      `late delete must not wipe B's draft, got: ${JSON.stringify(inputValues(m))}`,
    );
    m.unmount();
  });

  it("moves focus to the discard confirmation", async () => {
    const m = await mount(
      modal({
        workflows: [workflow({ id: "a", name: "Alpha" })],
        initialSelectedId: "a",
      }),
    );
    await m.type(m.query("#wf-name"), "Alpha edited");
    await m.click(m.byText("Cancel"));
    const keep = m.byText("Keep editing") as HTMLElement | null;
    assert.ok(keep, "discard confirmation must render");
    assert.equal(
      document.activeElement,
      keep,
      "Keep editing must take focus so discard is keyboard-reachable",
    );
    m.unmount();
  });

  it("saving a builtin still sends the source id so copy-on-save works", async () => {
    const calls: WorkflowSaveInput[] = [];
    const built = workflow({
      id: "built",
      name: "Builtin ship",
      builtin: true,
    });
    const m = await mount(
      modal({
        workflows: [built],
        initialSelectedId: "built",
        onSave: async (t) => {
          calls.push(t);
          return workflow({
            id: "copy-1",
            name: t.name,
            phases: t.phases,
            builtin: false,
          });
        },
      }),
    );
    await m.click(m.byText("Save"));
    assert.equal(calls.length, 1, "save must call onSave");
    assert.equal(
      calls[0]?.id,
      "built",
      "builtin save must send the source id so the host can copy",
    );
    assert.ok(
      inputValues(m).includes("Builtin ship"),
      "editor must show the saved copy",
    );
    m.unmount();
  });
});
