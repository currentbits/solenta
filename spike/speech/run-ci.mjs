#!/usr/bin/env node
/**
 * Native Linux/Windows live-gate runner for NeMo-Speech.cpp v0.1.0.
 * Downloads pinned runtime + GGUF if missing, serves on loopback, runs
 * spike/speech/live-client.mjs, fails the process on any missed numeric gate.
 *
 *   node spike/speech/run-ci.mjs --fetch-only
 *   node spike/speech/run-ci.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import net from "node:net";
import { Readable } from "node:stream";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const isWin = process.platform === "win32";

const GGUF_SHA = "d9a01898d2a611c8764e23a1c2f45e70bbd5a425dc4de93692ac951dd603812d";
const GGUF_BYTES = 699872960;
const GGUF_URL =
  "https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b/resolve/main/nemotron-speech-streaming-en-0.6b.q8_0.gguf";
const LINUX_SHA = "0f74131d631ad2c694cf0ec53490866bb6461147959589a69fb6fc231944065b";
const WIN_SHA = "5e4ea81046012edcd77fd8848de8eefb5a4ba38cc26f52eb544ab184695a75d6";
const LINUX_URL =
  "https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v0.1.0/nemo-speech-0.1.0-linux-x86_64-cpu.tar.gz";
const WIN_URL =
  "https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v0.1.0/nemo-speech-0.1.0-windows-x86_64-cpu.zip";
const RSS_LIMIT_BYTES = 2.5 * 1024 * 1024 * 1024;
const FIRST_PARTIAL_MAX_MS = 1500;
const STOP_TO_FINAL_MAX_MS = 1500;
const RTF_MAX = 1.0;

const { values } = parseArgs({
  options: {
    "fetch-only": { type: "boolean", default: false },
  },
});

const cacheDir = process.env.SPIKE_CACHE || path.join(tmpdir(), "solenta-speech-spike");
const outDir = process.env.SPIKE_OUT || path.join(cacheDir, "out");
mkdirSync(cacheDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

const ggufPath = path.join(cacheDir, "nemotron-speech-streaming-en-0.6b.q8_0.gguf");
const wavPath = path.join(here, "fixtures", "phrase-16k.wav");
const runtimeArchive = path.join(
  cacheDir,
  isWin
    ? "nemo-speech-0.1.0-windows-x86_64-cpu.zip"
    : "nemo-speech-0.1.0-linux-x86_64-cpu.tar.gz",
);
const runtimeDir = path.join(cacheDir, isWin ? "windows-cpu" : "linux-cpu");

function sha256File(file) {
  const hash = createHash("sha256");
  hash.update(readFileSync(file));
  return hash.digest("hex");
}

async function sha256FileStream(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

async function download(url, dest, expectedSha, expectedSize) {
  if (existsSync(dest)) {
    const st = statSync(dest);
    if (!expectedSize || st.size === expectedSize) {
      const got = expectedSize && expectedSize > 50_000_000 ? await sha256FileStream(dest) : sha256File(dest);
      if (got === expectedSha) {
        console.log(`cache hit ${path.basename(dest)} sha256=${got}`);
        return;
      }
      console.log(`hash mismatch for ${dest}, redownloading`);
    }
  }
  console.log(`downloading ${url}`);
  const tmp = dest + ".partial";
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: { "User-Agent": "solenta-speech-spike/0.1" },
      });
      if (!res.ok) throw new Error(`${url} -> ${res.status}`);
      if (!res.body) throw new Error("empty body");
      const hash = createHash("sha256");
      const out = createWriteStream(tmp);
      const nodeStream = Readable.fromWeb(res.body);
      nodeStream.on("data", (chunk) => hash.update(chunk));
      await pipeline(nodeStream, out);
      const got = hash.digest("hex");
      const size = statSync(tmp).size;
      if (expectedSha && got !== expectedSha) {
        throw new Error(`sha256 ${got} != ${expectedSha}`);
      }
      if (expectedSize && size !== expectedSize) {
        throw new Error(`size ${size} != ${expectedSize}`);
      }
      const { renameSync, rmSync } = await import("node:fs");
      try {
        rmSync(dest, { force: true });
      } catch {
        /* ignore */
      }
      renameSync(tmp, dest);
      console.log(`wrote ${path.basename(dest)} ${size} bytes sha256=${got}`);
      return;
    } catch (e) {
      lastErr = e;
      console.log(`attempt ${attempt} failed: ${e.message || e}`);
      await delay(2000 * attempt);
    }
  }
  throw lastErr;
}

function extractRuntime() {
  mkdirSync(runtimeDir, { recursive: true });
  const marker = isWin
    ? path.join(runtimeDir, "bin", "nemo-speech.exe")
    : path.join(runtimeDir, "nemo-speech-0.1.0-linux-x86_64-cpu", "bin", "nemo-speech");
  if (existsSync(marker)) {
    console.log(`already extracted ${marker}`);
    return;
  }
  if (isWin) {
    let r = spawnSync("tar", ["-xf", runtimeArchive, "-C", runtimeDir], { encoding: "utf8" });
    if (r.status !== 0) {
      r = spawnSync(
        "powershell",
        ["-NoProfile", "-Command", `Expand-Archive -Force -Path '${runtimeArchive}' -DestinationPath '${runtimeDir}'`],
        { encoding: "utf8" },
      );
    }
    if (r.status !== 0) {
      throw new Error(`extract failed: ${r.stderr || r.stdout || r.status}`);
    }
    return;
  }
  const r = spawnSync("tar", ["-xzf", runtimeArchive, "-C", runtimeDir], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`tar extract failed: ${r.stderr || r.stdout || r.status}`);
  }
}

