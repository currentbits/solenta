#!/usr/bin/env node
/**
 * Download, verify, and copy a pinned NeMo-Speech.cpp v0.1.0 runtime into
 * <resources>/speech/{bin,lib} so electron/speech.js bundledRuntimePath
 * (process.resourcesPath/speech/bin/nemo-speech[.exe]) resolves.
 *
 * Usage (from package-app.sh / package-cross.sh):
 *   node scripts/bundle-speech-runtime.js --target macos-aarch64-metal \
 *     --dest "$APP_BUNDLE/Contents/Resources"
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const RELEASE_BASE =
  "https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v0.1.0";

const LICENSE_FILES = ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"];

const MIC_USAGE =
  "Solenta uses the microphone to dictate into the composer.";

/** @typedef {{ file: string, sha256: string, platform: "darwin" | "linux" | "win32" }} RuntimeArchive */

/** @type {Record<string, RuntimeArchive>} */
const RUNTIME_ARCHIVES = {
  "macos-aarch64-metal": {
    file: "nemo-speech-0.1.0-macos-aarch64-metal.tar.gz",
    sha256: "f1dff4f9dd9c96214f8cb78b982812459132df8a4ad1a42409fd94de4a366244",
    platform: "darwin",
  },
  "linux-x86_64-cpu": {
    file: "nemo-speech-0.1.0-linux-x86_64-cpu.tar.gz",
    sha256: "0f74131d631ad2c694cf0ec53490866bb6461147959589a69fb6fc231944065b",
    platform: "linux",
  },
  "windows-x86_64-cpu": {
    file: "nemo-speech-0.1.0-windows-x86_64-cpu.zip",
    sha256: "5e4ea81046012edcd77fd8848de8eefb5a4ba38cc26f52eb544ab184695a75d6",
    platform: "win32",
  },
};

function hashesEqual(got, want) {
  try {
    const a = Buffer.from(String(got), "hex");
    const b = Buffer.from(String(want), "hex");
    if (a.length !== 32 || b.length !== 32) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function verifySha256(filePath, expected) {
  const got = sha256File(filePath);
  if (!hashesEqual(got, expected)) {
    throw new Error(
      `SHA-256 mismatch for ${path.basename(filePath)}: got ${got}, want ${expected}`,
    );
  }
  return got;
}

function findRuntimePrefix(extractRoot) {
  const names = fs.readdirSync(extractRoot);
  const candidates = [
    extractRoot,
    ...names.map((n) => path.join(extractRoot, n)),
  ];
  for (const dir of candidates) {
    let st;
    try {
      st = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const unix = path.join(dir, "bin", "nemo-speech");
    const win = path.join(dir, "bin", "nemo-speech.exe");
    if (fs.existsSync(unix) || fs.existsSync(win)) return dir;
  }
  throw new Error(
    `NeMo-Speech.cpp extract at ${extractRoot} is missing bin/nemo-speech`,
  );
}

function copyEntry(from, to) {
  const st = fs.lstatSync(from);
  if (st.isSymbolicLink()) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.rmSync(to, { recursive: true, force: true });
    fs.symlinkSync(fs.readlinkSync(from), to);
    return;
  }
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) {
      copyEntry(path.join(from, name), path.join(to, name));
    }
    return;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  fs.chmodSync(to, st.mode & 0o777);
}

function chmodDirs(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    try {
      fs.chmodSync(dir, 0o755);
    } catch {
      // ignore
    }
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const p = path.join(dir, name);
      let st;
      try {
        st = fs.lstatSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(p);
    }
  }
}

function copyLib(srcLib, destLib) {
  if (!fs.existsSync(srcLib)) return false;
  let copied = false;
  fs.mkdirSync(destLib, { recursive: true });
  for (const name of fs.readdirSync(srcLib)) {
    if (name === "cmake") continue;
    copyEntry(path.join(srcLib, name), path.join(destLib, name));
    copied = true;
  }
  if (!copied) fs.rmSync(destLib, { recursive: true, force: true });
  return copied;
}

