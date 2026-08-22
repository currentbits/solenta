const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { appMenuTemplate } = require("../menu.js");

describe("app menu template (issue #353)", () => {
  it("installs an Edit menu with the clipboard roles", () => {
    const t = appMenuTemplate({ platform: "darwin" });
    const edit = t.find((m) => m.label === "Edit");
    assert.ok(edit, "Edit menu must exist or packaged builds lose Cmd+C/V");
    const roles = edit.submenu.map((i) => i.role);
    for (const role of ["undo", "redo", "cut", "copy", "paste", "selectAll"]) {
      assert.ok(roles.includes(role), `Edit menu needs the ${role} role`);
    }
  });

  it("leads with the app menu on macOS only", () => {
    const mac = appMenuTemplate({ platform: "darwin", appName: "Solenta" });
    assert.equal(mac[0].label, "Solenta");
    assert.ok(
      mac[0].submenu.some((i) => i.role === "quit"),
      "app menu needs the quit role",
    );
    const linux = appMenuTemplate({ platform: "linux" });
    assert.equal(linux[0].label, "Edit");
  });

  it("keeps reload, devtools, zoom, and fullscreen on View", () => {
    const t = appMenuTemplate({ platform: "darwin" });
    const view = t.find((m) => m.label === "View");
    assert.ok(view, "dropping View loses reload, devtools, zoom and fullscreen");
    const roles = view.submenu.map((i) => i.role).filter(Boolean);
    for (const role of ["reload", "forceReload", "toggleDevTools", "togglefullscreen"]) {
      assert.ok(roles.includes(role), `View menu needs the ${role} role`);
    }
    const labels = view.submenu.map((i) => i.label);
    assert.ok(labels.includes("Actual Size"));
    assert.ok(labels.includes("Zoom In"));
    assert.ok(labels.includes("Zoom Out"));
  });

  it("always has a Window menu", () => {
    for (const platform of ["darwin", "linux", "win32"]) {
      const t = appMenuTemplate({ platform });
      assert.ok(
        t.some((m) => m.label === "Window"),
        `Window menu missing on ${platform}`,
      );
    }
  });
});
