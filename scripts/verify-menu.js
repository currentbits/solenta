// Verify the packaged Solenta.app installs a real application menu (issue
// #353): no menu in a packaged build means no Edit menu, which silently
// kills Cmd+C/X/V/A in inputs. Boots the packaged app with a throwaway
// userData and checks the menu contents from inside the main process.
"use strict";
const { app, Menu } = require("electron");

app.setPath(
  "userData",
  require("node:fs").mkdtempSync(
    require("node:path").join(require("node:os").tmpdir(), "solenta-menu-verify-"),
  ),
);

app.whenReady().then(() => {
  // Exercise the exact code path main.js now takes at boot (issue #353).
  require("../electron/menu.js").installAppMenu();
  const menu = Menu.getApplicationMenu();
  const labels = menu ? menu.items.map((i) => i.label || i.role) : [];
  const edit = menu && menu.items.find((i) => i.label === "Edit");
  const editRoles = edit
    ? edit.submenu.items.map((i) => (i.role || "").toLowerCase())
    : [];
  const ok =
    !!menu &&
    !!edit &&
    ["copy", "paste", "selectall"].every((r) => editRoles.includes(r));
  console.log("menu labels:", JSON.stringify(labels));
  console.log("edit roles:", JSON.stringify(editRoles));
  console.log(ok ? "MENU-VERIFY-OK" : "MENU-VERIFY-FAILED");
  app.exit(ok ? 0 : 1);
});
