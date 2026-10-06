/**
 * TerminalPane (#147, #1493): xterm wiring, pushed-output bookkeeping,
 * splits and restart. xterm itself needs real layout, so a fake stands in
 * for it; the main-process side has its own tests in electron/test.
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { inAct, mount, unmountAll } from "./support/dom.ts";
import {
  TerminalPane,
  type TerminalApi,
  type XtermLike,
} from "../src/components/TerminalPane";
import type { TerminalDataPush, TerminalState } from "../src/shared/ipc";

afterEach(unmountAll);

function state(over: Partial<TerminalState> = {}): TerminalState {
  return {
    termId: "1",
    running: true,
    pty: true,
    cwd: "/tmp/wt",
    shell: "/bin/zsh",
    cursor: 0,
    text: "",
    reset: false,
    startedAt: 0,
    staleRoot: false,
    ...over,
  };
}

class FakeTerm implements XtermLike {
  cols = 91;
  rows = 17;
  options: { theme?: Record<string, string> } = {};
  screen = "";
  disposed = false;
  focused = false;
  selection = "";
  dataCb: (d: string) => void = () => {};
  resizeCb: (s: { cols: number; rows: number }) => void = () => {};
  keyHandler: (e: KeyboardEvent) => boolean = () => true;
  open() {}
  write(d: string) {
    this.screen += d;
  }
  reset() {
    this.screen = "";
  }
  focus() {
    this.focused = true;
  }
  dispose() {
    this.disposed = true;
  }
  fit() {}
  hasSelection() {
    return this.selection !== "";
  }
  getSelection() {
    return this.selection;
  }
  onData(cb: (d: string) => void) {
    this.dataCb = cb;
    return { dispose() {} };
  }
  onResize(cb: (s: { cols: number; rows: number }) => void) {
    this.resizeCb = cb;
    return { dispose() {} };
  }
  attachCustomKeyEventHandler(fn: (e: KeyboardEvent) => boolean) {
    this.keyHandler = fn;
  }
}

function harness(over: Partial<TerminalApi> = {}) {
  const calls: { call: string; input: Record<string, unknown> }[] = [];
  const terms: FakeTerm[] = [];
  const listeners = new Set<(p: TerminalDataPush) => void>();
  const rec = <T,>(call: string, input: object, value: T | Promise<T>) => {
    calls.push({ call, input: input as Record<string, unknown> });
    return Promise.resolve(value);
  };
  const api: TerminalApi = {
    open: (input) =>
      over.open ? (calls.push({ call: "open", input }), over.open(input)) : rec("open", input, state({ termId: input.termId ?? "1" })),
    write: (input) => rec("write", input, { ok: true }),
    resize: (input) => rec("resize", input, { ok: true }),
    read: (input) => (over.read ? (calls.push({ call: "read", input }), over.read(input)) : rec("read", input, state())),
    list: (input) => (over.list ? over.list(input) : rec("list", input, [] as string[])),
    close: (input) => rec("close", input, state({ running: false })),
    onData: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  const load = async () => () => {
    const t = new FakeTerm();
    terms.push(t);
    return t;
  };
  const push = (p: Partial<TerminalDataPush>) =>
    inAct(() => {
      for (const cb of listeners) {
        cb({ threadId: "t1", termId: "1", from: 0, data: "", cursor: 0, running: true, ...p });
      }
    });
  return { api, load, calls, terms, push, listeners };
}

const settle = () => inAct(() => new Promise((r) => setTimeout(r, 0)));

describe("TerminalPane", () => {
  it("opens at the xterm's size and paints the replayed scrollback", async () => {
    const h = harness({ open: async () => state({ text: "old\r\n$ ", cursor: 7 }) });
    const m = await mount(<TerminalPane threadId="t1" api={h.api} load={h.load} />);
    await settle();
    const open = h.calls.find((c) => c.call === "open");
    assert.deepEqual(open?.input, { threadId: "t1", termId: "1", cols: 91, rows: 17 });
    assert.equal(h.terms[0].screen, "old\r\n$ ");
    assert.equal(h.terms[0].focused, true);
    assert.ok(m.query("[data-terminal-output][role=region]"));
    assert.equal(m.query("[data-running]")!.getAttribute("data-running"), "true");
  });

  it("sends raw keystrokes and resizes to the shell", async () => {
    const h = harness();
    await mount(<TerminalPane threadId="t1" api={h.api} load={h.load} />);
    await settle();
    await inAct(() => h.terms[0].dataCb("ls\r"));
    await inAct(() => h.terms[0].resizeCb({ cols: 120, rows: 40 }));
    assert.deepEqual(h.calls.find((c) => c.call === "write")?.input, { threadId: "t1", termId: "1", data: "ls\r" });
    assert.deepEqual(h.calls.find((c) => c.call === "resize")?.input, {
      threadId: "t1",
      termId: "1",
      cols: 120,
      rows: 40,
    });
  });

  it("appends pushed output once, skips overlap and other terminals, re-reads a gap", async () => {
    const h = harness({
      open: async () => state({ text: "ab", cursor: 2 }),
      read: async (input) => {
        assert.equal(input.since, 4, "re-read from the last consumed offset");
        return state({ text: "efgh", cursor: 8 });
      },
    });
    const m = await mount(<TerminalPane threadId="t1" api={h.api} load={h.load} />);
    await settle();
    const t = h.terms[0];
    await h.push({ from: 2, data: "cd", cursor: 4 });
    await h.push({ from: 1, data: "bcd", cursor: 4 }); // already seen
    await h.push({ termId: "2", from: 4, data: "XX", cursor: 6 });
    await h.push({ threadId: "t2", from: 4, data: "YY", cursor: 6 });
    assert.equal(t.screen, "abcd");
    await h.push({ from: 6, data: "gh", cursor: 8 }); // 4..6 missed
    await settle();
    assert.equal(t.screen, "abcdefgh");
    await h.push({ from: 8, data: "\r\n[exited]", cursor: 18, running: false });
    assert.equal(t.screen, "abcdefgh\r\n[exited]");
    assert.equal(m.query("[data-running]")!.getAttribute("data-running"), "false");
  });

  it("splits into a second terminal and closes it again", async () => {
    const h = harness();
    const m = await mount(<TerminalPane threadId="t1" api={h.api} load={h.load} />);
    await settle();
    assert.equal(m.query("[data-terminal-close]"), null, "the only terminal cannot be closed");
    await m.click(m.query("[data-terminal-split]"));
    await settle();
    assert.equal(m.queryAll("[data-terminal-view]").length, 2);
    assert.deepEqual(
      h.calls.filter((c) => c.call === "open").map((c) => c.input.termId),
      ["1", "2"],
    );
    await m.click(m.queryAll("[data-terminal-close]")[1]);
    assert.equal(m.queryAll("[data-terminal-view]").length, 1);
    assert.deepEqual(h.calls.find((c) => c.call === "close")?.input, { threadId: "t1", termId: "2" });
    assert.equal(h.terms[1].disposed, true);
  });

  it("caps splits at four", async () => {
    const h = harness({ list: async () => ["1", "2", "3"] });
    const m = await mount(<TerminalPane threadId="t1" api={h.api} load={h.load} />);
    await settle();
    await m.click(m.query("[data-terminal-split]"));
    await settle();
    assert.equal(m.queryAll("[data-terminal-view]").length, 4);
    assert.equal(m.query("[data-terminal-split]"), null);
  });

  it("reveal adds the Sign in shell and remounts it on each new nonce (#1501)", async () => {
    const h = harness();
    const el = (reveal: { nonce: number; termId: string; threadId: string } | null) => (
      <TerminalPane threadId="t1" api={h.api} load={h.load} reveal={reveal} />
    );
    const m = await mount(el(null));
    await settle();
    await m.rerender(el({ nonce: 1, termId: "signin", threadId: "t1" }));
    await settle();
    assert.deepEqual(
      m.queryAll("[data-terminal-view]").map((v) => v.getAttribute("data-terminal-view")),
      ["1", "signin"],
    );
    const before = h.terms.length;
    // A second Sign in restarts that shell in main: the view must re-attach.
    await m.rerender(el({ nonce: 2, termId: "signin", threadId: "t1" }));
    await settle();
    assert.equal(h.terms.length, before + 1, "fresh xterm for the fresh session");
    assert.equal(h.terms[before - 1].disposed, true);
    assert.equal(h.terms[0].disposed, false, "other splits are untouched");
  });

  it("a reveal that arrives before the terminal list still shows (#1501)", async () => {
    let answer: (ids: string[]) => void = () => {};
    const h = harness({ list: () => new Promise((r) => (answer = r)) });
    const m = await mount(
      <TerminalPane
        threadId="t1"
        api={h.api}
        load={h.load}
        reveal={{ nonce: 1, termId: "signin", threadId: "t1" }}
      />,
    );
    await inAct(async () => answer(["1"]));
    await settle();
    assert.deepEqual(
      m.queryAll("[data-terminal-view]").map((v) => v.getAttribute("data-terminal-view")),
      ["1", "signin"],
    );
  });

  it("an empty list with a reveal opens only the revealed shell", async () => {
    const h = harness();
    const m = await mount(
      <TerminalPane
        threadId="__signin__"
        api={h.api}
        load={h.load}
        reveal={{ nonce: 1, termId: "signin", threadId: "__signin__" }}
      />,
    );
    await settle();
    assert.deepEqual(
      m.queryAll("[data-terminal-view]").map((v) => v.getAttribute("data-terminal-view")),
      ["signin"],
    );
  });

  it("ignores a reveal meant for another thread", async () => {
    const h = harness();
    const m = await mount(
      <TerminalPane
        threadId="t2"
        api={h.api}
        load={h.load}
        reveal={{ nonce: 1, termId: "signin", threadId: "t1" }}
      />,
    );
    await settle();
    assert.deepEqual(
      m.queryAll("[data-terminal-view]").map((v) => v.getAttribute("data-terminal-view")),
      ["1"],
    );
  });

  it("restores the terminals main still knows about", async () => {
    const h = harness({ list: async () => ["1", "3"] });
    const m = await mount(<TerminalPane threadId="t1" api={h.api} load={h.load} />);
    await settle();
    assert.deepEqual(
      m.queryAll("[data-terminal-view]").map((el) => el.getAttribute("data-terminal-view")),
      ["1", "3"],
    );
  });

  it("restart closes the session and opens a fresh one in a new xterm", async () => {
    const h = harness();
    const m = await mount(<TerminalPane threadId="t1" api={h.api} load={h.load} />);
    await settle();
    await m.click(m.query("[data-terminal-restart]"));
    await settle();
    assert.deepEqual(
      h.calls.filter((c) => c.call !== "list").map((c) => c.call),
      ["open", "close", "open"],
    );
    assert.equal(h.terms[0].disposed, true);
    assert.equal(h.terms.length, 2);
  });

  it("drops a late open reply after switching threads", async () => {
    let release!: (s: TerminalState) => void;
    const h = harness({
      open: (input) =>
        input.threadId === "t1"
          ? new Promise<TerminalState>((r) => (release = r))
          : Promise.resolve(state({ text: "t2 shell", cursor: 8 })),
    });
    const m = await mount(<TerminalPane threadId="t1" api={h.api} load={h.load} />);
    await settle();
    await m.rerender(<TerminalPane threadId="t2" api={h.api} load={h.load} />);
    await settle();
    await inAct(() => release(state({ text: "t1 shell", cursor: 8 })));
    assert.equal(h.terms[0].disposed, true);
    assert.equal(h.terms[0].screen, "");
    assert.equal(h.terms[1].screen, "t2 shell");
  });

  it("explains a stale root and the no-PTY fallback", async () => {
    const h = harness({ open: async () => state({ staleRoot: true, pty: false }) });
    const m = await mount(<TerminalPane threadId="t1" api={h.api} load={h.load} />);
    await settle();
    assert.match(m.query("[data-terminal-stale]")!.textContent!, /Move to worktree/);
    assert.ok(m.query("[data-terminal-basic]"));
  });

  it("Move to worktree reopens with move at the xterm's size and re-attaches (#1512)", async () => {
    let stale = true;
    const h = harness({
      open: async (input) => {
        if (input.move) stale = false;
        return state({ staleRoot: stale });
      },
    });
    const m = await mount(<TerminalPane threadId="t1" api={h.api} load={h.load} />);
    await settle();
    await m.click(m.query("[data-terminal-move]"));
    await settle();
    const opens = h.calls.filter((c) => c.call === "open").map((c) => c.input);
    assert.deepEqual(opens[1], { threadId: "t1", termId: "1", cols: 91, rows: 17, move: true });
    assert.equal(opens.length, 3, "remounts onto the moved shell");
    assert.equal(h.calls.some((c) => c.call === "close"), false, "scrollback is not dropped");
    assert.equal(m.query("[data-terminal-stale]"), null);
  });

  it("Close session ends the shell without reopening it (#1512)", async () => {
    const h = harness();
    const m = await mount(<TerminalPane threadId="t1" api={h.api} load={h.load} />);
    await settle();
    await m.click(m.query("[data-terminal-end]"));
    await h.push({ from: 0, data: "\r\n[session closed]", cursor: 20, running: false });
    await settle();
    assert.deepEqual(h.calls.find((c) => c.call === "close")?.input, {
      threadId: "t1",
      termId: "1",
      keep: true,
    });
    assert.equal(h.calls.filter((c) => c.call === "open").length, 1, "no restart");
    assert.equal(h.terms[0].disposed, false, "scrollback stays on screen");
    assert.equal(m.query("[data-running]")!.getAttribute("data-running"), "false");
    assert.equal(m.query("[data-terminal-end]"), null);
  });

  it("copies a selection on Cmd+C and lets Ctrl+C reach the shell", async () => {
    const h = harness();
    await mount(<TerminalPane threadId="t1" api={h.api} load={h.load} />);
    await settle();
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (s: string) => void copied.push(s) },
      configurable: true,
    });
    const t = h.terms[0];
    const key = (over: Partial<KeyboardEvent>) =>
      ({ type: "keydown", key: "c", metaKey: false, ctrlKey: false, shiftKey: false, ...over }) as KeyboardEvent;
    assert.equal(t.keyHandler(key({ metaKey: true })), true, "no selection: pass through");
    t.selection = "hello";
    assert.equal(t.keyHandler(key({ metaKey: true })), false);
    assert.equal(t.keyHandler(key({ ctrlKey: true })), true, "plain Ctrl+C is SIGINT");
    assert.deepEqual(copied, ["hello"]);
  });
});
