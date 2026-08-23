/**
 * TerminalPane cursor bookkeeping (#147). The main process hands back a
 * DELTA plus an absolute cursor; the pane has to append deltas, replace on
 * reset, and never send a stale cursor after switching threads.
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { useState } from "react";
import { mount, unmountAll } from "./support/dom.ts";
import { TerminalPane, type TerminalApi } from "../src/components/TerminalPane";
import type { TerminalState } from "../src/shared/ipc";

afterEach(unmountAll);

function state(over: Partial<TerminalState> = {}): TerminalState {
  return {
    running: false,
    cwd: "/tmp/wt",
    shell: "/bin/zsh",
    cursor: 0,
    text: "",
    pending: "",
    reset: false,
    startedAt: 0,
    ...over,
  };
}

/** Records every cursor the pane sends back, overrides included. */
function api(over: Partial<TerminalApi> = {}) {
  const calls: { call: string; threadId: string; since?: number }[] = [];
  const idle = async () => state();
  return {
    calls,
    api: {
      open: async (threadId) => {
        calls.push({ call: "open", threadId });
        return over.open ? over.open(threadId) : state({ reset: true });
      },
      write: async (threadId, data, since) => {
        calls.push({ call: "write", threadId, since });
        return over.write ? over.write(threadId, data, since) : idle();
      },
      read: async (threadId, since) => {
        calls.push({ call: "read", threadId, since });
        return over.read ? over.read(threadId, since) : idle();
      },
      close: async (threadId) => {
        calls.push({ call: "close", threadId });
        return over.close ? over.close(threadId) : idle();
      },
    } satisfies TerminalApi,
  };
}

describe("TerminalPane", () => {
  it("shows the cwd and the shell from the opened session", async () => {
    const { api: a } = api({
      open: async () =>
        state({ running: true, cwd: "/tmp/wt/thread-a", reset: true }),
    });
    const m = await mount(<TerminalPane threadId="t1" api={a} />);
    await m.flush();
    assert.ok(m.text().includes("/tmp/wt/thread-a"), "cwd is visible");
    assert.ok(m.text().includes("/bin/zsh"), "shell is visible");
    m.unmount();
  });

  it("appends deltas and sends the cursor back on the next call", async () => {
    const { calls, api: a } = api({
      open: async () => state({ text: "first\n", cursor: 6, reset: true }),
      write: async () => state({ text: "$ echo two\n", cursor: 17 }),
    });
    const m = await mount(<TerminalPane threadId="t1" api={a} />);
    await m.flush();
    assert.equal(m.query("[data-terminal-output]")!.textContent, "first\n");

    await m.type(m.query("[data-terminal-input]"), "echo two");
    await m.press(m.query("[data-terminal-input]"), "Enter");
    await m.flush();

    assert.equal(
      m.query("[data-terminal-output]")!.textContent,
      "first\n$ echo two\n",
      "delta is appended, not replaced",
    );
    const write = calls.find((c) => c.call === "write");
    assert.equal(write?.since, 6, "the cursor from open is sent back");
    m.unmount();
  });

  it("replaces the buffer when the session says reset", async () => {
    let opened = 0;
    const { api: a } = api({
      open: async () => {
        opened += 1;
        return opened === 1
          ? state({ text: "stale\n", cursor: 6, reset: true })
          : state({ text: "fresh\n", cursor: 6, reset: true });
      },
    });
    const m = await mount(<TerminalPane threadId="t1" api={a} />);
    await m.flush();
    await m.click(m.query("[data-terminal-restart]"));
    await m.flush();
    assert.equal(
      m.query("[data-terminal-output]")!.textContent,
      "fresh\n",
      "a reset replaces the scrollback instead of doubling it",
    );
    m.unmount();
  });

  it("re-opens on a thread switch and does not carry the old cursor", async () => {
    const { calls, api: a } = api({
      open: async (threadId) =>
        state({ text: `${threadId}\n`, cursor: 40, reset: true }),
    });
    function Harness() {
      const [id, setId] = useState("t1");
      return (
        <>
          <button type="button" data-go="" onClick={() => setId("t2")}>
            switch
          </button>
          <TerminalPane threadId={id} api={a} />
        </>
      );
    }
    const m = await mount(<Harness />);
    await m.flush();
    await m.click(m.query("[data-go]"));
    await m.flush();

    assert.deepEqual(
      calls.filter((c) => c.call === "open").map((c) => c.threadId),
      ["t1", "t2"],
      "one open per thread",
    );
    assert.equal(
      m.query("[data-terminal-output]")!.textContent,
      "t2\n",
      "the previous thread's scrollback is dropped",
    );
    m.unmount();
  });

  it("recalls the previous command with ArrowUp", async () => {
    const { api: a } = api();
    const m = await mount(<TerminalPane threadId="t1" api={a} />);
    await m.flush();
    const input = m.query("[data-terminal-input]") as HTMLInputElement;
    await m.type(input, "npm test");
    await m.press(input, "Enter");
    await m.flush();
    assert.equal(input.value, "", "submitting clears the draft");

    await m.press(input, "ArrowUp");
    await m.flush();
    assert.equal(input.value, "npm test", "ArrowUp recalls the last command");
    m.unmount();
  });
});
