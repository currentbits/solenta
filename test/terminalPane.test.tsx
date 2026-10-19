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
  findMatch,
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
  selCb: () => void = () => {};
  finds: [string, boolean][] = [];
  hits = true;
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
  select(text: string) {
    this.selection = text;
    this.selCb();
  }
  clear() {
    this.screen = "";
  }
  find(query: string, back: boolean) {
    this.finds.push([query, back]);
    return this.hits;
  }
  onSelectionChange(cb: () => void) {
    this.selCb = cb;
    return { dispose() {} };
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

  it("offers a fix for a failure in live output, never in replayed scrollback (#253)", async () => {
    const h = harness({
      open: async () => state({ text: "src/old.ts(1,1): error TS2304: stale\r\n$ ", cursor: 40 }),
    });
    const fixes: [string, string, string][] = [];
    const m = await mount(
      <TerminalPane threadId="t1" api={h.api} load={h.load} onFix={(...a) => fixes.push(a)} />,
    );
    await settle();
    assert.equal(m.query("[data-fix-suggestion]"), null, "restored scrollback is old news");
    await h.push({ from: 40, data: "$ npm test\r\n\x1b[31m FAIL \x1b[0m src/sum.test", cursor: 80 });
    await h.push({ from: 80, data: ".ts\r\n  expected 3, got 4\r\n", cursor: 120 });
    assert.equal(m.query("[data-fix-suggestion]")?.getAttribute("data-fix-suggestion"), "test");
    assert.match(m.query("[data-fix-suggestion] code")!.textContent!, /FAIL\s+src\/sum\.test\.ts/);
    await m.click(m.query("[data-fix-run]"));
    assert.equal(fixes.length, 1);
    const [action, threadId, prompt] = fixes[0];
    assert.equal(action, "run");
    assert.equal(threadId, "t1");
    assert.match(prompt, /^The terminal in this thread's worktree reported a test failure:/);
    assert.match(prompt, /expected 3, got 4/, "output after the failing line rides along");
    assert.doesNotMatch(prompt, /\x1b/);
    assert.equal(m.query("[data-fix-suggestion]"), null, "acting resolves the card");
    await h.push({ from: 120, data: " FAIL  src/sum.test.ts\r\n", cursor: 160 });
    assert.equal(m.query("[data-fix-suggestion]"), null, "a handled failure stays quiet");
    await h.push({ from: 160, data: "CONFLICT (content): Merge conflict in a.ts\r\n", cursor: 200 });
    assert.equal(m.query("[data-fix-suggestion]")?.getAttribute("data-fix-suggestion"), "conflict");
    await m.click(m.query("[data-fix-dismiss]"));
    assert.equal(m.query("[data-fix-suggestion]"), null);
    assert.equal(fixes.length, 1, "dismiss sends nothing");
  });

  it("offers nothing without an onFix handler", async () => {
    const h = harness();
    const m = await mount(<TerminalPane threadId="t1" api={h.api} load={h.load} />);
    await settle();
    await h.push({ from: 0, data: "a.ts(1,1): error TS2304: x\r\n", cursor: 30 });
    assert.equal(m.query("[data-fix-suggestion]"), null);
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

  it("sends only the selection to this thread's composer, never the buffer (#1185)", async () => {
    const h = harness({ open: async () => state({ text: "whole buffer", cursor: 12 }) });
    const sent: [string, string][] = [];
    const m = await mount(
      <TerminalPane threadId="t1" api={h.api} load={h.load} onAddToPrompt={(...a) => sent.push(a)} />,
    );
    await settle();
    const button = m.query("[data-terminal-send]") as HTMLButtonElement;
    assert.equal(button.getAttribute("aria-label"), "Send selection to composer");
    assert.equal(button.disabled, true, "nothing selected: disabled");
    assert.match(button.title, /Select output/);
    await inAct(() => h.terms[0].select(" FAIL  sum.test.ts\n  expected 3, got 4"));
    assert.equal(button.disabled, false);
    await m.click(button);
    assert.deepEqual(sent, [["t1", " FAIL  sum.test.ts\n  expected 3, got 4"]]);
    assert.equal(h.calls.some((c) => c.call === "write"), false, "nothing typed into the shell");
    assert.equal(m.query("[data-terminal-status]")!.textContent, "Added to composer");
    await inAct(() => h.terms[0].select(""));
    assert.equal(button.disabled, true);
  });

  it("has no send button without a composer to send to", async () => {
    const h = harness();
    const m = await mount(<TerminalPane threadId="t1" api={h.api} load={h.load} />);
    await settle();
    assert.equal(m.query("[data-terminal-send]"), null);
    assert.ok(m.query("[data-terminal-copy]"));
  });

  it("Copy writes the selection to the clipboard", async () => {
    const h = harness();
    const m = await mount(<TerminalPane threadId="t1" api={h.api} load={h.load} />);
    await settle();
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (s: string) => void copied.push(s) },
      configurable: true,
    });
    assert.equal((m.query("[data-terminal-copy]") as HTMLButtonElement).disabled, true);
    await inAct(() => h.terms[0].select("line"));
    await m.click(m.query("[data-terminal-copy]"));
    await settle();
    assert.deepEqual(copied, ["line"]);
    assert.equal(m.query("[data-terminal-status]")!.textContent, "Copied");
  });

  it("Clear wipes the display only; the shell keeps running and new output lands once", async () => {
    const h = harness({ open: async () => state({ text: "old\r\n$ ", cursor: 7 }) });
    const m = await mount(<TerminalPane threadId="t1" api={h.api} load={h.load} />);
    await settle();
    await m.click(m.query("[data-terminal-clear]"));
    assert.equal(h.terms[0].screen, "");
    await h.push({ from: 7, data: "new", cursor: 10 });
    await h.push({ from: 7, data: "new", cursor: 10 });
    assert.equal(h.terms[0].screen, "new");
    assert.equal(h.calls.some((c) => c.call === "close" || c.call === "write"), false);
    assert.equal(h.calls.filter((c) => c.call === "open").length, 1);
    assert.equal(m.query("[data-running]")!.getAttribute("data-running"), "true");
  });

  it("Find searches up on Enter, down on Shift+Enter, reports no matches, closes on Escape", async () => {
    const h = harness();
    const m = await mount(<TerminalPane threadId="t1" api={h.api} load={h.load} />);
    await settle();
    const toggle = m.query("[data-terminal-find]")!;
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    await m.click(toggle);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    const input = m.query("[data-terminal-findbar] input") as HTMLInputElement;
    assert.equal(document.activeElement, input, "focus lands in the field");
    assert.equal(input.getAttribute("aria-label"), "Find in terminal output");
    await m.type(input, "FAIL");
    await m.pressFocused("Enter");
    await m.pressFocused("Enter", { shiftKey: true });
    await m.click(m.query("[data-terminal-find-next]"));
    assert.deepEqual(h.terms[0].finds, [
      ["FAIL", true],
      ["FAIL", false],
      ["FAIL", false],
    ]);
    assert.equal(m.query("[data-terminal-status]")!.textContent, "");
    h.terms[0].hits = false;
    await m.click(m.query("[data-terminal-find-prev]"));
    assert.equal(m.query("[data-terminal-status]")!.textContent, "No matches");
    input.focus();
    await m.pressFocused("Escape");
    assert.equal(m.query("[data-terminal-findbar]"), null);
    assert.equal(m.query("[data-terminal-status]")!.textContent, "");
  });
});

describe("findMatch", () => {
  const lines = ["ok a", "FAIL one", "ok b", "fail two  FAIL"];
  it("starts at the bottom going up, the top going down, case-insensitive", () => {
    assert.deepEqual(findMatch(lines, "fail", null, true), { y: 3, x: 10 });
    assert.deepEqual(findMatch(lines, "fail", null, false), { y: 1, x: 0 });
  });
  it("steps from the last match and wraps", () => {
    assert.deepEqual(findMatch(lines, "fail", { y: 3, x: 10 }, true), { y: 3, x: 0 });
    assert.deepEqual(findMatch(lines, "fail", { y: 3, x: 0 }, true), { y: 1, x: 0 });
    assert.deepEqual(findMatch(lines, "fail", { y: 1, x: 0 }, true), { y: 3, x: 10 });
    assert.deepEqual(findMatch(lines, "fail", { y: 3, x: 10 }, false), { y: 1, x: 0 });
  });
  it("reports no matches and ignores an empty query", () => {
    assert.equal(findMatch(lines, "panic", null, true), null);
    assert.equal(findMatch(lines, "", null, true), null);
  });
});
