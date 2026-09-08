/**
 * Issue #941: a pending Add automation must not create a second host row.
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount, inAct } from "./support/dom.ts";
import {
  createFakeCoder,
  installFakeCoder,
  project,
  type FakeCoder,
} from "./support/fakeCoder.ts";
import App from "../src/App";
import { expandAgents } from "./support/expandAgents.ts";
import type { AutomationWrite } from "../src/shared/ipc";

async function boot(fake: FakeCoder) {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  return mount(<App />);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("Automations create wiring", () => {
  it("deferred create sends only one host row/request (issue #941)", async () => {
    const fake = createFakeCoder({
      projects: [project({ id: "p1", slug: "acme/ledger" })],
    });
    const origAdd = fake.api.automations.add;
    const held = deferred<void>();
    const started: unknown[] = [];
    fake.api.automations.add = (async (input: AutomationWrite) => {
      started.push(input);
      await held.promise;
      return origAdd(input);
    }) as typeof origAdd;

    const m = await boot(fake);
    try {
      await expandAgents(m);
      const pulse = m.query('[data-panel-tab="pulse"]');
      assert.ok(pulse, "Pulse tab");
      await m.click(pulse);
      const nav = m.query('[data-view-nav="automations"]');
      assert.ok(nav, "Automations nav");
      await m.click(nav);
      assert.ok(m.query("[data-automations]"), "automations view");

      await m.type(
        m.query('[data-automation-create] [name="name"]'),
        "Nightly",
      );
      await m.type(
        m.query('[data-automation-create] [name="prompt"]'),
        "review the repo",
      );

      const form = m.query("[data-automation-create]") as HTMLFormElement;
      const submit = m.query(
        "[data-automation-create] button[type=submit]",
      ) as HTMLButtonElement;
      await inAct(() => {
        form.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
        form.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      });
      await m.flush();
      assert.equal(started.length, 1, "same-tick double submit is one request");
      assert.equal(submit.disabled, true);

      await m.click(submit);
      await m.press(m.query('[data-automation-create] [name="name"]'), "Enter");
      await inAct(() => {
        form.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      });
      await m.flush();
      assert.equal(started.length, 1, "click or Enter must not start a second add");
      assert.equal(
        fake.of("automations.add").length,
        0,
        "host write stays deferred until the in-flight create finishes",
      );

      await inAct(() => held.resolve());
      await m.flush();

      assert.equal(started.length, 1, "only one in-flight add was started");
      assert.equal(
        fake.of("automations.add").length,
        1,
        "host records a single automations.add",
      );
      assert.equal(
        m.queryAll("[data-automation-row]").length,
        1,
        "only one host row is listed after the pending create finishes",
      );
    } finally {
      m.unmount();
    }
  });
});
