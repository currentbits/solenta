import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { mount, unmountAll } from "./support/dom.ts";
import { ConnectionsSection } from "../src/components/ConnectionsSection";

afterEach(() => {
  window.localStorage.removeItem("coder.remoteConnections");
  unmountAll();
});

it("saves an SSH host after connecting without persisting its web token", async () => {
  const calls: unknown[] = [];
  const m = await mount(<ConnectionsSection onOpen={async (input) => {
    calls.push(input);
    return { host: input.host, remotePort: input.remotePort ?? 4620, tokenSaved: false };
  }} />);
  await m.type(m.query("[data-connection-label]"), "Build machine");
  await m.type(m.query("[data-connection-host]"), "user@work");
  await m.type(m.query("[data-connection-token]"), "remote-secret");
  await m.click(m.query("[data-connection-open]"));
  assert.deepEqual(calls, [{
    host: "user@work", label: "Build machine", remotePort: 4620,
    token: "remote-secret", remember: true,
  }]);
  const saved = window.localStorage.getItem("coder.remoteConnections") || "";
  assert.match(saved, /user@work/);
  assert.doesNotMatch(saved, /remote-secret/);
  assert.equal((m.query("[data-connection-token]") as HTMLInputElement).value, "");
  m.unmount();
});

it("connects with a blank token and forgets the saved one with the host", async () => {
  const calls: unknown[] = [];
  const forgot: unknown[] = [];
  const m = await mount(<ConnectionsSection
    onOpen={async (input) => {
      calls.push(input);
      return { host: input.host, remotePort: input.remotePort ?? 4620, tokenSaved: true };
    }}
    onForget={async (input) => { forgot.push(input); }}
  />);
  await m.type(m.query("[data-connection-host]"), "user@work");
  await m.type(m.query("[data-connection-token]"), "remote-secret");
  await m.click(m.query("[data-connection-open]"));
  assert.match(m.container.textContent || "", /token saved/);
  await m.click(m.query("[data-connection-open]"));
  assert.equal((calls[1] as { token: string }).token, "");
  await m.click(m.query('[aria-label="Forget user@work"]'));
  assert.deepEqual(forgot, [{ host: "user@work", remotePort: 4620 }]);
  assert.doesNotMatch(window.localStorage.getItem("coder.remoteConnections") || "", /user@work/);
  m.unmount();
});
