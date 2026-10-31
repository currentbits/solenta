"use strict";

/**
 * Sidebar audio indicator (#1807): the guest webContents' audio state maps
 * onto a push ({ threadId, audible, muted }), and setAudioMuted mutes it.
 * Run: node --test electron/test/preview-audio.test.js
 */
const { describe, it, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const preview = require("../preview.js");

function fakeWebContents(over = {}) {
  const state = {
    url: "about:blank",
    title: "",
    destroyed: false,
    audible: over.audible ?? false,
    muted: over.muted ?? false,
    handlers: {},
  };
  const wc = {
    isDestroyed: () => state.destroyed,
    getURL: () => state.url,
    getTitle: () => state.title,
    canGoBack: () => false,
    canGoForward: () => false,
    isCurrentlyAudible: () => state.audible,
    isAudioMuted: () => state.muted,
    setAudioMuted: (m) => {
      state.muted = Boolean(m);
    },
    session: {},
    setWindowOpenHandler: () => {},
    _state: state,
  };
  if (over.withEvents !== false) {
    wc.on = (ev, fn) => {
      (state.handlers[ev] ||= []).push(fn);
    };
    wc.once = (ev, fn) => {
      (state.handlers[ev] ||= []).push(fn);
    };
    wc.removeListener = (ev, fn) => {
      state.handlers[ev] = (state.handlers[ev] || []).filter((f) => f !== fn);
    };
    wc.emit = (ev, ...args) => {
      for (const fn of state.handlers[ev] || []) fn(...args);
    };
  }
  return wc;
}

describe("preview audio indicator (#1807)", () => {
  beforeEach(() => {
    preview.resetForTests();
  });

  it("pushes the initial state on bind, then on audio-state-changed", () => {
    const wc = fakeWebContents({ audible: false });
    preview.setWebContentsLookup(() => wc);
    const pushes = [];
    preview.setAudioPush((threadId, s) => pushes.push({ threadId, ...s }));

    preview.bind({ threadId: "t1", webContentsId: 7 });
    assert.deepEqual(pushes, [{ threadId: "t1", audible: false, muted: false }]);

    wc.emit("audio-state-changed", {}, true);
    assert.deepEqual(pushes.at(-1), { threadId: "t1", audible: true, muted: false });

    wc.emit("audio-state-changed", {}, false);
    assert.deepEqual(pushes.at(-1), { threadId: "t1", audible: false, muted: false });
  });

  it("stops listening once the session detaches (unbind)", () => {
    const wc = fakeWebContents();
    preview.setWebContentsLookup(() => wc);
    const pushes = [];
    preview.setAudioPush((threadId, s) => pushes.push({ threadId, ...s }));
    preview.bind({ threadId: "t1", webContentsId: 7 });
    preview.unbind({ threadId: "t1" });

    pushes.length = 0;
    wc.emit("audio-state-changed", {}, true);
    assert.deepEqual(pushes, [], "detached session must not keep pushing");
  });

  it("setAudioMuted calls webContents.setAudioMuted and pushes immediately", () => {
    const wc = fakeWebContents();
    preview.setWebContentsLookup(() => wc);
    const pushes = [];
    preview.setAudioPush((threadId, s) => pushes.push({ threadId, ...s }));
    preview.bind({ threadId: "t1", webContentsId: 7 });

    const result = preview.setAudioMuted({ threadId: "t1", muted: true });
    assert.deepEqual(result, { ok: true, muted: true });
    assert.equal(wc._state.muted, true);
    assert.deepEqual(pushes.at(-1), { threadId: "t1", audible: false, muted: true });

    preview.setAudioMuted({ threadId: "t1", muted: false });
    assert.equal(wc._state.muted, false);
    assert.deepEqual(pushes.at(-1), { threadId: "t1", audible: false, muted: false });
  });

  it("setAudioMuted throws when the pane is not bound", () => {
    assert.throws(
      () => preview.setAudioMuted({ threadId: "ghost", muted: true }),
      /Browser pane is not open/,
    );
  });

  it("falls back to polling isCurrentlyAudible when the host cannot emit audio-state-changed", (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const wc = fakeWebContents({ withEvents: false, audible: false });
    preview.setWebContentsLookup(() => wc);
    const pushes = [];
    preview.setAudioPush((threadId, s) => pushes.push({ threadId, ...s }));

    preview.bind({ threadId: "t1", webContentsId: 7 });
    assert.deepEqual(pushes, [{ threadId: "t1", audible: false, muted: false }]);

    wc._state.audible = true;
    t.mock.timers.tick(1000);
    assert.deepEqual(pushes.at(-1), { threadId: "t1", audible: true, muted: false });

    // No change: no extra push.
    const before = pushes.length;
    t.mock.timers.tick(1000);
    assert.equal(pushes.length, before);
  });
});
