/**
 * #1138: a successful workflows.save must not be reported as a failed save
 * just because the follow-up workflows.list rejects. The editor has to adopt
 * the returned id; otherwise Retry Save mints a second template.
 *
 * Mounts the real WorkflowsModal on the real useCoder against an in-memory
 * host that matches Store.saveTemplate: a new UUID for each id-less save and
 * each builtin-copy save. list() can reject after an acknowledged write.
 *
 * Run: node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test test/workflowSaveRefresh.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { mount, unmountAll } from "./support/dom.ts";
import {
  createFakeCoder,
  installFakeCoder,
  type FakeCoder,
} from "./support/fakeCoder.ts";
import { useCoder, type WorkflowSaveInput } from "../src/useCoder";
import { WorkflowsModal } from "../src/components/WorkflowsModal";
import type {
  ProviderInfo,
  WorkflowPhaseSpec,
  WorkflowTemplateInfo,
} from "../src/shared/ipc";

afterEach(unmountAll);

const phase: WorkflowPhaseSpec = {
  name: "analyze",
  agentCount: 1,
  instruction: "Do the analysis",
  provider: "claude",
  model: null,
};

const builtin: WorkflowTemplateInfo = {
  id: "wf-builtin",
  name: "Ship checklist",
  builtin: true,
  phases: [phase],
};

function cloneTemplate(t: WorkflowTemplateInfo): WorkflowTemplateInfo {
  return { ...t, phases: t.phases.map((p) => ({ ...p })) };
}

/**
 * Production saveTemplate: id-less → new id; builtin id → new copy id;
 * existing user id → update in place.
 */
function saveInto(
  store: WorkflowTemplateInfo[],
  template: WorkflowSaveInput,
  nextId: () => string,
): WorkflowTemplateInfo {
  const name = template.name ?? "";
  const phases = (template.phases ?? []).map((p) => ({ ...p }));
  if (template.id == null || template.id === "") {
    const created = { id: nextId(), name, builtin: false, phases };
    store.push(created);
    return cloneTemplate(created);
  }
  const existing = store.find((row) => row.id === template.id);
  if (existing?.builtin) {
    const renamed = name.length > 0 && name !== existing.name;
    const copy = {
      id: nextId(),
      name: renamed ? name : `${existing.name} (copy)`,
      builtin: false,
      phases: phases.length > 0 ? phases : existing.phases.map((p) => ({ ...p })),
    };
    store.push(copy);
    return cloneTemplate(copy);
  }
  if (existing) {
    existing.name = name;
    existing.phases = phases;
    existing.builtin = false;
    return cloneTemplate(existing);
  }
  const created = { id: template.id, name, builtin: false, phases };
  store.push(created);
  return cloneTemplate(created);
}

function installMemoryWorkflows(
  fake: FakeCoder,
  seed: WorkflowTemplateInfo[],
) {
  const store = seed.map(cloneTemplate);
  let seq = 0;
  let listRejects = false;
  const record = (channel: string, args: unknown[]) => {
    fake.calls.push({ channel, args });
  };
  fake.api.workflows.list = async () => {
    record("workflows.list", []);
    if (listRejects) throw new Error("list unavailable");
    return store.map(cloneTemplate);
  };
  fake.api.workflows.save = async (template: WorkflowSaveInput) => {
    record("workflows.save", [template]);
    return saveInto(store, template, () => `wf-created-${++seq}`);
  };
  fake.api.workflows.remove = async (input: { id: string }) => {
    record("workflows.remove", [input]);
    const idx = store.findIndex((row) => row.id === input.id);
    if (idx >= 0) store.splice(idx, 1);
  };
  return {
    store,
    setListRejects(next: boolean) {
      listRejects = next;
    },
  };
}