function walkFind(dir, name, depth = 0) {
  if (depth > 6 || !existsSync(dir)) return null;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isFile() && ent.name === name) return p;
    if (ent.isDirectory()) {
      const hit = walkFind(p, name, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on("error", reject);
  });
}

function rssBytes(pid) {
  try {
    if (isWin) {
      const r = spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64`,
        ],
        { encoding: "utf8" },
      );
      const n = Number(String(r.stdout || "").trim());
      return Number.isFinite(n) ? n : 0;
    }
    const st = readFileSync(`/proc/${pid}/status`, "utf8");
    const m = st.match(/^VmRSS:\s+(\d+)\s+kB/m);
    return m ? Number(m[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

function runCaptured(bin, args, opts = {}) {
  const r = spawnSync(bin, args, {
    encoding: "utf8",
    env: opts.env || process.env,
    cwd: opts.cwd,
    timeout: opts.timeout || 120_000,
  });
  return r;
}

function parseLiveStdout(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`no JSON in live-client output:\n${text.slice(-500)}`);
  return JSON.parse(text.slice(start, end + 1));
}

async function fetchAssets() {
  if (!existsSync(wavPath)) throw new Error(`missing fixture ${wavPath}`);
  if (isWin) {
    await download(WIN_URL, runtimeArchive, WIN_SHA);
  } else {
    await download(LINUX_URL, runtimeArchive, LINUX_SHA);
  }
  await download(GGUF_URL, ggufPath, GGUF_SHA, GGUF_BYTES);
  extractRuntime();
}

async function runGates() {
  const binName = isWin ? "nemo-speech.exe" : "nemo-speech";
  const bin = walkFind(runtimeDir, binName);
  if (!bin) throw new Error(`nemo-speech binary not found under ${runtimeDir}`);
  const binDir = path.dirname(bin);
  const libDir = path.resolve(binDir, "../lib");
  const env = { ...process.env, NEMO_SPEECH_HTTP_API_KEY: randomBytes(24).toString("base64url") };
  if (!isWin && existsSync(libDir)) {
    env.LD_LIBRARY_PATH = libDir + (env.LD_LIBRARY_PATH ? path.delimiter + env.LD_LIBRARY_PATH : "");
  }

  console.log("=== doctor ===");
  const doctor = runCaptured(bin, ["doctor"], { env, cwd: binDir });
  const doctorText = `${doctor.stdout || ""}\n${doctor.stderr || ""}`;
  writeFileSync(path.join(outDir, "doctor.txt"), doctorText);
  console.log(doctorText);
  if (doctor.status !== 0) throw new Error(`doctor exit ${doctor.status}`);
  if (!/\bcpu\b/i.test(doctorText) && !/backend_cpu/i.test(doctorText)) {
    throw new Error("doctor output has no CPU device");
  }

  const port = await freePort();
  const token = env.NEMO_SPEECH_HTTP_API_KEY;
  const serveLogPath = path.join(outDir, "serve.log");
  const serveLog = createWriteStream(serveLogPath);
  const serveArgs = [
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--no-ui",
    "--asr-model",
    ggufPath,
    "--device",
    "cpu",
    "--read-timeout",
    "600",
    "--write-timeout",
    "600",
  ];
  console.log("=== serve ===", bin, serveArgs.join(" "));
  const serve = spawn(bin, serveArgs, {
    env,
    cwd: binDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  serve.stdout.pipe(serveLog);
  serve.stderr.pipe(serveLog);
  const rssSamples = [];
  const rssTimer = setInterval(() => {
    if (!serve.pid) return;
    const n = rssBytes(serve.pid);
    rssSamples.push({ t: Date.now(), bytes: n });
  }, 1000);

  const killServe = () => {
    clearInterval(rssTimer);
    try {
      serveLog.end();
    } catch {
      /* ignore */
    }
    if (!serve.pid) return;
    if (isWin) spawnSync("taskkill", ["/PID", String(serve.pid), "/T", "/F"]);
    else {
      try {
        serve.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
  };
  process.on("exit", killServe);
  process.on("SIGINT", () => {
    killServe();
    process.exit(130);
  });

  let serveExit = null;
  serve.on("exit", (code, signal) => {
    serveExit = { code, signal };
  });

  console.log("waiting /ready");
  const readyUrl = `http://127.0.0.1:${port}/ready`;
  let readyBody = "";
  for (let i = 0; i < 180; i++) {
    if (serveExit) {
      throw new Error(`serve exited before ready: ${JSON.stringify(serveExit)}`);
    }
    try {
      const res = await fetch(readyUrl);
      if (res.ok) {
        readyBody = await res.text();
        console.log("ready", readyBody);
        break;
      }
    } catch {
      /* not up */
    }
    await delay(1000);
    if (i === 179) throw new Error("GET /ready timeout");
  }
  writeFileSync(path.join(outDir, "ready.json"), readyBody || "{}");

  const liveClient = path.join(here, "live-client.mjs");
  const runLive = (extraArgs, outName, timeoutMs) => {
    const args = [
      liveClient,
      "--url",
      `ws://127.0.0.1:${port}/v1/realtime`,
      "--token",
      token,
      "--wav",
      wavPath,
      "--out",
      path.join(outDir, outName),
      "--hard-timeout-ms",
      String(timeoutMs),
      ...extraArgs,
    ];
    console.log("=== live-client ===", extraArgs.join(" "));
    const r = spawnSync(process.execPath, args, {
      encoding: "utf8",
      env,
      timeout: timeoutMs + 15_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    writeFileSync(path.join(outDir, outName.replace(/\.json$/, ".stdout.txt")), r.stdout || "");
    writeFileSync(path.join(outDir, outName.replace(/\.json$/, ".stderr.txt")), r.stderr || "");
    if (r.status !== 0) {
      throw new Error(
        `live-client ${extraArgs.join(" ")} exit ${r.status}\n${r.stderr || ""}\n${(r.stdout || "").slice(-1500)}`,
      );
    }
    return parseLiveStdout(r.stdout || "");
  };

  const live = runLive(["--pace", "realtime", "--settle-ms", "15000"], "live-realtime.json", 60_000);
  writeFileSync(path.join(outDir, "live-realtime.summary.json"), JSON.stringify(live, null, 2) + "\n");
  let rtf = null;
  let rtfErr = null;
  try {
    // Max-pace dumps 300s of PCM immediately; CPU still needs wall-clock to
    // finish decoding. Settle until completed, up to the RTF=1.0 budget.
    rtf = runLive(
      ["--pace", "max", "--loop-seconds", "300", "--settle-ms", "300000"],
      "live-rtf-300.json",
      360_000,
    );
    writeFileSync(path.join(outDir, "live-rtf-300.summary.json"), JSON.stringify(rtf, null, 2) + "\n");
  } catch (e) {
    rtfErr = e;
  }

  killServe();
  process.removeAllListeners("exit");

  const peakRss = rssSamples.reduce((m, s) => Math.max(m, s.bytes), 0);
  writeFileSync(
    path.join(outDir, "rss.json"),
    JSON.stringify(
      {
        samples: rssSamples.length,
        peakBytes: peakRss,
        peakMiB: Math.round((peakRss / 1024 / 1024) * 10) / 10,
        limitBytes: RSS_LIMIT_BYTES,
      },
      null,
      2,
    ) + "\n",
  );

  const failures = [];
  if (!live.firstPartialText || live.deltaCount < 1) failures.push("no live partial text");
  if (!live.finalText) failures.push("no live final text");
  if (live.firstPartialMs == null || live.firstPartialMs > FIRST_PARTIAL_MAX_MS) {
    failures.push(`firstPartialMs ${live.firstPartialMs} > ${FIRST_PARTIAL_MAX_MS}`);
  }
  if (live.stopToFinalMs == null || live.stopToFinalMs > STOP_TO_FINAL_MAX_MS) {
    failures.push(`stopToFinalMs ${live.stopToFinalMs} > ${STOP_TO_FINAL_MAX_MS}`);
  }
  if (rtfErr) failures.push(`rtf run: ${rtfErr.message || rtfErr}`);
  if (!rtf) {
    failures.push("no rtf result");
  } else {
    if (!Number.isFinite(rtf.rtf) || rtf.rtf > RTF_MAX) {
      failures.push(`rtf ${rtf.rtf} > ${RTF_MAX}`);
    }
    if (rtf.audioDurationSec < 300) failures.push(`rtf audioDurationSec ${rtf.audioDurationSec} < 300`);
  }
  if (peakRss >= RSS_LIMIT_BYTES) {
    failures.push(`peak RSS ${peakRss} >= ${RSS_LIMIT_BYTES}`);
  }

  const report = {
    os: process.platform,
    arch: process.arch,
    bin,
    port,
    ready: readyBody,
    live,
    rtf: rtf && {
      pace: rtf.pace,
      audioDurationSec: rtf.audioDurationSec,
      firstPartialMs: rtf.firstPartialMs,
      stopToFinalMs: rtf.stopToFinalMs,
      rtf: rtf.rtf,
      wallMs: rtf.wallMs,
      deltaCount: rtf.deltaCount,
      finalText: (rtf.finalText || "").slice(0, 200),
    },
    peakRssBytes: peakRss,
    peakRssMiB: Math.round((peakRss / 1024 / 1024) * 10) / 10,
    failures,
  };
  writeFileSync(path.join(outDir, "gates.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) {
    throw new Error(`gates failed: ${failures.join("; ")}`);
  }
  console.log("ALL GATES PASSED");
}

await fetchAssets();
if (values["fetch-only"]) {
  console.log("fetch-only done");
  process.exit(0);
}
await runGates();
