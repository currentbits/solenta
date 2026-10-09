import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { mount, unmountAll } from "./support/dom.ts";
import { SecretPrompt } from "../src/components/SecretPrompt";
import type { PendingSecretCard } from "../src/shared/ipc";

afterEach(unmountAll);

const card: PendingSecretCard = { id: "s1", name: "DB_PASSWORD", prompt: "Staging database password", askedAt: 0 };

it("masks the value, gates submit on input, and sends it once (#1531)", async () => {
  const calls: unknown[] = [];
  const v = await mount(<SecretPrompt card={card} onAnswer={(value) => { calls.push(value); }} />);
  assert.match(v.text(), /DB_PASSWORD/);
  assert.match(v.text(), /Staging database password/);
  const input = v.query('input[type="password"]');
  assert.ok(input);
  assert.equal(input.getAttribute("autocomplete"), "off");
  assert.equal((v.byText("Provide secret") as HTMLButtonElement).disabled, true);
  await v.type(input, "hunter2");
  await v.click(v.byText("Provide secret"));
  await v.click(v.byText("Provide secret"));
  assert.deepEqual(calls, ["hunter2"]);
});

it("declines with null and shows a failed send for retry", async () => {
  const calls: unknown[] = [];
  const v = await mount(<SecretPrompt card={card}
    onAnswer={async (value) => { calls.push(value); throw new Error("No open secret request for this thread"); }} />);
  await v.click(v.byText("Decline"));
  assert.match(v.query('[role="alert"]')?.textContent || "", /No open secret request/);
  assert.deepEqual(calls, [null]);
});
