/**
 * Issue #845: package NeMo-Speech.cpp into process.resourcesPath/speech.
 * Run: node --test electron/test/speech-packaging.test.js
 */
"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..", "..");
const {
  RUNTIME_PINS,
  bundledRuntimePath,
} = require("../speech.js");
const {
  LICENSE_FILES,
  MIC_USAGE,
  RUNTIME_ARCHIVES,
  sha256File,
  verifySha256,
  chmodDirs,
  installFromExtract,
  assertRuntimeTree,
  plistHasMicrophoneUsage,
  extractArchive,
} = require("../../scripts/bundle-speech-runtime.js");

/** @type {string[]} */
let tmpDirs = [];

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-speech-pkg-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

function write(filePath, body = "x") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body);
}

function seedExtract(root, { platform, prefix = "nemo-speech" } = {}) {
  const base = path.join(root, prefix);
  const binDir = path.join(base, "bin");
  const libDir = path.join(base, "lib");
  const licDir = path.join(base, "share", "licenses", "nemo-speech");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(licDir, { recursive: true });
  if (platform === "win32") {
    write(path.join(binDir, "nemo-speech.exe"), "exe");
    write(path.join(binDir, "ggml.dll"), "dll");
    write(path.join(binDir, "nemo_speech_asr.dll"), "dll");
  } else {
    write(path.join(binDir, "nemo-speech"), "bin");
    fs.mkdirSync(libDir, { recursive: true });
    const libName =
      platform === "darwin" ? "libggml-metal.0.dylib" : "libggml.so.0";
    write(path.join(libDir, libName), "lib");
    write(path.join(libDir, "cmake", "NeMoSpeech", "config.cmake"), "cmake");
  }
  write(path.join(base, "include", "nemo_speech.h"), "hdr");
  write(path.join(base, "share", "doc", "nemo-speech", "README.md"), "doc");
  for (const name of LICENSE_FILES) {
    write(path.join(licDir, name), `${name} text`);
  }
  return base;
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

describe("runtime pins", () => {
  it("packaging archives match electron/speech.js RUNTIME_PINS", () => {
    assert.deepEqual(
      {
        "macos-aarch64-metal": RUNTIME_ARCHIVES["macos-aarch64-metal"].sha256,
        "linux-x86_64-cpu": RUNTIME_ARCHIVES["linux-x86_64-cpu"].sha256,
        "windows-x86_64-cpu": RUNTIME_ARCHIVES["windows-x86_64-cpu"].sha256,
      },
      RUNTIME_PINS,
    );
  });

  it("pins the v0.1.0 GitHub asset names", () => {
    assert.equal(
      RUNTIME_ARCHIVES["macos-aarch64-metal"].file,
      "nemo-speech-0.1.0-macos-aarch64-metal.tar.gz",
    );
    assert.equal(
      RUNTIME_ARCHIVES["linux-x86_64-cpu"].file,
      "nemo-speech-0.1.0-linux-x86_64-cpu.tar.gz",
    );
    assert.equal(
      RUNTIME_ARCHIVES["windows-x86_64-cpu"].file,
      "nemo-speech-0.1.0-windows-x86_64-cpu.zip",
    );
  });

  it("bundledRuntimePath stays under resources/speech/bin", () => {
    assert.equal(
      bundledRuntimePath({
        platform: "darwin",
        arch: "arm64",
        resourcesPath: "/App/Contents/Resources",
      }),
      path.join("/App/Contents/Resources", "speech", "bin", "nemo-speech"),
    );
    assert.equal(
      bundledRuntimePath({
        platform: "linux",
        arch: "x64",
        resourcesPath: "/opt/solenta/resources",
      }),
      path.join("/opt/solenta/resources", "speech", "bin", "nemo-speech"),
    );
    assert.equal(
      bundledRuntimePath({
        platform: "win32",
        arch: "x64",
        resourcesPath: "C:\\app\\resources",
      }),
      path.join("C:\\app\\resources", "speech", "bin", "nemo-speech.exe"),
    );
  });
});

describe("verifySha256", () => {
  it("accepts a matching digest and rejects a mismatch", () => {
    const file = path.join(tmp(), "blob.bin");
    fs.writeFileSync(file, "nemo-speech-fixture");
    const want = crypto
      .createHash("sha256")
      .update("nemo-speech-fixture")
      .digest("hex");
    assert.equal(sha256File(file), want);
    verifySha256(file, want);
    assert.throws(
      () => verifySha256(file, "00".repeat(32)),
      /SHA-256 mismatch/,
    );
  });
});

describe("installFromExtract", () => {
  it("installs the macOS Metal prefix: bin + lib + licenses, not headers/cmake", () => {
    const extract = tmp();
    const dest = tmp();
    seedExtract(extract, { platform: "darwin" });
    installFromExtract(extract, dest);
    assertRuntimeTree(dest, "darwin");
    assert.equal(
      fs.readFileSync(
        path.join(dest, "speech", "bin", "nemo-speech"),
        "utf8",
      ),
      "bin",
    );
    assert.ok(
      fs.existsSync(
        path.join(dest, "speech", "lib", "libggml-metal.0.dylib"),
      ),
    );
    assert.equal(
      fs.existsSync(path.join(dest, "speech", "include")),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(dest, "speech", "lib", "cmake")),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(dest, "speech", "share", "doc")),
      false,
    );
    if (process.platform !== "win32") {
      assert.equal(
        fs.statSync(path.join(dest, "speech", "bin", "nemo-speech")).mode &
          0o111,
        0o111,
      );
    }
  });

  it("installs the Linux CPU prefix with executable bits and .so files", () => {
    const extract = tmp();
    const dest = tmp();
    seedExtract(extract, {
      platform: "linux",
      prefix: "nemo-speech-0.1.0-linux-x86_64-cpu",
    });
    installFromExtract(extract, dest);
    assertRuntimeTree(dest, "linux");
    assert.ok(fs.existsSync(path.join(dest, "speech", "lib", "libggml.so.0")));
    if (process.platform !== "win32") {
      assert.equal(
        fs.statSync(path.join(dest, "speech", "bin", "nemo-speech")).mode &
          0o111,
        0o111,
      );
    }
  });

  it("installs the Windows CPU prefix with exe + adjacent DLLs", () => {
    const extract = tmp();
    const dest = tmp();
    seedExtract(extract, { platform: "win32", prefix: "." });
    installFromExtract(extract, dest);
    assertRuntimeTree(dest, "win32");
    assert.ok(
      fs.existsSync(path.join(dest, "speech", "bin", "nemo-speech.exe")),
    );
    assert.ok(fs.existsSync(path.join(dest, "speech", "bin", "ggml.dll")));
    assert.equal(fs.existsSync(path.join(dest, "speech", "lib")), false);
  });

  it("finds a nested prefix and requires the three Apache notice files", () => {
    const extract = tmp();
    const dest = tmp();
    seedExtract(extract, { platform: "darwin", prefix: "nemo-speech" });
    fs.rmSync(
      path.join(
        extract,
        "nemo-speech",
        "share",
        "licenses",
        "nemo-speech",
        "NOTICE",
      ),
    );
    assert.throws(() => installFromExtract(extract, dest), /licenses/);
  });

  it("chmodDirs makes 0644 zip directories traversable", () => {
    const root = tmp();
    const nested = path.join(root, "share", "licenses", "nemo-speech");
    fs.mkdirSync(nested, { recursive: true });
    write(path.join(nested, "LICENSE"), "L");
    fs.chmodSync(nested, 0o644);
    fs.chmodSync(path.join(root, "share", "licenses"), 0o644);
    if (process.platform !== "win32") {
      assert.throws(() => fs.readdirSync(nested), /EACCES|ENOTDIR|ENOENT/);
    }
    chmodDirs(root);
    assert.deepEqual(fs.readdirSync(nested).sort(), ["LICENSE"]);
  });
});

