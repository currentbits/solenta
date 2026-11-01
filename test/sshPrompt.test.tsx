import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { inAct, mount, unmountAll } from "./support/dom.ts";
import { SshPromptDialog } from "../src/components/SshPromptDialog";
import type { SshPromptInfo } from "../src/shared/ipc";

function stubCoder() {
  const answers: unknown[] = [];
  let push: ((p: SshPromptInfo) => void) | null = null;
  (window as unknown as { coder: unknown }).coder = {
    app: {
      answerSshPrompt: async (input: unknown) => {
        answers.push(input);
      },
    },
    on: (channel: string, cb: (p: SshPromptInfo) => void) => {
      if (channel === "ssh:prompt") push = cb;
      return () => {};
    },
  };
  return { answers, push: (p: SshPromptInfo) => push?.(p) };
}

describe("SshPromptDialog", () => {
  afterEach(() => {
    unmountAll();
    if (typeof window !== "undefined") delete (window as unknown as { coder?: unknown }).coder;
  });

  it("sends a typed password, then trusts a new host key with yes", async () => {
    (await mount(<div />)).unmount();
    const coder = stubCoder();
    const m = await mount(<SshPromptDialog />);
    assert.equal(m.query("[data-ssh-prompt]"), null);

    await inAct(() => {
      coder.push({ id: "p1", host: "me@work", prompt: "me@work's password: ", kind: "password" });
      coder.push({
        id: "p2",
        host: "me@work",
        prompt: "ED25519 key fingerprint is SHA256:abc.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ",
        kind: "hostkey",
      });
    });
    await m.flush();
    assert.match(m.text(), /SSH to me@work/);
    const input = m.query("[data-ssh-prompt-input]") as HTMLInputElement;
    assert.equal(input.type, "password");
    await m.type(input, "hunter2");
    await m.click(m.query("[data-ssh-prompt-ok]") as HTMLElement);
    await m.flush();
    assert.deepEqual(coder.answers, [{ id: "p1", answer: "hunter2" }]);

    assert.match(m.text(), /Trust me@work\?/);
    assert.match(m.text(), /SHA256:abc/);
    assert.equal(m.query("[data-ssh-prompt-input]"), null);
    await m.click(m.query("[data-ssh-prompt-ok]") as HTMLElement);
    await m.flush();
    assert.deepEqual(coder.answers[1], { id: "p2", answer: "yes" });
    assert.equal(m.query("[data-ssh-prompt]"), null);
  });

  it("cancels with null", async () => {
    (await mount(<div />)).unmount();
    const coder = stubCoder();
    const m = await mount(<SshPromptDialog />);
    await inAct(() => coder.push({ id: "p3", host: "box", prompt: "Are you sure you want to continue connecting?", kind: "hostkey" }));
    await m.flush();
    await m.click(m.query("[data-ssh-prompt-cancel]") as HTMLElement);
    await m.flush();
    assert.deepEqual(coder.answers, [{ id: "p3", answer: null }]);
    assert.equal(m.query("[data-ssh-prompt]"), null);
  });
});
