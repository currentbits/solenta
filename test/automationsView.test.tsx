/**
 * AutomationsView: rows, toggle, create form validation, in-place edit (#937),
 * pending create (#941).
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { inAct, mount } from "./support/dom.ts";
import { createFakeCoder } from "./support/fakeCoder.ts";
import { useCoderWorkflows } from "../src/coder/useCoderWorkflows";
import { AutomationsView } from "../src/components/AutomationsView";
import type {
  AutomationInfo,
  AutomationRunsResult,
  AutomationWrite,
  ProjectInfo,
  ProviderInfo,
  ThreadStatus,
} from "../src/shared/ipc";

const p1: ProjectInfo = {
  id: "p1",
  slug: "acme/ledger",
  name: "ledger",
  path: "/tmp/ledger",
};

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
];

function auto(
  over: Partial<AutomationInfo> & Pick<AutomationInfo, "id">,
): AutomationInfo {
  return {
    projectId: "p1",
    name: over.id,
    prompt: "do work",
    provider: "claude",
    model: null,
    preset: "hourly",
    hour: null,
    enabled: true,
    lastRunAt: null,
    nextRunAt: Date.now() + 60 * 60 * 1000,
    lastError: null,
    scope: over.scope ?? "private",
    ...over,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("AutomationsView", () => {
  it("prefills the create form from a RepeatDraft", async () => {
    const m = await mount(
      <AutomationsView
        automations={[]}
        projects={[p1]}
        providers={providers}
        draft={{
          threadId: "t-done",
          projectId: "p1",
          name: "Nightly review",
          prompt: "Review the ledger",
          provider: "claude",
          model: "opus",
        }}
        onCreate={() => {}}
        onUpdate={() => {}}
        onRemove={() => {}}
        onRunNow={() => {}}
      />,
    );
    const name = m.query(
      '[data-automation-create] [name="name"]',
    ) as HTMLInputElement | null;
    const prompt = m.query(
      '[data-automation-create] [name="prompt"]',
    ) as HTMLTextAreaElement | null;
    const model = m.query("[data-automation-model]") as HTMLInputElement | null;
    assert.ok(name && prompt && model);
    assert.equal(name.value, "Nightly review");
    assert.equal(prompt.value, "Review the ledger");
    assert.equal(model.value, "opus");
    m.unmount();
  });

  it("shows the empty state", async () => {
    const m = await mount(
      <AutomationsView
        automations={[]}
        projects={[p1]}
        providers={providers}
        onCreate={() => {}}
        onUpdate={() => {}}
        onRemove={() => {}}
        onRunNow={() => {}}
      />,
    );
    assert.ok(m.text().includes("No automations yet"));
    m.unmount();
  });

  it("renders rows with name, project slug, and schedule label", async () => {
    const m = await mount(
      <AutomationsView
        automations={[
          auto({
            id: "a1",
            name: "Nightly review",
            preset: "daily",
            hour: 9,
            nextRunAt: new Date(2026, 5, 11, 9, 0, 0).getTime(),
          }),
          auto({
            id: "a2",
            name: "Weekly sweep",
            preset: "weekly",
            hour: 9,
            lastError: "CLI missing",
            nextRunAt: new Date(2026, 5, 15, 9, 0, 0).getTime(),
          }),
        ]}
        projects={[p1]}
        providers={providers}
        onCreate={() => {}}
        onUpdate={() => {}}
        onRemove={() => {}}
        onRunNow={() => {}}
      />,
    );
    assert.ok(m.query('[data-automation-row="a1"]'), "daily row");
    assert.ok(m.text().includes("Nightly review"));
    assert.ok(m.text().includes("acme/ledger"));
    assert.ok(m.text().includes("daily at 9:00"));
    assert.ok(m.text().includes("Weekly sweep"));
    assert.ok(m.text().includes("weekly"));
    assert.ok(m.text().includes("CLI missing"));
    m.unmount();
  });

  it("toggles enabled via onUpdate", async () => {
    const updates: Array<{ id: string; enabled?: boolean }> = [];
    const m = await mount(
      <AutomationsView
        automations={[auto({ id: "a1", name: "Hourly", enabled: true })]}
        projects={[p1]}
        providers={providers}
        onCreate={() => {}}
        onUpdate={(input) => {
          updates.push(input);
        }}
        onRemove={() => {}}
        onRunNow={() => {}}
      />,
    );
    const toggle = m.query('[data-automation-toggle=""]');
    assert.ok(toggle, "toggle");
    await m.click(toggle);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].id, "a1");
    assert.equal(updates[0].enabled, false);
    m.unmount();
  });

  it("shows a rejected Run now on the row instead of rejecting (issue #85)", async () => {
    const m = await mount(
      <AutomationsView
        automations={[auto({ id: "a1", name: "Hourly" })]}
        projects={[p1]}
        providers={providers}
        onCreate={() => {}}
        onUpdate={() => {}}
        onRemove={() => {}}
        onRunNow={() => Promise.reject(new Error("claude CLI missing"))}
      />,
    );
    await m.click(m.query('[data-automation-run=""]'));
    assert.ok(
      (m.query('[data-automation-error=""]')?.textContent || "").includes(
        "claude CLI missing",
      ),
      "row must show the run failure",
    );
    m.unmount();
  });

  it("validates the create form before calling onCreate", async () => {
    const created: unknown[] = [];
    const m = await mount(
      <AutomationsView
        automations={[]}
        projects={[p1]}
        providers={providers}
        onCreate={(input) => {
          created.push(input);
        }}
        onUpdate={() => {}}
        onRemove={() => {}}
        onRunNow={() => {}}
      />,
    );
    const form = m.query("[data-automation-create]");
    assert.ok(form, "create form");
    const submit = m.query("[data-automation-create] button[type=submit]");
    assert.ok(submit, "submit");
    await m.click(submit);
    assert.equal(created.length, 0);
    assert.ok(m.query("[data-form-error]"), "error shown");
    assert.ok(m.text().includes("Name is required"));

    const name = m.query('[data-automation-create] [name="name"]');
    const prompt = m.query('[data-automation-create] [name="prompt"]');
    assert.ok(name && prompt);
    await m.type(name, "Nightly");
    await m.type(prompt, "review the repo");
    await m.click(submit);
    assert.equal(created.length, 1);
    const input = created[0] as { name: string; prompt: string; preset: string };
    assert.equal(input.name, "Nightly");
    assert.equal(input.prompt, "review the repo");
    assert.equal(input.preset, "hourly");
    m.unmount();
  });

  it("passes a typed model to onCreate when the provider has no model list", async () => {
    const created: unknown[] = [];
    const m = await mount(
      <AutomationsView
        automations={[]}
        projects={[p1]}
        providers={providers}
        onCreate={(input) => {
          created.push(input);
        }}
        onUpdate={() => {}}
        onRemove={() => {}}
        onRunNow={() => {}}
      />,
    );
    const modelInput = m.query("[data-automation-model]");
    assert.ok(modelInput, "model control");
    assert.equal(modelInput.tagName, "INPUT", "no model list → free-form input");

    await m.type(m.query('[data-automation-create] [name="name"]'), "Nightly");
    await m.type(
      m.query('[data-automation-create] [name="prompt"]'),
      "review the repo",
    );
    await m.type(modelInput, "claude-opus-4-6");
    await m.click(m.query("[data-automation-create] button[type=submit]"));

    assert.equal(created.length, 1);
    assert.equal(
      (created[0] as { model: string | null }).model,
      "claude-opus-4-6",
      "typed model must reach onCreate",
    );
    m.unmount();
  });

  it("offers a model dropdown when the provider lists models", async () => {
    const withModels: ProviderInfo[] = [
      { ...providers[0], models: ["claude-opus-4-6", "claude-sonnet-4-6"] },
    ];
    const m = await mount(
      <AutomationsView
        automations={[]}
        projects={[p1]}
        providers={withModels}
        onCreate={() => {}}
        onUpdate={() => {}}
        onRemove={() => {}}
        onRunNow={() => {}}
      />,
    );
    const select = m.query("select[data-automation-model]");
    assert.ok(select, "model list → dropdown");
    const labels = Array.from(select.querySelectorAll("option")).map(
      (o) => o.textContent,
    );
    assert.deepEqual(labels, ["Default", "claude-opus-4-6", "claude-sonnet-4-6"]);
    m.unmount();
  });

  function runs(
    over: Partial<AutomationRunsResult> & { automationId?: string },
  ): AutomationRunsResult {
    return {
      automationId: over.automationId ?? "a1",
      runs: over.runs ?? [],
      retentionLimitReached: over.retentionLimitReached ?? false,
    };
  }

  function runInfo(
    threadId: string,
    status: ThreadStatus,
    startedAt = Date.now() - 60_000,
  ) {
    return { threadId, status, startedAt };
  }

  it("shows latest run status and Open thread without starting a run", async () => {
    const selected: string[] = [];
    const runNow: string[] = [];
    const m = await mount(
      <AutomationsView
        automations={[auto({ id: "a1", name: "Hourly" })]}
        projects={[p1]}
        providers={providers}
        loadRuns={async () =>
          runs({
            runs: [
              runInfo("t-new", "working"),
              runInfo("t-old", "done", Date.now() - 3600_000),
            ],
          })
        }
        onSelectThread={(id) => {
          selected.push(id);
        }}
        onCreate={() => {}}
        onUpdate={() => {}}
        onRemove={() => {}}
        onRunNow={() => {
          runNow.push("fired");
        }}
      />,
    );
    await m.flush();
    const latest = m.query("[data-automation-latest]");
    assert.ok(latest, "latest run");
    assert.ok(
      (latest.textContent || "").includes("Working"),
      "latest status is Working",
    );
    const open = m.query("[data-automation-open-thread]");
    assert.ok(open, "Open thread");
    await m.click(open);
    assert.deepEqual(selected, ["t-new"]);
    assert.deepEqual(runNow, []);
    m.unmount();
  });

  it("expands Recent retained runs newest first and maps quota-wait to Paused", async () => {
    const selected: string[] = [];
    const runNow: string[] = [];
    const m = await mount(
      <AutomationsView
        automations={[auto({ id: "a1", name: "Hourly" })]}
        projects={[p1]}
        providers={providers}
        loadRuns={async () =>
          runs({
            runs: [
              runInfo("t-live", "working"),
              runInfo("t-parked", "quota-wait", Date.now() - 120_000),
              runInfo("t-fail", "failed", Date.now() - 180_000),
              runInfo("t-done", "done", Date.now() - 240_000),
            ],
            retentionLimitReached: true,
          })
        }
        onSelectThread={(id) => {
          selected.push(id);
        }}
        onCreate={() => {}}
        onUpdate={() => {}}
        onRemove={() => {}}
        onRunNow={() => {
          runNow.push("fired");
        }}
      />,
    );
    await m.flush();
    assert.ok(m.text().includes("Recent retained runs"));
    const toggle = m.query("[data-automation-runs-toggle]");
    assert.ok(toggle, "expand");
    await m.click(toggle);
    assert.deepEqual(runNow, [], "expanding history starts no run");
    const ids = m
      .queryAll("[data-automation-run-row]")
      .map((el) => el.getAttribute("data-automation-run-row"));
    assert.deepEqual(ids, ["t-live", "t-parked", "t-fail", "t-done"]);
    assert.ok(m.text().includes("Paused"));
    assert.ok(m.text().includes("Failed"));
    assert.ok(m.text().includes("Completed"));
    assert.ok(m.text().includes("Older runs may no longer be retained."));
    await m.click(m.query('[data-automation-run-row="t-parked"]'));
    assert.deepEqual(selected, ["t-parked"]);
    m.unmount();
  });

  it("says the last run is no longer retained when lastRunAt has no thread", async () => {
    const m = await mount(
      <AutomationsView
        automations={[
          auto({ id: "a1", name: "Hourly", lastRunAt: Date.now() - 1000 }),
        ]}
        projects={[p1]}
        providers={providers}
        loadRuns={async () => runs({ runs: [] })}
        onCreate={() => {}}
        onUpdate={() => {}}
        onRemove={() => {}}
        onRunNow={() => {}}
      />,
    );
    await m.flush();
    assert.ok(m.query("[data-automation-runs-missing]"));
    assert.ok(m.text().includes("The last run is no longer retained."));
    assert.equal(m.query("[data-automation-open-thread]"), null);
    m.unmount();
  });

  it("does not open a deleted thread and overlays live working status", async () => {
    const selected: string[] = [];
    const m = await mount(
      <AutomationsView
        automations={[auto({ id: "a1", name: "Hourly" })]}
        projects={[p1]}
        providers={providers}
        liveThreads={[{ id: "t-live", status: "working" }]}
        loadRuns={async () =>
          runs({
            runs: [
              runInfo("t-live", "idle"),
              runInfo("t-gone", "done", Date.now() - 3600_000),
            ],
          })
        }
        onSelectThread={(id) => {
          selected.push(id);
        }}
        onCreate={() => {}}
        onUpdate={() => {}}
        onRemove={() => {}}
        onRunNow={() => {}}
      />,
    );
    await m.flush();
    const latest = m.query("[data-automation-latest]");
    assert.ok(latest);
    assert.ok((latest.textContent || "").includes("Working"));
    await m.click(m.query("[data-automation-runs-toggle]"));
    const gone = m.query('[data-automation-run-row="t-gone"]');
    assert.ok(gone);
    assert.ok((gone.textContent || "").includes("Transcript unavailable"));
    await m.click(gone);
    assert.deepEqual(selected, []);
    m.unmount();
  });

  it("keeps Run now labeled Run now", async () => {
    const m = await mount(
      <AutomationsView
        automations={[auto({ id: "a1", name: "Hourly" })]}
        projects={[p1]}
        providers={providers}
        onCreate={() => {}}
        onUpdate={() => {}}
        onRemove={() => {}}
        onRunNow={() => {}}
      />,
    );
    const run = m.query("[data-automation-run]");
    assert.ok(run);
    assert.equal(run.textContent, "Run now");
    assert.equal(m.text().includes("Replay"), false);
    m.unmount();
  });

  it("a pending create cannot start twice; a later submit is a new request (#941)", async () => {
    const created: AutomationWrite[] = [];
    const held = deferred();
    const m = await mount(
      <AutomationsView
        automations={[]}
        projects={[p1]}
        providers={providers}
        onCreate={async (input) => {
          created.push(input);
          await held.promise;
        }}
        onUpdate={() => {}}
        onRemove={() => {}}
        onRunNow={() => {}}
      />,
    );
    await m.type(m.query('[data-automation-create] [name="name"]'), "Nightly");
    await m.type(
      m.query('[data-automation-create] [name="prompt"]'),
      "review the repo",
    );

    const form = m.query("[data-automation-create]");
    const submit = m.query(
      "[data-automation-create] button[type=submit]",
    ) as HTMLButtonElement | null;
    assert.ok(form && submit, "create form");

    const fireSubmit = () => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    };
    await inAct(async () => {
      fireSubmit();
      fireSubmit();
    });
    await m.flush();
    await m.click(submit);
    fireSubmit();
    await m.flush();

    assert.equal(created.length, 1, "pending create must be a single host request");
    assert.equal(submit.disabled, true, "submit must show pending");
    assert.equal(submit.getAttribute("aria-busy"), "true");
    assert.match(submit.textContent || "", /Adding/);
    assert.equal(
      (m.query('[data-automation-create] [name="name"]') as HTMLInputElement)
        .value,
      "Nightly",
      "form stays filled until the pending create finishes",
    );

    held.resolve();
    await m.flush();
    assert.equal(
      (m.query('[data-automation-create] [name="name"]') as HTMLInputElement)
        .value,
      "",
    );
    assert.equal(submit.disabled, false);
    assert.equal(submit.getAttribute("aria-busy"), null);
    assert.match(submit.textContent || "", /Add automation/);

    await m.type(m.query('[data-automation-create] [name="name"]'), "Nightly");
    await m.type(
      m.query('[data-automation-create] [name="prompt"]'),
      "review the repo",
    );
    await m.click(submit);
    assert.equal(
      created.length,
      2,
      "an intentional later create with the same prompt is allowed",
    );
    m.unmount();
  });

  it("a failed create keeps the typed form and can retry", async () => {
    const created: AutomationWrite[] = [];
    let fail = true;
    const m = await mount(
      <AutomationsView
        automations={[]}
        projects={[p1]}
        providers={providers}
        onCreate={async (input) => {
          created.push(input);
          if (fail) {
            fail = false;
            throw new Error("store locked");
          }
        }}
        onUpdate={() => {}}
        onRemove={() => {}}
        onRunNow={() => {}}
      />,
    );
    await m.type(m.query('[data-automation-create] [name="name"]'), "Nightly");
    await m.type(
      m.query('[data-automation-create] [name="prompt"]'),
      "review the repo",
    );
    await m.click(m.query("[data-automation-create] button[type=submit]"));

    assert.equal(created.length, 1);
    assert.equal(
      (m.query('[data-automation-create] [name="name"]') as HTMLInputElement)
        .value,
      "Nightly",
    );
    assert.equal(
      (m.query('[data-automation-create] [name="prompt"]') as HTMLTextAreaElement)
        .value,
      "review the repo",
    );
    assert.ok(
      (m.query("[data-form-error]")?.textContent || "").includes("store locked"),
      "create failure must surface on the form",
    );
    const submit = m.query(
      "[data-automation-create] button[type=submit]",
    ) as HTMLButtonElement | null;
    assert.ok(submit);
    assert.equal(submit.disabled, false, "retry must be available after failure");

    await m.click(submit);
    assert.equal(created.length, 2);
    assert.equal(
      (m.query('[data-automation-create] [name="name"]') as HTMLInputElement)
        .value,
      "",
      "successful retry clears the form",
    );
    assert.equal(m.query("[data-form-error]"), null);
    m.unmount();
  });

  it("shows the current prompt on the row before editing", async () => {
    const m = await mount(
      <AutomationsView
        automations={[
          auto({
            id: "a1",
            name: "Nightly review",
            prompt: "Review the ledger nightly",
          }),
        ]}
        projects={[p1]}
        providers={providers}
        onCreate={() => {}}
        onUpdate={() => {}}
        onRemove={() => {}}
        onRunNow={() => {}}
      />,
    );
    const shown = m.query('[data-automation-prompt=""]');
    assert.ok(shown, "prompt is visible on the row");
    assert.equal(shown.textContent, "Review the ledger nightly");
    m.unmount();
  });

  it("Edit populates the existing form and keeps the project fixed", async () => {
    const m = await mount(
      <AutomationsView
        automations={[
          auto({
            id: "a1",
            name: "Nightly review",
            prompt: "Review the ledger",
            provider: "claude",
            model: "opus",
            preset: "daily",
            hour: 9,
          }),
        ]}
        projects={[p1]}
        providers={providers}
        onCreate={() => {}}
        onUpdate={() => {}}
        onRemove={() => {}}
        onRunNow={() => {}}
      />,
    );
    await m.click(m.query('[data-automation-edit=""]'));
    const name = m.query(
      '[data-automation-create] [name="name"]',
    ) as HTMLInputElement | null;
    const prompt = m.query(
      '[data-automation-create] [name="prompt"]',
    ) as HTMLTextAreaElement | null;
    const project = m.query(
      '[data-automation-create] [name="projectId"]',
    ) as HTMLSelectElement | null;
    const provider = m.query(
      '[data-automation-create] [name="provider"]',
    ) as HTMLSelectElement | null;
    const model = m.query("[data-automation-model]") as HTMLInputElement | null;
    const preset = m.query(
      '[data-automation-create] [name="preset"]',
    ) as HTMLSelectElement | null;
    const hour = m.query(
      '[data-automation-create] [name="hour"]',
    ) as HTMLInputElement | null;
    assert.ok(name && prompt && project && provider && model && preset && hour);
    assert.equal(name.value, "Nightly review");
    assert.equal(prompt.value, "Review the ledger");
    assert.equal(project.value, "p1");
    assert.equal(project.disabled, true, "project stays fixed while editing");
    assert.equal(provider.value, "claude");
    assert.equal(model.value, "opus");
    assert.equal(preset.value, "daily");
    assert.equal(hour.value, "9");
    const submit = m.query(
      "[data-automation-create] button[type=submit]",
    ) as HTMLButtonElement | null;
    assert.ok(submit);
    assert.equal(submit.textContent, "Save");
    assert.ok(m.query('[data-automation-cancel=""]'), "Cancel is available");
    m.unmount();
  });

  it("focusId opens the matching row in the form", async () => {
    const m = await mount(
      <AutomationsView
        automations={[
          auto({
            id: "a1",
            name: "Nightly review",
            prompt: "Review the ledger",
            provider: "claude",
            model: "opus",
            preset: "daily",
            hour: 9,
          }),
          auto({ id: "a2", name: "Other" }),
        ]}
        projects={[p1]}
        providers={providers}
        focusId="a1"
        onCreate={() => {}}
        onUpdate={() => {}}
        onRemove={() => {}}
        onRunNow={() => {}}
      />,
    );
    const name = m.query(
      '[data-automation-create] [name="name"]',
    ) as HTMLInputElement | null;
    const prompt = m.query(
      '[data-automation-create] [name="prompt"]',
    ) as HTMLTextAreaElement | null;
    assert.ok(name && prompt);
    assert.equal(name.value, "Nightly review");
    assert.equal(prompt.value, "Review the ledger");
    const submit = m.query(
      "[data-automation-create] button[type=submit]",
    ) as HTMLButtonElement | null;
    assert.ok(submit);
    assert.equal(submit.textContent, "Save");
    m.unmount();
  });

  it("Save updates the same automation and omits enabled and projectId", async () => {
    const created: unknown[] = [];
    const updates: Array<Record<string, unknown>> = [];
    const m = await mount(
      <AutomationsView
        automations={[
          auto({
            id: "a1",
            name: "Hourly",
            prompt: "do work",
            enabled: false,
            model: null,
          }),
        ]}
        projects={[p1]}
        providers={providers}
        onCreate={(input) => {
          created.push(input);
        }}
        onUpdate={(input) => {
          updates.push(input);
        }}
        onRemove={() => {}}
        onRunNow={() => {}}
      />,
    );
    await m.click(m.query('[data-automation-edit=""]'));
    await m.type(m.query('[data-automation-create] [name="name"]'), "Hourly v2");
    await m.type(
      m.query('[data-automation-create] [name="prompt"]'),
      "do better work",
    );
    await m.type(m.query("[data-automation-model]"), "claude-opus-4-6");
    await m.click(m.query("[data-automation-create] button[type=submit]"));
    assert.equal(created.length, 0, "edit must not create another automation");
    assert.equal(updates.length, 1);
    assert.equal(updates[0].id, "a1");
    assert.equal(updates[0].name, "Hourly v2");
    assert.equal(updates[0].prompt, "do better work");
    assert.equal(updates[0].model, "claude-opus-4-6");
    assert.equal(updates[0].preset, "hourly");
    assert.equal(updates[0].hour, null);
    assert.equal(
      Object.prototype.hasOwnProperty.call(updates[0], "enabled"),
      false,
      "enabled stays whatever it was",
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(updates[0], "projectId"),
      false,
      "project stays fixed",
    );
    const name = m.query(
      '[data-automation-create] [name="name"]',
    ) as HTMLInputElement | null;
    const submit = m.query(
      "[data-automation-create] button[type=submit]",
    ) as HTMLButtonElement | null;
    assert.ok(name && submit);
    assert.equal(name.value, "", "form returns to create after save");
    assert.equal(submit.textContent, "Add automation");
    m.unmount();
  });

  it("Cancel discards edits and does not call onUpdate", async () => {
    const updates: unknown[] = [];
    const m = await mount(
      <AutomationsView
        automations={[auto({ id: "a1", name: "Hourly", prompt: "do work" })]}
        projects={[p1]}
        providers={providers}
        onCreate={() => {}}
        onUpdate={(input) => {
          updates.push(input);
        }}
        onRemove={() => {}}
        onRunNow={() => {}}
      />,
    );
    await m.click(m.query('[data-automation-edit=""]'));
    await m.type(m.query('[data-automation-create] [name="name"]'), "Nope");
    await m.click(m.query('[data-automation-cancel=""]'));
    assert.equal(updates.length, 0);
    const name = m.query(
      '[data-automation-create] [name="name"]',
    ) as HTMLInputElement | null;
    const submit = m.query(
      "[data-automation-create] button[type=submit]",
    ) as HTMLButtonElement | null;
    assert.ok(name && submit);
    assert.equal(name.value, "");
    assert.equal(submit.textContent, "Add automation");
    assert.equal(m.query('[data-automation-cancel=""]'), null);
    m.unmount();
  });

  it("failed save keeps edits and retries through onUpdate", async () => {
    const updates: unknown[] = [];
    let fail = true;
    const m = await mount(
      <AutomationsView
        automations={[auto({ id: "a1", name: "Hourly", prompt: "do work" })]}
        projects={[p1]}
        providers={providers}
        onCreate={() => {}}
        onUpdate={async (input) => {
          updates.push(input);
          if (fail) {
            fail = false;
            throw new Error("disk full");
          }
        }}
        onRemove={() => {}}
        onRunNow={() => {}}
      />,
    );
    await m.click(m.query('[data-automation-edit=""]'));
    await m.type(
      m.query('[data-automation-create] [name="prompt"]'),
      "revised prompt",
    );
    await m.click(m.query("[data-automation-create] button[type=submit]"));
    assert.equal(updates.length, 1);
    assert.ok(
      (m.query("[data-form-error]")?.textContent || "").includes("disk full"),
      "save error is visible",
    );
    const prompt = m.query(
      '[data-automation-create] [name="prompt"]',
    ) as HTMLTextAreaElement | null;
    const submit = m.query(
      "[data-automation-create] button[type=submit]",
    ) as HTMLButtonElement | null;
    assert.ok(prompt && submit);
    assert.equal(prompt.value, "revised prompt");
    assert.equal(submit.textContent, "Save", "still in edit mode so retry works");
    await m.click(submit);
    assert.equal(updates.length, 2);
    assert.equal((updates[1] as { prompt: string }).prompt, "revised prompt");
    assert.equal(prompt.value, "", "successful retry clears the form");
    assert.equal(m.query("[data-form-error]"), null);
    m.unmount();
  });

  it("schedule edits send the new preset and the row shows the next run", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const hourly = auto({
      id: "a1",
      name: "Hourly",
      prompt: "do work",
      preset: "hourly",
      hour: null,
    });
    const nextRunAt = new Date(2026, 5, 11, 9, 0, 0).getTime();
    const m = await mount(
      <AutomationsView
        automations={[hourly]}
        projects={[p1]}
        providers={providers}
        onCreate={() => {}}
        onUpdate={(input) => {
          updates.push(input);
        }}
        onRemove={() => {}}
        onRunNow={() => {}}
      />,
    );
    await m.click(m.query('[data-automation-edit=""]'));
    await m.change(m.query('[data-automation-create] [name="preset"]'), "daily");
    await m.click(m.query("[data-automation-create] button[type=submit]"));
    assert.equal(updates.length, 1);
    assert.equal(updates[0].id, "a1");
    assert.equal(updates[0].preset, "daily");
    assert.equal(updates[0].hour, 9);

    await m.rerender(
      <AutomationsView
        automations={[
          { ...hourly, preset: "daily", hour: 9, nextRunAt },
        ]}
        projects={[p1]}
        providers={providers}
        onCreate={() => {}}
        onUpdate={(input) => {
          updates.push(input);
        }}
        onRemove={() => {}}
        onRunNow={() => {}}
      />,
    );
    assert.ok(m.text().includes("daily at 9:00"));
    m.unmount();
  });

  it("event triggers: picks a GitHub event, sends its filter, edits memory (#242)", async () => {
    const created: Array<Record<string, unknown>> = [];
    const updates: Array<Record<string, unknown>> = [];
    const triage = auto({
      id: "a1",
      name: "Triage",
      preset: "hourly",
      trigger: { type: "github", event: "ci_completed", branch: "main", label: null, conclusion: "failure" },
      memory: "flaky: web-integration",
    });
    const m = await mount(
      <AutomationsView
        automations={[triage]}
        projects={[p1]}
        providers={providers}
        onCreate={(input) => {
          created.push(input as unknown as Record<string, unknown>);
        }}
        onUpdate={(input) => {
          updates.push(input);
        }}
        onRemove={() => {}}
        onRunNow={() => {}}
      />,
    );
    assert.ok(m.text().includes("on CI completed (failure) on main"));
    assert.equal(m.query("[data-automation-memory]"), null, "memory is edit-only");

    // A hidden daily preset must not leak an hour requirement into event mode.
    await m.change(m.query('[data-automation-create] [name="preset"]'), "daily");
    await m.change(m.query('[data-automation-create] [name="preset"]'), "pr_labeled");
    assert.equal(m.query('[data-automation-create] [name="hour"]'), null);
    await m.type(m.query('[data-automation-create] [name="name"]'), "Bug triage");
    await m.type(m.query('[data-automation-create] [name="prompt"]'), "triage it");
    await m.type(m.query('[data-automation-create] [name="label"]'), "bug");
    await m.click(m.query("[data-automation-create] button[type=submit]"));
    assert.equal(created.length, 1);
    assert.equal(created[0].preset, "hourly");
    assert.equal(created[0].hour, null);
    assert.deepEqual(created[0].trigger, {
      type: "github",
      event: "pr_labeled",
      branch: null,
      label: "bug",
      conclusion: null,
      team: null,
      status: null,
      org: null,
      project: null,
      environment: null,
    });

    await m.click(m.query('[data-automation-edit=""]'));
    const memory = m.query("[data-automation-memory]") as HTMLTextAreaElement | null;
    assert.ok(memory);
    assert.equal(memory.value, "flaky: web-integration");
    assert.equal((m.query('[data-automation-create] [name="branch"]') as HTMLInputElement).value, "main");
    await m.change(m.query('[data-automation-create] [name="preset"]'), "weekly");
    await m.click(m.query("[data-automation-create] button[type=submit]"));
    assert.equal(updates.length, 1);
    assert.equal(updates[0].trigger, null, "back to schedule mode");
    assert.equal(updates[0].preset, "weekly");
    assert.equal(updates[0].memory, "flaky: web-integration");
    m.unmount();
  });

  it("event triggers: Linear and Sentry fields (#1588)", async () => {
    const created: Array<Record<string, unknown>> = [];
    const m = await mount(
      <AutomationsView
        automations={[]}
        projects={[p1]}
        providers={providers}
        onCreate={(input) => {
          created.push(input as unknown as Record<string, unknown>);
        }}
        onUpdate={() => {}}
        onRemove={() => {}}
        onRunNow={() => {}}
      />,
    );
    await m.change(m.query('[data-automation-create] [name="preset"]'), "linear_status_changed");
    await m.type(m.query('[data-automation-create] [name="name"]'), "Lin");
    await m.type(m.query('[data-automation-create] [name="prompt"]'), "triage");
    await m.type(m.query('[data-automation-create] [name="team"]'), "ENG");
    await m.type(m.query('[data-automation-create] [name="status"]'), "Done");
    await m.click(m.query("[data-automation-create] button[type=submit]"));
    assert.equal(created.length, 1);
    assert.deepEqual(created[0].trigger, {
      type: "linear",
      event: "linear_status_changed",
      branch: null,
      label: null,
      conclusion: null,
      team: "ENG",
      status: "Done",
      org: null,
      project: null,
      environment: null,
    });

    await m.change(m.query('[data-automation-create] [name="preset"]'), "sentry_issue");
    await m.type(m.query('[data-automation-create] [name="name"]'), "Sen");
    await m.type(m.query('[data-automation-create] [name="prompt"]'), "fix");
    await m.click(m.query("[data-automation-create] button[type=submit]"));
    assert.equal(created.length, 1, "blank Sentry org/project must not create");
    assert.match(m.text(), /Sentry org is required/);
    await m.type(m.query('[data-automation-create] [name="org"]'), "acme");
    await m.type(m.query('[data-automation-create] [name="project"]'), "pump");
    await m.type(m.query('[data-automation-create] [name="environment"]'), "prod");
    await m.click(m.query("[data-automation-create] button[type=submit]"));
    assert.equal(created.length, 2);
    assert.deepEqual(created[1].trigger, {
      type: "sentry",
      event: "sentry_issue",
      branch: null,
      label: null,
      conclusion: null,
      team: null,
      status: null,
      org: "acme",
      project: "pump",
      environment: "prod",
    });
    m.unmount();
  });

  it("does not submit a pending save twice", async () => {
    const updates: unknown[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const m = await mount(
      <AutomationsView
        automations={[auto({ id: "a1", name: "Hourly", prompt: "do work" })]}
        projects={[p1]}
        providers={providers}
        onCreate={() => {}}
        onUpdate={async (input) => {
          updates.push(input);
          await gate;
        }}
        onRemove={() => {}}
        onRunNow={() => {}}
      />,
    );
    await m.click(m.query('[data-automation-edit=""]'));
    const submit = m.query(
      "[data-automation-create] button[type=submit]",
    ) as HTMLButtonElement | null;
    assert.ok(submit);
    await m.click(submit);
    assert.equal(updates.length, 1);
    assert.equal(submit.disabled, true);
    await m.click(submit);
    assert.equal(updates.length, 1, "second submit is ignored while pending");
    release();
    await m.flush();
    assert.equal(submit.disabled, false);
    assert.equal(submit.textContent, "Add automation");
    m.unmount();
  });

  it("create form has a Scope select; Project is disabled for a remote project", async () => {
    const m = await mount(
      <AutomationsView
        automations={[]}
        projects={[
          p1,
          {
            ...p1,
            id: "p2",
            slug: "acme/ssh",
            remoteHost: "h",
            path: "/tmp/ssh",
          },
          { ...p1, id: "p3", slug: "acme/nopath", path: "" },
        ]}
        providers={providers}
        onCreate={async () => {}}
        onUpdate={async () => {}}
        onRemove={async () => {}}
        onRunNow={async () => {}}
      />,
    );
    const scope = m.query("[data-automation-scope]") as HTMLSelectElement | null;
    assert.ok(scope, "scope select");
    const projectOpt = () =>
      scope.querySelector('option[value="project"]') as HTMLOptionElement | null;
    assert.ok(projectOpt());
    assert.equal(projectOpt()!.disabled, false, "local project can use Project");

    await m.change(m.query('[data-automation-create] [name="projectId"]'), "p2");
    assert.equal(
      projectOpt()!.disabled,
      true,
      "remote project cannot use Project",
    );

    await m.change(m.query('[data-automation-create] [name="projectId"]'), "p3");
    assert.equal(
      projectOpt()!.disabled,
      true,
      "pathless project cannot use Project",
    );
    m.unmount();
  });

  it("badges a project row and labels the toggle run-on-this-machine", async () => {
    const m = await mount(
      <AutomationsView
        automations={[
          auto({
            id: "shared:p1:pr-triage",
            scope: "project",
            name: "PR triage",
          }),
          auto({ id: "a-private", name: "Local only" }),
        ]}
        projects={[p1]}
        providers={providers}
        onCreate={async () => {}}
        onUpdate={async () => {}}
        onRemove={async () => {}}
        onRunNow={async () => {}}
      />,
    );
    assert.match(m.text(), /Project/);
    const row = m.query('[data-automation-row="shared:p1:pr-triage"]');
    assert.ok(row);
    const badge = row.querySelector("[data-automation-scope-badge]");
    assert.ok(badge);
    assert.equal(badge.textContent, "Project");
    const toggle = row.querySelector("[data-automation-toggle]");
    assert.ok(toggle);
    assert.match(toggle.getAttribute("aria-label") || "", /this machine/i);

    const privateRow = m.query('[data-automation-row="a-private"]');
    assert.ok(privateRow);
    assert.equal(
      privateRow.querySelector("[data-automation-scope-badge]")?.textContent,
      "Private",
    );
    const privateToggle = privateRow.querySelector("[data-automation-toggle]");
    assert.ok(privateToggle);
    assert.match(privateToggle.getAttribute("aria-label") || "", /Disable/);
    m.unmount();
  });

  it("shows one approve card per untrusted project and calls onTrustFile", async () => {
    let trusted: { projectId: string; hash: string } | null = null;
    const hash = "a".repeat(64);
    const m = await mount(
      <AutomationsView
        automations={[auto({ id: "shared:p1:pr-triage", scope: "project" })]}
        projects={[
          {
            ...p1,
            automationsFile: { hash, trusted: false, count: 1 },
          },
        ]}
        providers={providers}
        onCreate={async () => {}}
        onUpdate={async () => {}}
        onRemove={async () => {}}
        onRunNow={async () => {}}
        onTrustFile={async (projectId, fileHash) => {
          trusted = { projectId, hash: fileHash };
        }}
      />,
    );
    const card = m.query("[data-automations-approve]");
    assert.ok(card);
    assert.match(m.text(), /solenta\.json/);
    assert.match(
      m.text(),
      /Run automations from this repo’s solenta\.json\?/,
    );
    assert.match(
      m.text(),
      /These come from a checked-in file, so anyone who can push to the repo can change them\. You will be asked again if they change\./,
    );
    await m.click(m.query("[data-automations-approve-run]"));
    assert.deepEqual(trusted, { projectId: "p1", hash });
    m.unmount();
  });

  it("cancel hides the approve card for this session only", async () => {
    const m = await mount(
      <AutomationsView
        automations={[auto({ id: "shared:p1:pr-triage", scope: "project" })]}
        projects={[
          {
            ...p1,
            automationsFile: {
              hash: "a".repeat(64),
              trusted: false,
              count: 1,
            },
          },
        ]}
        providers={providers}
        onCreate={async () => {}}
        onUpdate={async () => {}}
        onRemove={async () => {}}
        onRunNow={async () => {}}
        onTrustFile={async () => {}}
      />,
    );
    assert.ok(m.query("[data-automations-approve]"));
    const cancel = m.byText("Cancel");
    assert.ok(cancel, "cancel on approve card");
    await m.click(cancel);
    assert.equal(m.query("[data-automations-approve]"), null);
    m.unmount();
  });

  it("after a project-scope create, shows the write-and-commit note", async () => {
    const created: AutomationWrite[] = [];
    const m = await mount(
      <AutomationsView
        automations={[]}
        projects={[p1]}
        providers={providers}
        onCreate={async (input) => {
          created.push(input);
        }}
        onUpdate={async () => {}}
        onRemove={async () => {}}
        onRunNow={async () => {}}
      />,
    );
    await m.type(m.query('[data-automation-create] [name="name"]'), "PR triage");
    await m.type(
      m.query('[data-automation-create] [name="prompt"]'),
      "triage incoming PRs",
    );
    await m.change(m.query("[data-automation-scope]"), "project");
    await m.click(m.query("[data-automation-create] button[type=submit]"));
    assert.equal(created.length, 1);
    assert.equal(created[0].scope, "project");
    const note = m.query("[data-automation-wrote]");
    assert.ok(note);
    assert.equal(note.textContent, "Wrote solenta.json — commit it to share.");
    m.unmount();
  });

  it("after a project-scope definition update, shows the write-and-commit note", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const m = await mount(
      <AutomationsView
        automations={[
          auto({
            id: "shared:p1:pr-triage",
            scope: "project",
            name: "PR triage",
          }),
        ]}
        projects={[p1]}
        providers={providers}
        onCreate={async () => {}}
        onUpdate={async (input) => {
          updates.push(input);
        }}
        onRemove={async () => {}}
        onRunNow={async () => {}}
      />,
    );
    await m.click(m.query('[data-automation-edit=""]'));
    await m.type(
      m.query('[data-automation-create] [name="prompt"]'),
      "triage harder",
    );
    await m.click(m.query("[data-automation-create] button[type=submit]"));
    assert.equal(updates.length, 1);
    assert.equal(
      Object.prototype.hasOwnProperty.call(updates[0], "scope"),
      false,
      "scope cannot change on update",
    );
    assert.ok(m.query("[data-automation-wrote]"));
    assert.equal(
      m.query("[data-automation-wrote]")?.textContent,
      "Wrote solenta.json — commit it to share.",
    );
    m.unmount();
  });

  it("after a project-scope memory-only save, does not show the write-and-commit note", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const m = await mount(
      <AutomationsView
        automations={[
          auto({
            id: "shared:p1:pr-triage",
            scope: "project",
            name: "PR triage",
            memory: "old notes",
          }),
        ]}
        projects={[p1]}
        providers={providers}
        onCreate={async () => {}}
        onUpdate={async (input) => {
          updates.push(input);
        }}
        onRemove={async () => {}}
        onRunNow={async () => {}}
      />,
    );
    await m.click(m.query('[data-automation-edit=""]'));
    await m.type(m.query("[data-automation-memory]"), "new notes");
    await m.click(m.query("[data-automation-create] button[type=submit]"));
    assert.equal(updates.length, 1);
    assert.equal(updates[0].memory, "new notes");
    assert.equal(
      m.query("[data-automation-wrote]")?.textContent ?? null,
      null,
      "memory is not a definition field; solenta.json was not written",
    );
    m.unmount();
  });

  it("untrusted project row disables the toggle and Run now passes the file hash", async () => {
    const runs: Array<[string, string?]> = [];
    const updates: unknown[] = [];
    const hash = "a".repeat(64);
    const m = await mount(
      <AutomationsView
        automations={[
          auto({
            id: "shared:p1:pr-triage",
            scope: "project",
            enabled: true,
          }),
        ]}
        projects={[
          {
            ...p1,
            automationsFile: { hash, trusted: false, count: 1 },
          },
        ]}
        providers={providers}
        onCreate={async () => {}}
        onUpdate={async (input) => {
          updates.push(input);
        }}
        onRemove={async () => {}}
        onRunNow={async (id, fileHash) => {
          runs.push([id, fileHash]);
        }}
      />,
    );
    const toggle = m.query(
      "[data-automation-toggle]",
    ) as HTMLInputElement | null;
    assert.ok(toggle);
    assert.equal(
      toggle.disabled,
      true,
      "toggle keys off automationsFile.trusted, not enabled",
    );
    assert.equal(toggle.checked, true, "do not force untrusted rows enabled:false");
    await m.click(toggle);
    assert.equal(updates.length, 0, "disabled toggle must not update");

    await m.click(m.query("[data-automation-run]"));
    assert.deepEqual(runs, [["shared:p1:pr-triage", hash]]);
    m.unmount();
  });

  it("trusted project Run now calls onRunNow with only the id", async () => {
    const runs: Array<[string, string?]> = [];
    const m = await mount(
      <AutomationsView
        automations={[
          auto({
            id: "shared:p1:pr-triage",
            scope: "project",
            enabled: false,
          }),
        ]}
        projects={[
          {
            ...p1,
            automationsFile: {
              hash: "a".repeat(64),
              trusted: true,
              count: 1,
            },
          },
        ]}
        providers={providers}
        onCreate={async () => {}}
        onUpdate={async () => {}}
        onRemove={async () => {}}
        onRunNow={async (id, fileHash) => {
          runs.push([id, fileHash]);
        }}
      />,
    );
    const toggle = m.query(
      "[data-automation-toggle]",
    ) as HTMLInputElement | null;
    assert.ok(toggle);
    assert.equal(toggle.disabled, false);
    assert.equal(toggle.checked, false);
    assert.equal(m.query("[data-automations-approve]"), null);
    await m.click(m.query("[data-automation-run]"));
    assert.deepEqual(runs, [["shared:p1:pr-triage", undefined]]);
    m.unmount();
  });
});

describe("useCoderWorkflows approve-and-run", () => {
  it("refreshes projects after runNow with a hash", async () => {
    const fake = createFakeCoder({
      automations: [auto({ id: "shared:p1:nightly", scope: "project" })],
      projects: [
        {
          ...p1,
          automationsFile: { hash: "a".repeat(64), trusted: false, count: 1 },
        },
      ],
    });
    const seen: ProjectInfo[][] = [];
    let runNow:
      | ((id: string, hash?: string) => Promise<AutomationInfo>)
      | null = null;
    function Harness() {
      const selectedRef = React.useRef<string | null>(null);
      const threadsRef = React.useRef([]);
      const hook = useCoderWorkflows({
        api: fake.api,
        selectedThreadId: null,
        setWorkflows: () => {},
        setWorkflowListError: () => {},
        setAutomations: () => {},
        setProjects: (next) => {
          seen.push(typeof next === "function" ? next([]) : next);
        },
        setDetail: () => {},
        setError: () => {},
        selectedRef,
        threadsRef,
        applyThreads: () => {},
      });
      runNow = hook.runAutomationNow;
      return null;
    }
    const m = await mount(<Harness />);
    await runNow!("shared:p1:nightly", "a".repeat(64));
    assert.equal(fake.of("automations.runNow").length, 1);
    assert.equal(fake.of("projects.list").length, 1);
    assert.equal(seen.length, 1);
    assert.equal(seen[0][0].id, "p1");
    m.unmount();
  });
});
