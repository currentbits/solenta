/**
 * Issue #881: verify-package.sh treated a notarized, stapled Developer ID
 * nightly as UNSIGNED because `codesign -dvv | grep -q` under `set -o pipefail`
 * exits 141 (SIGPIPE). Gatekeeper (including the stapled-path spctl MUST-pass)
 * was skipped and the cut still printed verify: OK.
 *
 * Run: node --test electron/test/verify-gatekeeper.test.js
 */
"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..", "..");
const VERIFY = path.join(ROOT, "scripts", "verify-package.sh");

/** @type {string[]} */
let tmpDirs = [];

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-vgate-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

function writeBin(dir, name, body) {
  const dest = path.join(dir, name);
  fs.writeFileSync(dest, `#!/usr/bin/env bash\n${body}\n`);
  fs.chmodSync(dest, 0o755);
  return dest;
}

const DEVELOPER_ID_DUMP = [
  "Executable=/tmp/Solenta Nightly.app/Contents/MacOS/Solenta Nightly",
  "Identifier=com.willem.solenta.nightly",
  "Format=app bundle with Mach-O thin (arm64)",
  "CodeDirectory v=20500 size=486 flags=0x10000(runtime) hashes=4+7 location=embedded",
  "Signature size=8983",
  "Authority=Developer ID Application: Willem van Zoeren (VJ5P6CC9GU)",
  "Authority=Developer ID Certification Authority",
  "Authority=Apple Root CA",
  "Timestamp=3 Sep 2026 at 22:32:57",
  "Notarization Ticket=stapled",
  "TeamIdentifier=VJ5P6CC9GU",
].join("\n");

function runGatekeeper(opts) {
  const dir = tmp();
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const dumpPath = path.join(dir, "codesign-dvv.txt");
  const spctlLog = path.join(dir, "spctl.log");
  const codesignLog = path.join(dir, "codesign.log");
  fs.writeFileSync(dumpPath, `${opts.dump}\n`);
  fs.writeFileSync(spctlLog, "");
  fs.writeFileSync(codesignLog, "");

  // Real codesign writes the Authority line then keeps going. grep -q closes
  // the pipe on the first match; the leftover writer gets SIGPIPE (141).
  // Sleep + pad past the pipe buffer so a PATH-stub reproduces that, instead
  // of a one-shot cat that fits in the buffer and hides the bug.
  writeBin(
    bin,
    "codesign",
    `
echo "$*" >> ${JSON.stringify(codesignLog)}
if [[ "$1" == "-dvv" ]]; then
  n=0
  while IFS= read -r line; do
    echo "$line" >&2
    n=$((n + 1))
    if [[ "$line" == Authority=Developer\\ ID\\ Application* ]]; then
      sleep 0.05
    fi
  done < ${JSON.stringify(dumpPath)}
  i=0
  while [[ $i -lt 4000 ]]; do
    echo "Padding=$i extra extra extra extra extra extra extra extra extra extra" >&2
    i=$((i + 1))
  done
  exit 0
fi
if [[ "$1" == "--verify" ]]; then
  exit ${opts.verifyEc ?? 0}
fi
echo "unexpected codesign: $*" >&2
exit 99
`,
  );

  writeBin(
    bin,
    "xcrun",
    `
if [[ "$1" == "stapler" && "$2" == "validate" ]]; then
  exit ${opts.staplerEc ?? 1}
fi
echo "unexpected xcrun: $*" >&2
exit 99
`,
  );

  writeBin(
    bin,
    "spctl",
    `
printf '%s\\n' "$*" >> ${JSON.stringify(spctlLog)}
exit ${opts.spctlEc ?? 0}
`,
  );

  const app = path.join(dir, "Solenta Nightly.app");
  fs.mkdirSync(app);
  const result = spawnSync("bash", [VERIFY, app], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      SOLENTA_VERIFY_GATEKEEPER_ONLY: "1",
    },
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    spctlArgs: fs.readFileSync(spctlLog, "utf8").trim().split("\n").filter(Boolean),
    codesignArgs: fs.readFileSync(codesignLog, "utf8").trim().split("\n").filter(Boolean),
  };
}

describe("verify-package.sh Gatekeeper", () => {
  it("does not pipe codesign -dvv into grep -q (SIGPIPE under pipefail)", () => {
    const src = fs.readFileSync(VERIFY, "utf8");
    assert.doesNotMatch(
      src,
      /codesign -dvv[^|\n]*\|\s*grep -q/,
      "grep -q closes the pipe on the first Authority line; codesign then SIGPIPE (141) and pipefail treats a Developer ID bundle as unsigned",
    );
  });

  it("detects a Developer ID stapled dump even when codesign -dvv keeps writing after Authority", () => {
    const r = runGatekeeper({
      dump: DEVELOPER_ID_DUMP,
      staplerEc: 0,
      spctlEc: 0,
    });
    const out = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 0, out);
    assert.doesNotMatch(out, /UNSIGNED/);
    assert.match(out, /verify: signature/);
    assert.match(out, /notarization ticket stapled/);
    assert.match(out, /spctl: accepted/);
    assert.ok(
      r.spctlArgs.some((a) => /--type execute\b/.test(a) || /(^|\s)-t execute(\s|$)/.test(a)),
      `stapled path must assess --type execute (what Gatekeeper uses to launch), got: ${JSON.stringify(r.spctlArgs)}`,
    );
  });

  it("fails the cut when a stapled bundle's spctl --type execute would fail", () => {
    const r = runGatekeeper({
      dump: DEVELOPER_ID_DUMP,
      staplerEc: 0,
      spctlEc: 1,
    });
    const out = `${r.stdout}${r.stderr}`;
    assert.notEqual(r.status, 0, `stapled + spctl fail must be fatal, output:\n${out}`);
    assert.doesNotMatch(out, /UNSIGNED/);
    assert.doesNotMatch(out, /spctl: accepted/);
  });

  it("warns UNSIGNED and skips spctl when there is no Developer ID signature", () => {
    const r = runGatekeeper({
      dump: "Executable=/tmp/Fake.app\nIdentifier=com.example.unsigned\n",
      staplerEc: 1,
      spctlEc: 1,
    });
    const out = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 0, out);
    assert.match(out, /UNSIGNED/);
    assert.equal(r.spctlArgs.length, 0);
  });

  it("treats a signed but unstapled local build's spctl failure as advisory", () => {
    const dump = DEVELOPER_ID_DUMP.replace("Notarization Ticket=stapled\n", "");
    const r = runGatekeeper({
      dump,
      staplerEc: 1,
      spctlEc: 1,
    });
    const out = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 0, out);
    assert.match(out, /no stapled ticket/);
    assert.doesNotMatch(out, /UNSIGNED/);
  });
});