function Harness() {
  const {
    loading,
    workflows,
    providers,
    saveWorkflow,
    removeWorkflow,
    refreshWorkflows,
    workflowListError,
  } = useCoder();
  if (loading) return <div data-loading="">loading</div>;
  return (
    <div>
      <span data-ids="">{workflows.map((w) => w.id).join(",")}</span>
      <span data-list-error="">{workflowListError ?? ""}</span>
      <WorkflowsModal
        open
        onClose={() => {}}
        workflows={workflows}
        providers={providers}
        onSave={saveWorkflow}
        onRemove={removeWorkflow}
        listError={workflowListError}
        onRetryList={refreshWorkflows}
      />
    </div>
  );
}

async function boot(seed: WorkflowTemplateInfo[] = []) {
  const fake = createFakeCoder({
    workflows: seed,
    providers: [
      {
        id: "claude",
        name: "Claude Code",
        available: true,
        supportsResume: true,
        models: [],
        modelInfo: [],
        efforts: [],
      } satisfies ProviderInfo,
    ],
  });
  const host = installMemoryWorkflows(fake, seed);
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  const m = await mount(<Harness />);
  assert.equal(
    m.query("[data-loading]"),
    null,
    "boot lists must settle before the editor opens",
  );
  return { fake, host, m };
}

function savePayloads(fake: FakeCoder): WorkflowSaveInput[] {
  return fake.of("workflows.save").map((call) => call.args[0] as WorkflowSaveInput);
}