function installFromExtract(extractRoot, destResources) {
  chmodDirs(extractRoot);
  const prefix = findRuntimePrefix(extractRoot);
  const destSpeech = path.join(destResources, "speech");
  fs.rmSync(destSpeech, { recursive: true, force: true });

  const srcBin = path.join(prefix, "bin");
  const destBin = path.join(destSpeech, "bin");
  if (!fs.existsSync(srcBin)) {
    throw new Error(`runtime prefix missing bin/: ${prefix}`);
  }
  copyEntry(srcBin, destBin);

  const win = fs.existsSync(path.join(srcBin, "nemo-speech.exe"));
  // Unix rpath is ../lib. Windows loads DLLs from bin/; skip MSVC .lib files.
  if (!win) {
    copyLib(path.join(prefix, "lib"), path.join(destSpeech, "lib"));
  }

  const srcLic = path.join(prefix, "share", "licenses", "nemo-speech");
  if (!fs.existsSync(srcLic)) {
    throw new Error(`runtime prefix missing licenses: ${srcLic}`);
  }
  const destLic = path.join(destSpeech, "share", "licenses", "nemo-speech");
  copyEntry(srcLic, destLic);
  for (const name of LICENSE_FILES) {
    if (!fs.existsSync(path.join(destLic, name))) {
      throw new Error(`runtime prefix missing licenses: ${name}`);
    }
  }

  const unixExe = path.join(destBin, "nemo-speech");
  if (fs.existsSync(unixExe) && !fs.lstatSync(unixExe).isSymbolicLink()) {
    fs.chmodSync(unixExe, 0o755);
  }
  return destSpeech;
}

function listNames(dir, pred) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(pred);
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function assertRuntimeTree(destResources, platform) {
  const binDir = path.join(destResources, "speech", "bin");
  const libDir = path.join(destResources, "speech", "lib");
  const licenseDir = path.join(
    destResources,
    "speech",
    "share",
    "licenses",
    "nemo-speech",
  );
  const exeName = platform === "win32" ? "nemo-speech.exe" : "nemo-speech";
  const exePath = path.join(binDir, exeName);
  if (!fs.existsSync(exePath)) {
    throw new Error(`missing ${path.join("speech", "bin", exeName)}`);
  }
  if (platform !== "win32" && !isExecutable(exePath)) {
    throw new Error(`${exeName} is not executable`);
  }
  if (platform === "win32") {
    const dlls = listNames(binDir, (n) => n.toLowerCase().endsWith(".dll"));
    if (!dlls.length) throw new Error("missing adjacent speech DLLs in bin/");
  } else {
    const libs = listNames(
      libDir,
      (n) => n.endsWith(".dylib") || n.includes(".so"),
    );
    if (!libs.length) {
      throw new Error("missing speech shared libraries in lib/ (rpath ../lib)");
    }
  }
  for (const name of LICENSE_FILES) {
    if (!fs.existsSync(path.join(licenseDir, name))) {
      throw new Error(`missing speech license ${name}`);
    }
  }
}

function plistHasMicrophoneUsage(xml, desc = MIC_USAGE) {
  return (
    xml.includes("<key>NSMicrophoneUsageDescription</key>") &&
    xml.includes(`<string>${desc}</string>`)
  );
}

function extractZip(archivePath, destDir) {
  // Windows v0.1.0 zip uses backslash separators and 0644 directory
  // entries. macOS unzip warns (exit 1) and leaves dirs unlistable.
  const py = [
    "import os, sys, zipfile",
    "src, dest = sys.argv[1], sys.argv[2]",
    "os.makedirs(dest, exist_ok=True)",
    "sep = chr(92)",
    "with zipfile.ZipFile(src) as zf:",
    "    for info in zf.infolist():",
    "        name = info.filename.replace(sep, '/')",
    "        parts = [p for p in name.split('/') if p and p != '.']",
    "        if any(p == '..' for p in parts):",
    "            raise SystemExit('zip slip: ' + name)",
    "        if not parts:",
    "            continue",
    "        target = os.path.join(dest, *parts)",
    "        is_dir = name.endswith('/') or info.is_dir()",
    "        parent = os.path.dirname(target)",
    "        os.makedirs(parent if not is_dir else target, exist_ok=True)",
    "        os.chmod(parent if not is_dir else target, 0o755)",
    "        if is_dir:",
    "            continue",
    "        with zf.open(info, 'r') as inf, open(target, 'wb') as out:",
    "            out.write(inf.read())",
  ].join("\n");
  const result = spawnSync(
    "python3",
    ["-c", py, archivePath, destDir],
    { encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `zip extract failed (python3 exit ${result.status}): ${
        (result.stderr || result.stdout || "").trim()
      }`,
    );
  }
}

