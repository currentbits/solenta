"use strict";

/**
 * Windows/Linux close-to-tray (#1807). macOS is unaffected (it already
 * stays in the dock on window close). shouldHideOnClose/trayMenuTemplate
 * are pure; createTray is exercised with an injected fake Tray/Menu.
 * Run: node --test electron/test/tray.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { shouldHideOnClose, trayMenuTemplate, createTray } = require("../tray.js");

describe("shouldHideOnClose (#1807)", () => {
  it("hides when the setting is on, on win32", () => {
    assert.equal(
      shouldHideOnClose({ platform: "win32", closeToTray: true }),
      true,
    );
  });

  it("hides when the setting is on, on linux", () => {
    assert.equal(
      shouldHideOnClose({ platform: "linux", closeToTray: true }),
      true,
    );
  });

  it("quits normally when the setting is off", () => {
    assert.equal(
      shouldHideOnClose({ platform: "win32", closeToTray: false }),
      false,
    );
  });

  it("never hides on macOS even if the setting is somehow on", () => {
    assert.equal(
      shouldHideOnClose({ platform: "darwin", closeToTray: true }),
      false,
    );
  });

  it("a real quit in progress always bypasses hide", () => {
    assert.equal(
      shouldHideOnClose({ platform: "win32", closeToTray: true, shuttingDown: true }),
      false,
    );
  });
});

describe("trayMenuTemplate (#1807)", () => {
  it("has Show Solenta, a running-threads count, and Quit", () => {
    const onShow = () => {};
    const onQuit = () => {};
    const items = trayMenuTemplate({ runningCount: 2, onShow, onQuit });
    assert.equal(items[0].label, "Show Solenta");
    assert.equal(items[0].click, onShow);
    assert.equal(items[1].label, "2 running threads");
    assert.equal(items[1].enabled, false);
    assert.equal(items.at(-1).label, "Quit");
    assert.equal(items.at(-1).click, onQuit);
  });

  it("singularizes a count of one", () => {
    const items = trayMenuTemplate({ runningCount: 1, onShow: () => {}, onQuit: () => {} });
    assert.equal(items[1].label, "1 running thread");
  });

  it("still reports zero running threads", () => {
    const items = trayMenuTemplate({ runningCount: 0, onShow: () => {}, onQuit: () => {} });
    assert.equal(items[1].label, "0 running threads");
  });
});

function fakeTrayCtor(calls) {
  return class FakeTray {
    constructor(iconPath) {
      calls.push({ op: "new", iconPath });
      this.listeners = {};
    }
    setToolTip(s) {
      calls.push({ op: "setToolTip", s });
    }
    setContextMenu(m) {
      calls.push({ op: "setContextMenu", m });
    }
    on(ev, fn) {
      this.listeners[ev] = fn;
      calls.push({ op: "on", ev });
    }
    destroy() {
      calls.push({ op: "destroy" });
    }
  };
}

const fakeMenu = { buildFromTemplate: (t) => t };

describe("createTray (#1807)", () => {
  it("builds the icon, sets a tooltip, and wires click to onShow", () => {
    const calls = [];
    let running = 3;
    const onShow = () => {};
    const onQuit = () => {};
    const ctrl = createTray({
      Tray: fakeTrayCtor(calls),
      Menu: fakeMenu,
      iconPath: "/tmp/icon.ico",
      getRunningCount: () => running,
      onShow,
      onQuit,
    });
    assert.equal(calls[0].op, "new");
    assert.equal(calls[0].iconPath, "/tmp/icon.ico");
    assert.ok(calls.some((c) => c.op === "setToolTip" && c.s === "Solenta"));
    const firstMenuCall = calls.find((c) => c.op === "setContextMenu");
    assert.ok(firstMenuCall);
    assert.equal(firstMenuCall.m[1].label, "3 running threads");

    // refresh() rebuilds with a fresh count, so right-click never shows stale data.
    running = 5;
    ctrl.refresh();
    const menuCalls = calls.filter((c) => c.op === "setContextMenu");
    assert.equal(menuCalls.at(-1).m[1].label, "5 running threads");

    ctrl.tray.listeners.click();
    ctrl.destroy();
    assert.ok(calls.some((c) => c.op === "destroy"));
  });

  it("right-click refreshes the menu before showing it", () => {
    const calls = [];
    let running = 0;
    const ctrl = createTray({
      Tray: fakeTrayCtor(calls),
      Menu: fakeMenu,
      iconPath: "/tmp/icon.png",
      getRunningCount: () => running,
      onShow: () => {},
      onQuit: () => {},
    });
    running = 9;
    ctrl.tray.listeners["right-click"]();
    const menuCalls = calls.filter((c) => c.op === "setContextMenu");
    assert.equal(menuCalls.at(-1).m[1].label, "9 running threads");
  });
});
