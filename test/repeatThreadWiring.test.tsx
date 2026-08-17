/**
 * Issue #285: "repeat this" from a finished thread into automations / workflows.
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import {
  createFakeCoder,
  installFakeCoder,
  project,
  thread,
  detail,
  type FakeCoder,
} from "./support/fakeCoder.ts";
import App from "../src/App";
import type { ChatMessage } from "../src/shared/ipc";

async function boot(fake: FakeCoder) {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  return mount(<App />);
}

function msg(
  over: Partial<ChatMessage> & Pick<ChatMessage, "role" | "text">,
): ChatMessage {
  return {
    id: over.id ?? `m-${over.role}-${over.createdAt ?? 1}`,
    role: over.role,
    text: over.text,
    createdAt: over.createdAt ?? 1,
  };
}

function finishedThread() {
  const t = thread({
    id: "t-done",
    title: "Nightly review",
    projectId: "p1",
    provider: "claude",
    model: "opus",
    status: "idle",
  });
  return {
    t,
    fake: createFakeCoder({
      projects: [project({ id: "p1" })],
      threads: [t],
      details: {
        "t-done": detail({
          thread: t,
          messages: [
            msg({
              id: "u1",
              role: "user",
              text: "Review the ledger for anomalies",
              createdAt: 1,
            }),
            msg({
              id: "a1",
              role: "assistant",
              text: "Looks clean",
              createdAt: 2,
            }),
            msg({
              id: "u2",
              role: "user",
              text: "Also check last week",
              createdAt: 3,
            }),
          ],
        }),
      },
    }),
  };
}

async function openThreadMenu(m: Awaited<ReturnType<typeof boot>>) {
  const menuBtn = m
    .queryAll("button")
    .find((b) => b.getAttribute("aria-label") === "Thread actions");
  assert.ok(menuBtn, "Thread actions menu must be present");
  await m.click(menuBtn as HTMLElement);
}

describe("repeat-thread schedule wiring", () => {
  it("lands on automations with the form prefilled from the first user prompt", async () => {
    const { fake } = finishedThread();
    const m = await boot(fake);
    await openThreadMenu(m);

    const item = m.query("[data-repeat-schedule]");
    assert.ok(item, "Schedule this prompt… must be in the overflow");
    await m.click(item);

    assert.ok(m.query("[data-automations]"), "must switch to automations");
    const name = m.query(
      '[data-automation-create] [name="name"]',
    ) as HTMLInputElement | null;
    const prompt = m.query(
      '[data-automation-create] [name="prompt"]',
    ) as HTMLTextAreaElement | null;
    const provider = m.query(
      '[data-automation-create] [name="provider"]',
    ) as HTMLSelectElement | null;
    const model = m.query(
      "[data-automation-model]",
    ) as HTMLInputElement | HTMLSelectElement | null;
    const projectSelect = m.query(
      '[data-automation-create] [name="projectId"]',
    ) as HTMLSelectElement | null;
    assert.ok(name && prompt && provider && model && projectSelect);
    assert.equal(name.value, "Nightly review");
    assert.equal(prompt.value, "Review the ledger for anomalies");
    assert.equal(provider.value, "claude");
    assert.equal(model.value, "opus");
    assert.equal(projectSelect.value, "p1");
    m.unmount();
  });
});

describe("repeat-thread distill wiring", () => {
  it("calls runs.distill and opens the workflows editor with the returned phases", async () => {
    const { fake } = finishedThread();
    const m = await boot(fake);
    await openThreadMenu(m);

    const item = m.query("[data-distill-workflow]");
    assert.ok(item, "Distill into workflow… must be in the overflow");
    await m.click(item);

    const calls = fake.of("runs.distill");
    assert.equal(calls.length, 1, "must call runs.distill once");
    assert.deepEqual(calls[0]!.args[0], { threadId: "t-done" });

    const dialog = m.query('[aria-label="Manage workflows"]');
    assert.ok(dialog, "workflows editor must open");
    const values = m
      .queryAll("input")
      .map((el) => (el as HTMLInputElement).value);
    assert.ok(
      values.includes("Distilled workflow"),
      `name must be prefilled, got: ${JSON.stringify(values)}`,
    );
    assert.ok(
      values.includes("replay"),
      `returned phase must be in the editor, got: ${JSON.stringify(values)}`,
    );
    m.unmount();
  });
});