describe("extractArchive", () => {
  it("reads a zip that uses backslash separators", () => {
    const dir = tmp();
    const zip = path.join(dir, "win.zip");
    const extracted = path.join(dir, "ex");
    const py = [
      "import sys, zipfile",
      "z = zipfile.ZipFile(sys.argv[1], 'w')",
      "z.writestr('bin' + chr(92) + 'nemo-speech.exe', b'exe')",
      "z.writestr('bin' + chr(92) + 'ggml.dll', b'dll')",
      "z.writestr('share' + chr(92) + 'licenses' + chr(92) + 'nemo-speech' + chr(92) + 'LICENSE', b'L')",
      "z.close()",
    ].join("\n");
    const made = spawnSync("python3", ["-c", py, zip], { encoding: "utf8" });
    if (made.status !== 0) {
      assert.ok(false, `python3 zip fixture failed: ${made.stderr || made.stdout}`);
    }
    extractArchive(zip, extracted);
    assert.ok(fs.existsSync(path.join(extracted, "bin", "nemo-speech.exe")));
    assert.ok(fs.existsSync(path.join(extracted, "bin", "ggml.dll")));
    assert.ok(
      fs.existsSync(
        path.join(extracted, "share", "licenses", "nemo-speech", "LICENSE"),
      ),
    );
  });
});

