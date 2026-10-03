import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { mount, unmountAll } from "./support/dom.ts";
import { InputPrompt } from "../src/components/InputPrompt";
import { act } from "react";
import type { PendingPermissionInfo } from "../src/shared/ipc";

afterEach(unmountAll);

const pending: PendingPermissionInfo = {
  requestId: "input-1", toolName: "mcp__example", summary: "Input requested", input: "",
  inputRequest: { source: "example", message: "Export settings", fields: [
    { name: "count", title: "Count", type: "integer", minimum: 1, maximum: 5, required: true, default: 2 },
    { name: "enabled", title: "Enabled", type: "boolean", required: true, default: false },
    { name: "color", title: "Color", type: "string", required: true, options: [{ value: "#f00", label: "Red" }] },
    { name: "secret", title: "Secret answer", type: "string", required: true, secret: true },
  ] },
};

it("reviews defaults, sends typed values only on submit, and masks secret input", async () => {
  const calls: unknown[] = [];
  const v = await mount(<InputPrompt pending={pending} onRespond={(...args) => { calls.push(args); }} />);
  assert.match(v.text(), /example/);
  assert.deepEqual(calls, []);
  assert.equal(v.query('input[name="secret"]')?.getAttribute("type"), "password");
  await v.change(v.query('select[name="color"]'), "0");
  await v.type(v.query('input[name="secret"]'), "private-answer");
  await v.click(v.byText("Send answers"));
  assert.deepEqual(calls, [["allow", { count: 2, enabled: false, color: "#f00", secret: "private-answer" }]]);
});

it("keeps failed answers editable and offers distinct decline/cancel", async () => {
  const calls: string[] = [];
  const v = await mount(<InputPrompt pending={{ ...pending, inputRequest: { source: "server", message: "Confirm?", fields: [] } }}
    onRespond={async (decision) => { calls.push(decision); throw new Error("Request expired"); }} />);
  await v.click(v.byText("Send answers"));
  assert.match(v.query('[role="alert"]')?.textContent || "", /Request expired/);
  await v.click(v.byText("Decline"));
  await v.click(v.byText("Cancel"));
  assert.deepEqual(calls, ["allow", "deny", "cancel"]);
});

it("preserves enum values, array selections, optional omissions and explicit false", async () => {
  const calls: unknown[] = [];
  const v = await mount(<InputPrompt pending={{ ...pending, inputRequest: { source: "server", message: "Settings", fields: [
    { name: "tags", title: "Tags", type: "array", required: true, options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }] },
    { name: "empty", title: "Empty value", type: "string", required: true, options: [{ value: "", label: "None" }] },
    { name: "flag", title: "Flag", type: "boolean", required: true },
    { name: "optional", title: "Optional", type: "string", required: false },
  ] } }} onRespond={(...args) => { calls.push(args); }} />);
  const select = v.query('select[name="tags"]') as HTMLSelectElement;
  await act(async () => {
    for (const option of select.options) option.selected = true;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await v.change(v.query('select[name="empty"]'), "0");
  await v.change(v.query('select[name="flag"]'), "false");
  await v.click(v.byText("Send answers"));
  assert.deepEqual(calls, [["allow", { tags: ["a", "b"], empty: "", flag: false }]]);
});

it("shows the external host and never navigates or approves URL requests on mount", async () => {
  const calls: unknown[] = [];
  const v = await mount(<InputPrompt pending={{ ...pending, inputRequest: { source: "server", message: "Connect account", fields: [], url: "https://login.example.com/auth" } }}
    onRespond={(...args) => { calls.push(args); }} />);
  const link = v.query('a[href="https://login.example.com/auth"]');
  assert.ok(link);
  assert.match(link.textContent || "", /login.example.com/);
  assert.equal(link.getAttribute("rel"), "noopener noreferrer");
  assert.deepEqual(calls, []);
});
