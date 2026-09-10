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
import { inAct, mount, unmountAll } from "./support/dom.ts";
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

function deferred() {
  let resolve!: (value: TerminalState) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<TerminalState>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
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
  for (const boundary of ["thread switch", "restart"] as const) {
    for (const operation of ["read", "write"] as const) {
      it(`ignores a delayed ${operation} after ${boundary}`, async (t) => {
        t.mock.timers.enable({ apis: ["setInterval"] });
        const old = deferred();
        let opened = 0;
        let reads = 0;
        const { calls, api: a } = api({
          open: async () => ++opened === 1
            ? state({ running: true, text: "old output\n", cursor: 11, reset: true })
            : state({ running: true, text: "new\n", cursor: 4, pending: "new pending", cwd: "/new", reset: true }),
          read: async () => operation === "read" && ++reads === 1
            ? old.promise
            : state({ running: true, text: "next\n", cursor: 9, cwd: "/new" }),
          write: () => old.promise,
        });
        const m = await mount(<TerminalPane threadId="t1" api={a} />);
        if (operation === "read") {
          await inAct(() => t.mock.timers.tick(250));
        } else {
          await m.type(m.query("[data-terminal-input]"), "old command");
          await m.press(m.query("[data-terminal-input]"), "Enter");
        }
        assert.equal(calls.find((c) => c.call === operation)?.since, 11);
        if (boundary === "restart") {
          await m.click(m.query("[data-terminal-restart]"));
        } else {
          await m.rerender(<TerminalPane threadId="t2" api={a} />);
        }
        await inAct(() => old.resolve(state({ text: "stale\n", cursor: 17, pending: "old pending", cwd: "/old" })));
        assert.equal(m.query("[data-terminal-output]")!.textContent, "new\nnew pending");
        assert.ok(m.text().includes("/new"));
        assert.equal(m.query("[data-running]")!.getAttribute("data-running"), "true");
        await inAct(() => t.mock.timers.tick(250));
        assert.deepEqual(calls.at(-1), { call: "read", threadId: boundary === "restart" ? "t1" : "t2", since: 4 });
        assert.equal(m.query("[data-terminal-output]")!.textContent, "new\nnext\n");
      });
    }
  }

  it("invalidates old replies as soon as restart begins and preserves the next command", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const read = deferred();
    const write = deferred();
    const close = deferred();
    const open = deferred();
    let opened = 0;
    let written = 0;
    const { calls, api: a } = api({
      open: () => ++opened === 1
        ? Promise.resolve(state({ running: true, text: "old\n", cursor: 4, reset: true }))
        : open.promise,
      read: () => read.promise,
      write: async (_id, data) => ++written === 1
        ? write.promise
        : state({ running: true, text: `$ ${data}\n`, cursor: 10 }),
      close: () => close.promise,
    });
    const m = await mount(<TerminalPane threadId="t1" api={a} />);
    await inAct(() => t.mock.timers.tick(250));
    await m.press(m.query("[data-terminal-input]"), "Enter");
    await m.click(m.query("[data-terminal-restart]"));
    await inAct(() => {
      read.resolve(state({ running: true, text: "stale read\n", cursor: 15 }));
      write.resolve(state({ running: true, text: "stale write\n", cursor: 16 }));
    });
    assert.ok(!m.query("[data-terminal-output]")!.textContent!.includes("stale"));
    await m.type(m.query("[data-terminal-input]"), "pwd");
    await m.press(m.query("[data-terminal-input]"), "Enter");
    await inAct(() => t.mock.timers.tick(500));
    assert.equal(written, 1, "commands wait for restart without being discarded");
    assert.equal(calls.filter((c) => c.call === "read").length, 1, "polling pauses during restart");
    assert.equal((m.query("[data-terminal-input]") as HTMLInputElement).value, "pwd");
    await inAct(() => close.resolve(state()));
    await inAct(() => open.resolve(state({ running: true, text: "new\n", cursor: 4, reset: true })));
    await m.press(m.query("[data-terminal-input]"), "Enter");
    assert.deepEqual(calls.at(-1), { call: "write", threadId: "t1", since: 4 });
    assert.equal(m.query("[data-terminal-output]")!.textContent, "new\n$ pwd\n");
    await m.press(m.query("[data-terminal-input]"), "ArrowUp");
    assert.equal((m.query("[data-terminal-input]") as HTMLInputElement).value, "pwd");
  });

  for (const stage of ["close", "open"] as const) {
    for (const boundary of ["switch", "unmount", "restart"] as const) {
      it(`abandons a restart waiting for ${stage} after ${boundary}`, async () => {
        const delayed = deferred();
        let opened = 0;
        let closed = 0;
        const { calls, api: a } = api({
          open: async () => {
            opened += 1;
            if (stage === "open" && opened === 2) return delayed.promise;
            return state({ text: `session ${opened}\n`, cursor: 10, reset: true });
          },
          close: async () => ++closed === 1 && stage === "close" ? delayed.promise : state(),
        });
        const m = await mount(<TerminalPane threadId="t1" api={a} />);
        await m.click(m.query("[data-terminal-restart]"));
        if (boundary === "switch") await m.rerender(<TerminalPane threadId="t2" api={a} />);
        else if (boundary === "unmount") m.unmount();
        else await m.click(m.query("[data-terminal-restart]"));
        const before = m.query("[data-terminal-output]")?.textContent;
        const count = calls.length;
        await inAct(() => delayed.resolve(state({ text: "obsolete\n", cursor: 99, reset: true })));
        assert.equal(calls.length, count, "a stale close must not open another shell");
        assert.equal(m.query("[data-terminal-output]")?.textContent, before);
      });
    }
  }

  for (const rejected of [false, true]) {
    it(`ignores an initial open ${rejected ? "failure" : "reply"} superseded by restart`, async () => {
      const old = deferred();
      let opened = 0;
      const { api: a } = api({
        open: async () => ++opened === 1 ? old.promise : state({ text: "new\n", cursor: 4, reset: true }),
      });
      const m = await mount(<TerminalPane threadId="t1" api={a} />);
      await m.click(m.query("[data-terminal-restart]"));
      await inAct(() => {
        if (rejected) old.reject(new Error("old open failed"));
        else old.resolve(state({ text: "old\n", cursor: 100, reset: true }));
      });
      assert.equal(m.query("[data-terminal-output]")!.textContent, "new\n");
    });
  }

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