describe("plist microphone usage", () => {
  it("accepts a snippet with NSMicrophoneUsageDescription", () => {
    const xml = [
      "<dict>",
      "  <key>CFBundleName</key>",
      "  <string>Solenta</string>",
      "  <key>NSMicrophoneUsageDescription</key>",
      `  <string>${MIC_USAGE}</string>`,
      "</dict>",
      "",
    ].join("\n");
    assert.equal(plistHasMicrophoneUsage(xml), true);
    assert.equal(plistHasMicrophoneUsage("<dict></dict>"), false);
    assert.equal(
      plistHasMicrophoneUsage(xml.replace(MIC_USAGE, "other")),
      false,
    );
  });
});

describe("packaging scripts", () => {
  const appSh = read("scripts/package-app.sh");
  const crossSh = read("scripts/package-cross.sh");
  const verifySh = read("scripts/verify-package.sh");

  it("package-app.sh copies Metal runtime into Contents/Resources before codesign", () => {
    assert.match(appSh, /bundle-speech-runtime\.js/);
    assert.match(appSh, /macos-aarch64-metal/);
    assert.match(appSh, /--dest "\$APP_BUNDLE\/Contents\/Resources"/);
    assert.doesNotMatch(appSh, /--dest .*app\/runtime\/speech/);
    const bundleAt = appSh.indexOf("bundle-speech-runtime.js");
    const signAt = appSh.indexOf("codesign-app.sh");
    assert.ok(bundleAt > 0 && signAt > bundleAt, "runtime must land before codesign");
  });

  it("package-app.sh adds NSMicrophoneUsageDescription next to CFBundleName", () => {
    assert.match(appSh, /PlistBuddy.*NSMicrophoneUsageDescription/);
    assert.match(appSh, new RegExp(MIC_USAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const nameAt = appSh.indexOf("CFBundleName");
    const micAt = appSh.indexOf("NSMicrophoneUsageDescription");
    assert.ok(nameAt > 0 && micAt > nameAt);
  });

  it("package-cross.sh copies CPU runtimes into resources/speech per OS", () => {
    assert.match(crossSh, /linux-x86_64-cpu/);
    assert.match(crossSh, /windows-x86_64-cpu/);
    assert.match(crossSh, /--dest "\$TOP\/resources"/);
    assert.doesNotMatch(crossSh, /--dest .*app\/runtime\/speech/);
    assert.match(crossSh, /nemo-speech\.exe/);
    assert.match(crossSh, /speech\/bin\/nemo-speech/);
  });

  it("verify-package.sh checks nested speech bin, license, and microphone plist", () => {
    assert.match(verifySh, /speech\/bin\/nemo-speech/);
    assert.match(verifySh, /licenses\/nemo-speech\/LICENSE/);
    assert.match(verifySh, /NSMicrophoneUsageDescription/);
    assert.match(verifySh, /codesign --verify --deep --strict/);
  });
});
