#!/usr/bin/env node
/**
 * set-win-icon.js — stamp Solenta's icon and version info into a Windows
 * electron.exe, in place.
 *
 * electron/main.js sets the icon of the running WINDOW, but Explorer, desktop
 * shortcuts and a pinned (not-running) taskbar button read the icon compiled
 * into the .exe's resource section — still Electron's, because package-cross.sh
 * only renames the binary. This rewrites RT_ICON / RT_GROUP_ICON / VS_VERSIONINFO
 * so the file identifies as Solenta everywhere Windows looks.
 *
 * The usual tool for this (rcedit) is a Windows binary and cannot run on the
 * macOS build host. resedit is pure JS, so it can.
 *
 * Usage: node scripts/set-win-icon.js <exe> <ico> <version> [productName]
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const [exePath, icoPath, version, productName = "Solenta"] =
    process.argv.slice(2);
  if (!exePath || !icoPath || !version) {
    console.error(
      "usage: node scripts/set-win-icon.js <exe> <ico> <version> [productName]",
    );
    process.exit(2);
  }

  const { NtExecutable, NtExecutableResource, Resource, Data } =
    await import("resedit");

  const exe = NtExecutable.from(fs.readFileSync(exePath));
  const res = NtExecutableResource.from(exe);
  const icon = Data.IconFile.from(fs.readFileSync(icoPath));
  const icons = icon.icons.map((i) => i.data);

  // Replace the groups that are already there rather than adding one. Windows
  // picks the group with the LOWEST id as the application icon, so appending a
  // new group would leave Electron's original winning.
  const groups = Resource.IconGroupEntry.fromEntries(res.entries);
  if (groups.length === 0) {
    throw new Error(`${path.basename(exePath)} has no RT_GROUP_ICON to replace`);
  }
  for (const g of groups) {
    Resource.IconGroupEntry.replaceIconsForResource(
      res.entries,
      g.id,
      g.lang,
      icons,
    );
  }

  // File properties / Task Manager still read "Electron" without this.
  // Version fields are u16 quads; a 4th component is not in package.json.
  const [maj = 0, min = 0, patch = 0] = version.split(".").map(Number);
  const lang = groups[0].lang;
  const vi = Resource.VersionInfo.createEmpty();
  vi.setFileVersion(maj, min, patch, 0, lang);
  vi.setProductVersion(maj, min, patch, 0, lang);
  vi.setStringValues(
    { lang, codepage: 1200 },
    {
      ProductName: productName,
      FileDescription: productName,
      CompanyName: "Solenta",
      LegalCopyright: "MIT",
      OriginalFilename: path.basename(exePath),
      FileVersion: version,
      ProductVersion: version,
    },
  );
  vi.outputToResourceEntries(res.entries);

  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));

  // Read the result back: a rewrite that produces an unparseable PE or silently
  // drops the group is otherwise only discoverable on a Windows desktop.
  const check = NtExecutableResource.from(
    NtExecutable.from(fs.readFileSync(exePath)),
  );
  const written = Resource.IconGroupEntry.fromEntries(check.entries);
  if (written.length !== groups.length) {
    throw new Error(
      `icon groups after write: ${written.length}, expected ${groups.length}`,
    );
  }
  for (const g of written) {
    if (g.icons.length !== icons.length) {
      throw new Error(
        `group ${g.id} has ${g.icons.length} icons, expected ${icons.length}`,
      );
    }
  }
  const productAfter = Resource.VersionInfo.fromEntries(check.entries)[0]
    ?.getStringValues({ lang, codepage: 1200 })?.ProductName;
  if (productAfter !== productName) {
    throw new Error(`ProductName after write: ${productAfter}`);
  }

  console.log(
    `icon: ${path.basename(exePath)} <- ${path.basename(icoPath)} ` +
      `(${written.length} group(s) x ${icons.length} sizes, ProductName=${productName} ${version})`,
  );
}

main().catch((e) => {
  console.error("set-win-icon failed:", e && e.message ? e.message : e);
  process.exit(1);
});
