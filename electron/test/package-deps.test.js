"use strict";

/**
 * Packaged Electron only ships an explicit ROOT_NM_PKGS allowlist, not
 * the whole root node_modules. A production require() that is not on
 * that list becomes "Cannot find module" in the .app (yauzl / #nightly
 * 202608250617). Catch it in CI instead of at first user launch.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..", "..");
const ELECTRON_DIR = path.join(ROOT, "electron");
const BUILTIN = new Set(["electron"]);

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function packagedAllowlist(rel) {
  const sh = read(rel);
  const m = sh.match(/ROOT_NM_PKGS=\(([^)]+)\)/);
  assert.ok(m, `${rel} must declare ROOT_NM_PKGS=(...)`);
  return m[1].trim().split(/\s+/).filter(Boolean);
}

function electronThirdPartyRequires() {
  const ids = new Set();
  for (const file of fs.readdirSync(ELECTRON_DIR, { recursive: true })) {
    if (!file.endsWith(".js") || file.split(path.sep).includes("test")) continue;
    const src = fs.readFileSync(path.join(ELECTRON_DIR, file), "utf8");
    for (const m of src.matchAll(/(?<![.\w])(?:require(?:\.resolve)?|import)\(["']([^"']+)["']\)/g)) {
      const id = m[1];
      if (id.startsWith(".") || id.startsWith("node:")) continue;
      const pkg = id.startsWith("@") ? id.split("/").slice(0, 2).join("/") : id.split("/")[0];
      if (!BUILTIN.has(pkg)) ids.add(pkg);
    }
  }
  return [...ids].sort();
}

function productionDeps(pkg) {
  const pjPath = path.join(ROOT, "node_modules", pkg, "package.json");
  if (!fs.existsSync(pjPath)) return [];
  const pj = JSON.parse(fs.readFileSync(pjPath, "utf8"));
  return Object.keys(pj.dependencies || {});
}

function withTransitives(pkgs) {
  const out = new Set();
  const queue = [...pkgs];
  while (queue.length) {
    const pkg = queue.pop();
    if (out.has(pkg)) continue;
    out.add(pkg);
    for (const dep of productionDeps(pkg)) queue.push(dep);
  }
  return out;
}

describe("packaged electron node_modules allowlist", () => {
  const required = withTransitives(electronThirdPartyRequires());

  for (const script of ["scripts/package-app.sh", "scripts/package-cross.sh"]) {
    it(`${script} ROOT_NM_PKGS covers every electron require() and its deps`, () => {
      const allow = new Set(packagedAllowlist(script));
      const missing = [...required].filter((p) => !allow.has(p)).sort();
      assert.deepEqual(
        missing,
        [],
        `${script} ROOT_NM_PKGS is missing: ${missing.join(", ")} (electron requires ${[...required].sort().join(", ")})`,
      );
    });
  }

  it("verify-package.sh resolves bundled deps from an empty cwd via NODE_PATH", () => {
    const verify = read("scripts/verify-package.sh");
    assert.match(
      verify,
      /require\.resolve/,
      "verify-package.sh must require.resolve bundled electron deps, not only check ws/cross-spawn exist as dirs",
    );
    assert.match(
      verify,
      /NODE_PATH=/,
      "resolve must use NODE_PATH=bundled node_modules; host node_modules would false-pass",
    );
    assert.match(
      verify,
      /solenta-pkg-resolve/,
      "resolve must run from an empty temp cwd so Node does not walk the repo",
    );
  });
});

for (const script of ["scripts/package-app.sh", "scripts/package-cross.sh", "scripts/package-server.sh"]) {
  it(`${script} ships a loadable terminal parser outside the source checkout`, { skip: process.platform === "win32" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-parser-package-"));
    try {
      const line = read(script).split("\n").find((line) => line.startsWith("rsync -a"));
      assert.ok(line, `${script} copy command`);
      const filters = [...line.matchAll(/--(include|exclude)='([^']*)'/g)].map((m) => `--${m[1]}=${m[2]}`);
      execFileSync("rsync", ["-a", "--prune-empty-dirs", ...filters, ELECTRON_DIR + path.sep, dir + path.sep]);
      execFileSync(process.execPath, ["-e", 'const assert = require("node:assert/strict"); const p = require("./terminalSequences.mjs"); assert.equal(p.skipPartialSequence(3, "title\\x07visible").text, "visible");'], { cwd: dir });
      assert.equal(fs.existsSync(path.join(dir, "test")), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
