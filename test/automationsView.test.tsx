/**
 * AutomationsView: rows, toggle, create form validation, pending create.
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { inAct, mount } from "./support/dom.ts";
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
    ...over,
  };
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
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
