/**
 * AutomationsView: rows, toggle, create form validation.
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { mount } from "./support/dom.ts";
import { AutomationsView } from "../src/components/AutomationsView";
import type {
  AutomationInfo,
  ProjectInfo,
  ProviderInfo,
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
});