describe("acknowledged save then failed refresh (#1138)", () => {
  it("adopts the new id so Retry Save updates instead of creating another", async () => {
    const { fake, host, m } = await boot();
    host.setListRejects(true);

    await m.click(m.byText("New workflow"));
    await m.type(m.query("#wf-name"), "My draft");
    await m.click(m.byText("Save"));

    const first = savePayloads(fake);
    assert.equal(first.length, 1, "first Save must write once");
    assert.equal(first[0].id, undefined, "first Save is an id-less create");
    assert.deepEqual(
      host.store.map((row) => row.id),
      ["wf-created-1"],
      "host must keep the acknowledged create",
    );
    assert.equal(
      m.query("[data-ids]")?.textContent,
      "wf-created-1",
      "hook state must adopt the returned id even though list rejected",
    );
    const listError = m.query("[data-list-error]")?.textContent ?? "";
    assert.match(
      listError,
      /saved.*list failed to refresh/i,
      `refresh failure must be reported as a refresh, not a save, got: ${listError}`,
    );
    assert.equal(
      m.query('[role="alert"]')?.textContent ?? "",
      "",
      "a successful save must not use the save-failure alert",
    );
    assert.ok(m.byText("Retry list"), "UI must offer retrying the list, not the write");

    host.setListRejects(false);
    const listsBeforeRetry = fake.of("workflows.list").length;
    await m.click(m.byText("Retry list"));
    assert.equal(
      fake.of("workflows.list").length,
      listsBeforeRetry + 1,
      "Retry list must re-read, not write",
    );
    assert.equal(
      savePayloads(fake).length,
      1,
      "Retry list must not replay the acknowledged save",
    );
    assert.equal(
      m.query("[data-list-error]")?.textContent,
      "",
      "a successful list retry must clear the refresh error",
    );

    await m.type(m.query("#wf-name"), "My draft v2");
    await m.click(m.byText("Save"));

    const saves = savePayloads(fake);
    assert.equal(saves.length, 2, "Retry Save must send a second write");
    assert.equal(
      saves[1].id,
      "wf-created-1",
      "Retry Save must update the acknowledged id, not create again",
    );
    assert.deepEqual(
      host.store.map((row) => row.id),
      ["wf-created-1"],
      "retry must not mint a second template",
    );
    assert.equal(host.store[0].name, "My draft v2");
    m.unmount();
  });

  it("adopts a builtin-copy id when list rejects, then updates that copy", async () => {
    const { fake, host, m } = await boot([builtin]);
    host.setListRejects(true);

    await m.click(m.byText("Save"));

    const first = savePayloads(fake);
    assert.equal(first.length, 1);
    assert.equal(
      first[0].id,
      "wf-builtin",
      "saving a builtin must send the source id so the host can copy",
    );
    assert.deepEqual(
      host.store.map((row) => row.id),
      ["wf-builtin", "wf-created-1"],
      "host must keep the builtin and the new copy",
    );
    assert.ok(
      (m.query("[data-ids]")?.textContent ?? "").includes("wf-created-1"),
      "editor must adopt the copy id, not stay on the builtin",
    );
    assert.match(
      m.query("[data-list-error]")?.textContent ?? "",
      /saved.*list failed to refresh/i,
    );

    host.setListRejects(false);
    await m.type(m.query("#wf-name"), "Ship checklist edited");
    await m.click(m.byText("Save"));

    const saves = savePayloads(fake);
    assert.equal(saves[1].id, "wf-created-1", "second Save must target the copy");
    assert.deepEqual(
      host.store.map((row) => row.id),
      ["wf-builtin", "wf-created-1"],
      "retry must not mint a second copy",
    );
    assert.equal(host.store[1].name, "Ship checklist edited");
    assert.equal(host.store[1].builtin, false);
    m.unmount();
  });

  it("keeps the draft and retries a true mutation failure as another create", async () => {
    const { fake, host, m } = await boot();
    const originalSave = fake.api.workflows.save;
    fake.api.workflows.save = async () => {
      fake.calls.push({ channel: "workflows.save", args: [{ failed: true }] });
      throw new Error("disk full");
    };

    await m.click(m.byText("New workflow"));
    await m.type(m.query("#wf-name"), "Unsaved draft");
    await m.click(m.byText("Save"));

    assert.equal(host.store.length, 0, "failed save must not create a row");
    assert.equal(
      m.query("[data-ids]")?.textContent,
      "",
      "failed save must not adopt an id",
    );
    assert.ok(
      (m.query('[role="alert"]')?.textContent ?? "").includes("disk full"),
      "true mutation failure must stay a save-failure alert",
    );
    assert.equal(
      m.query("[data-list-error]")?.textContent,
      "",
      "a failed write is not a refresh failure",
    );
    assert.equal(m.byText("Retry list"), null);

    fake.api.workflows.save = originalSave;
    await m.click(m.byText("Save"));

    const saves = savePayloads(fake).filter((p) => p && p.name);
    assert.equal(saves.length, 1, "retry after a real failure is the first successful write");
    assert.equal(saves[0].id, undefined, "draft must still be an id-less create");
    assert.deepEqual(
      host.store.map((row) => row.id),
      ["wf-created-1"],
    );
    m.unmount();
  });

  it("keeps a successful removal when the follow-up list rejects", async () => {
    const doomed: WorkflowTemplateInfo = {
      id: "wf-doomed",
      name: "Disposable",
      builtin: false,
      phases: [phase],
    };
    const { fake, host, m } = await boot([doomed]);
    host.setListRejects(true);

    await m.click(m.byText("Delete"));
    await m.click(m.byText("Confirm delete"));

    assert.deepEqual(
      fake.of("workflows.remove").map((call) => (call.args[0] as { id: string }).id),
      ["wf-doomed"],
    );
    assert.deepEqual(host.store.map((row) => row.id), []);
    assert.equal(
      m.query("[data-ids]")?.textContent,
      "",
      "hook state must drop the removed id even though list rejected",
    );
    assert.equal(
      m.text().includes("Disposable"),
      false,
      "editor must not keep presenting the removed template",
    );
    assert.match(
      m.query("[data-list-error]")?.textContent ?? "",
      /removed.*list failed to refresh/i,
      "removal success must not be shown as a delete failure",
    );
    assert.equal(
      m.query('[role="alert"]')?.textContent ?? "",
      "",
      "a successful remove must not use the mutation-failure alert",
    );
    m.unmount();
  });
});