function extractArchive(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (archivePath.endsWith(".zip")) {
    extractZip(archivePath, destDir);
  } else {
    const result = spawnSync("tar", ["-xzf", archivePath, "-C", destDir], {
      encoding: "utf8",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `extract failed (tar exit ${result.status}): ${
          (result.stderr || result.stdout || "").trim()
        }`,
      );
    }
  }
  chmodDirs(destDir);
}

function downloadToFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const tmp = `${destPath}.partial`;
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const out = fs.createWriteStream(tmp);
    const fail = (err) => {
      out.close();
      fs.rmSync(tmp, { force: true });
      reject(err);
    };
    const get = (current, hops) => {
      if (hops > 8) {
        fail(new Error(`too many redirects: ${url}`));
        return;
      }
      http
        .get(current, (res) => {
          const loc = res.headers.location;
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            loc
          ) {
            res.resume();
            const next = new URL(loc, current).toString();
            get(next, hops + 1);
            return;
          }
          if (res.statusCode !== 200) {
            fail(new Error(`GET ${current} -> ${res.statusCode}`));
            return;
          }
          res.pipe(out);
          out.on("finish", () => {
            out.close(() => {
              fs.renameSync(tmp, destPath);
              resolve(destPath);
            });
          });
        })
        .on("error", fail);
    };
    out.on("error", fail);
    get(url, 0);
  });
}

async function ensureArchive(target, cacheDir) {
  const spec = RUNTIME_ARCHIVES[target];
  if (!spec) {
    throw new Error(
      `unknown speech runtime target ${target} (want ${Object.keys(RUNTIME_ARCHIVES).join(", ")})`,
    );
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  const archivePath = path.join(cacheDir, spec.file);
  if (fs.existsSync(archivePath)) {
    try {
      verifySha256(archivePath, spec.sha256);
      return { spec, archivePath };
    } catch {
      fs.rmSync(archivePath, { force: true });
    }
  }
  const url = `${RELEASE_BASE}/${spec.file}`;
  process.stderr.write(`downloading ${url}\n`);
  await downloadToFile(url, archivePath);
  verifySha256(archivePath, spec.sha256);
  return { spec, archivePath };
}

async function bundleSpeechRuntime({ target, dest, cacheDir }) {
  const cache = cacheDir || path.join("out", ".speech-runtime-cache");
  const { spec, archivePath } = await ensureArchive(target, cache);
  const extractDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `solenta-speech-${target}-`),
  );
  try {
    extractArchive(archivePath, extractDir);
    installFromExtract(extractDir, dest);
    assertRuntimeTree(dest, spec.platform);
  } finally {
    try {
      chmodDirs(extractDir);
    } catch {
      // ignore
    }
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
  return path.join(dest, "speech");
}

function parseArgs(argv) {
  const out = { target: "", dest: "", cacheDir: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target") out.target = argv[++i] || "";
    else if (a === "--dest") out.dest = argv[++i] || "";
    else if (a === "--cache") out.cacheDir = argv[++i] || "";
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.target || !args.dest) {
    process.stderr.write(
      "usage: bundle-speech-runtime.js --target <id> --dest <resourcesDir> [--cache dir]\n",
    );
    process.exit(2);
  }
  const dest = path.resolve(args.dest);
  const cacheDir = args.cacheDir
    ? path.resolve(args.cacheDir)
    : path.resolve(path.join(__dirname, "..", "out", ".speech-runtime-cache"));
  const speechDir = await bundleSpeechRuntime({
    target: args.target,
    dest,
    cacheDir,
  });
  process.stdout.write(`speech runtime: ${speechDir}\n`);
}

module.exports = {
  RELEASE_BASE,
  LICENSE_FILES,
  MIC_USAGE,
  RUNTIME_ARCHIVES,
  hashesEqual,
  sha256File,
  verifySha256,
  findRuntimePrefix,
  chmodDirs,
  installFromExtract,
  assertRuntimeTree,
  plistHasMicrophoneUsage,
  extractArchive,
  bundleSpeechRuntime,
};

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  });
}
