#!/usr/bin/env node
/**
 * Throwaway native Linux/Windows CPU live-STT gates for #845.
 * Downloads pinned v0.1.0 CPU archives + Q8 GGUF, runs doctor, serve, one
 * live websocket turn, then optional 300 s max-pace RTF + RSS.
 *
 * API key is NEMO_SPEECH_HTTP_API_KEY (not argv; it showed up in ps on macOS).
 */
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PINS = JSON.parse(readFileSync(path.join(HERE, "pins.json"), "utf8"));
const WAV = path.join(HERE, "fixtures", "phrase-16k.wav");
const LIVE_CLIENT = path.join(HERE, "live-client.mjs");
const IS_WIN = process.platform === "win32";
const CACHE = process.env.SPIKE_CACHE || path.join(os.tmpdir(), "speech-spike");
const FIRST_PARTIAL_MS = PINS.gates.firstPartialMs;
const STOP_TO_FINAL_MS = PINS.gates.stopToFinalMs;
const RTF_GATE = PINS.gates.rtf;
const RSS_GATE_BYTES = PINS.gates.rssBytes;
const RUN_RTF = process.env.SPIKE_SKIP_RTF !== "1";

if (process.platform !== "linux" && process.platform !== "win32") {
  console.error(`ci-run.mjs is Linux/Windows CPU only, got ${process.platform}`);
  process.exit(2);
}

function log(msg) {
  console.log(msg);
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function downloadTo(url, dest) {
  mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const headers = {
    "User-Agent": "solenta-speech-spike/0.1 (currentbits/solenta#845)",
  };
  const hf = process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN;
  if (hf && /huggingface\.co/i.test(url)) {
    headers.Authorization = `Bearer ${hf}`;
  }
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      log(`download ${url} (attempt ${attempt})`);
      const res = await fetch(url, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(15 * 60 * 1000),
      });
      if (!res.ok || !res.body) {
        throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
      }
      const hash = createHash("sha256");
      const file = createWriteStream(tmp);
      let bytes = 0;
      let lastLog = 0;
      const nodeStream = Readable.fromWeb(res.body);
      for await (const chunk of nodeStream) {
        hash.update(chunk);
        if (!file.write(chunk)) {
          await new Promise((resolve) => file.once("drain", resolve));
        }
        bytes += chunk.length;
        if (bytes - lastLog >= 50 * 1024 * 1024) {
          lastLog = bytes;
          log(`  ... ${(bytes / 1048576).toFixed(0)} MiB`);
        }
      }
      await new Promise((resolve, reject) =>
        file.end((err) => (err ? reject(err) : resolve())),
      );
      return { tmp, bytes, sha256: hash.digest("hex") };
    } catch (err) {
      lastErr = err;
      console.error(`download failed: ${err.message || err}`);
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      await delay(2000 * attempt);
    }
  }
  throw lastErr;
}

async function ensureFile(url, dest, sha256, expectedBytes) {
  if (existsSync(dest)) {
    const st = statSync(dest);
    const got = await sha256File(dest);
    if (got === sha256 && (expectedBytes == null || st.size === expectedBytes)) {
      log(`cache hit ${path.basename(dest)} sha256=${got}`);
      return dest;
    }
    log(`cache mismatch ${path.basename(dest)} size=${st.size} sha256=${got}; re-downloading`);
    rmSync(dest, { force: true });
  }
  const { tmp, bytes, sha256: got } = await downloadTo(url, dest);
  if (got !== sha256) {
    rmSync(tmp, { force: true });
    throw new Error(`sha256 mismatch for ${url}: got ${got} want ${sha256}`);
  }
  if (expectedBytes != null && bytes !== expectedBytes) {
    rmSync(tmp, { force: true });
    throw new Error(`size mismatch for ${url}: got ${bytes} want ${expectedBytes}`);
  }
  renameSync(tmp, dest);
  log(`verified ${path.basename(dest)} ${bytes} bytes sha256=${got}`);
  return dest;
}

function walkFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(p, acc);
    else acc.push(p);
  }
  return acc;
}

function findBinary(extractDir) {
  const want = IS_WIN ? "nemo-speech.exe" : "nemo-speech";
  const files = walkFiles(extractDir);
  const hit = files.find((f) => path.basename(f) === want);
  if (!hit) {
    throw new Error(`no ${want} under ${extractDir}`);
  }
  return hit;
}

function extractArchive(archivePath, extractDir) {
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  const args = IS_WIN
    ? ["-xf", archivePath, "-C", extractDir]
    : ["-xzf", archivePath, "-C", extractDir];
  log(`extract ${path.basename(archivePath)}`);
  const r = spawnSync("tar", args, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`tar failed: ${r.stderr || r.stdout || r.status}`);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on("error", reject);
  });
}

function serveEnv(bin, token) {
  const env = { ...process.env, NEMO_SPEECH_HTTP_API_KEY: token };
  const binDir = path.dirname(bin);
  const libDir = path.join(binDir, "..", "lib");
  env.PATH = `${binDir}${path.delimiter}${env.PATH || ""}`;
  if (existsSync(libDir)) {
    env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH
      ? `${libDir}${path.delimiter}${env.LD_LIBRARY_PATH}`
      : libDir;
  }
  return env;
}

function runDoctor(bin, env) {
  log("=== nemo-speech doctor ===");
  const r = spawnSync(bin, ["doctor"], {
    encoding: "utf8",
    env,
    timeout: 120_000,
    windowsHide: true,
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  process.stdout.write(out);
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`doctor exited ${r.status}${r.signal ? ` signal=${r.signal}` : ""}`);
  }
  if (!/\[\d+\]\s+cpu\b/i.test(out)) {
    throw new Error("doctor output has no CPU device line");
  }
  return out;
}

function readRssBytes(pid) {
  if (!pid) return 0;
  if (IS_WIN) {
    try {
      const out = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `(Get-Process -Id ${Number(pid)}).WorkingSet64`,
        ],
        { encoding: "utf8", timeout: 5000, windowsHide: true },
      );
      const n = Number(String(out).trim());
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const m = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
    return m ? Number(m[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

function stopServe(child) {
  if (!child || child.killed || child.exitCode != null) return;
  const pid = child.pid;
  if (IS_WIN && pid) {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
}

async function waitReady(port, child, logPath, timeoutMs = 180_000) {
  const url = `http://127.0.0.1:${port}/ready`;
  const deadline = Date.now() + timeoutMs;
  let lastErr = "not attempted";
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      const tail = existsSync(logPath) ? readFileSync(logPath, "utf8").slice(-4000) : "";
      throw new Error(`serve exited ${child.exitCode} before /ready\n${tail}`);
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      const text = await res.text();
      if (res.ok) {
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          body = { raw: text };
        }
        log(`/ready ${text.trim()}`);
        const device = String(body.device || "").toLowerCase();
        if (body.ready !== true) throw new Error(`/ready ready!=true: ${text}`);
        if (device && !device.startsWith("cpu")) {
          throw new Error(`/ready device=${body.device}, want cpu`);
        }
        return body;
      }
      lastErr = `HTTP ${res.status} ${text.slice(0, 200)}`;
    } catch (err) {
      lastErr = err.message || String(err);
    }
    await delay(1000);
  }
  const tail = existsSync(logPath) ? readFileSync(logPath, "utf8").slice(-4000) : "";
  throw new Error(`/ready timeout: ${lastErr}\n${tail}`);
}

function runLiveClient(args) {
  const r = spawnSync(process.execPath, [LIVE_CLIENT, ...args], {
    encoding: "utf8",
    timeout: 700_000,
    windowsHide: true,
  });
  process.stdout.write(r.stdout || "");
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`live-client exited ${r.status}${r.signal ? ` signal=${r.signal}` : ""}`);
  }
}

function mintToken() {
  return randomBytes(24).toString("hex");
}

const failures = [];
const optionalFailures = [];
function gate(name, ok, detail, { optional = false } = {}) {
  const line = `${ok ? "PASS" : optional ? "OPTIONAL_FAIL" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`;
  log(line);
  if (!ok) (optional ? optionalFailures : failures).push(line);
}

async function main() {
  log(
    JSON.stringify(
      {
        platform: process.platform,
        arch: os.arch(),
        release: os.release(),
        cpus: os.cpus().length,
        totalmemMiB: Math.round(os.totalmem() / 1048576),
        node: process.version,
      },
      null,
      2,
    ),
  );
  if (!existsSync(WAV)) throw new Error(`missing fixture ${WAV}`);

  const runtime = IS_WIN ? PINS.windows : PINS.linux;
  const ggufPath = path.join(CACHE, "gguf", PINS.gguf.filename);
  const archivePath = path.join(CACHE, "runtime", runtime.archive);
  const extractDir = path.join(CACHE, "extract");
  const outDir = path.join(CACHE, "out");
  mkdirSync(outDir, { recursive: true });

  await ensureFile(PINS.gguf.url, ggufPath, PINS.gguf.sha256, PINS.gguf.bytes);
  await ensureFile(runtime.url, archivePath, runtime.sha256);

  extractArchive(archivePath, extractDir);
  const bin = findBinary(extractDir);
  log(`binary ${bin}`);

  const token = mintToken();
  const env = serveEnv(bin, token);
  const doctorOut = runDoctor(bin, env);
  gate("doctor-cpu", /cpu/i.test(doctorOut), "CPU device must appear");

  const port = await freePort();
  const serveLog = path.join(outDir, "serve.log");
  const serveFd = createWriteStream(serveLog);
  await new Promise((resolve) => serveFd.on("open", resolve));

  log(`=== serve 127.0.0.1:${port} device=cpu (api key via env) ===`);
  const child = spawn(
    bin,
    [
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
    ],
    {
      env,
      cwd: path.dirname(bin),
      stdio: ["ignore", serveFd, serveFd],
      windowsHide: true,
    },
  );
  let peakRss = 0;
  let rssSamples = 0;
  const rssTimer = setInterval(() => {
    const rss = readRssBytes(child.pid);
    if (rss > 0) {
      rssSamples += 1;
      if (rss > peakRss) peakRss = rss;
    }
  }, 1000);

  try {
    const ready = await waitReady(port, child, serveLog);
    gate(
      "ready-cpu",
      ready.ready === true && String(ready.device || "").toLowerCase().startsWith("cpu"),
      JSON.stringify(ready),
    );

    const modelsRes = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const modelsText = await modelsRes.text();
    if (!modelsRes.ok) {
      throw new Error(
        `GET /v1/models with env API key -> ${modelsRes.status} ${modelsText.slice(0, 300)}`,
      );
    }
    log(`/v1/models ${modelsText.slice(0, 300)}`);

    const liveOut = path.join(outDir, "live-phrase.json");
    log("=== live websocket phrase (realtime, 100ms PCM16) ===");
    runLiveClient([
      "--url",
      `ws://127.0.0.1:${port}/v1/realtime`,
      "--token",
      token,
      "--wav",
      WAV,
      "--pace",
      "realtime",
      "--out",
      liveOut,
    ]);
    const live = JSON.parse(readFileSync(liveOut, "utf8"));
    gate(
      "delta-and-completed",
      live.deltaCount >= 1 && live.completedCount >= 1 && Boolean(live.finalText),
      `deltas=${live.deltaCount} completed=${live.completedCount} text=${JSON.stringify(live.finalText)}`,
    );
    gate(
      "first-partial",
      live.firstPartialMs != null && live.firstPartialMs <= FIRST_PARTIAL_MS,
      `${live.firstPartialMs} ms (gate ≤ ${FIRST_PARTIAL_MS})`,
    );
    gate(
      "stop-to-final",
      live.stopToFinalMs != null && live.stopToFinalMs <= STOP_TO_FINAL_MS,
      `${live.stopToFinalMs} ms (gate ≤ ${STOP_TO_FINAL_MS})`,
    );

    let rtf = null;
    if (RUN_RTF) {
      await delay(1000);
      const rtfOut = path.join(outDir, "rtf-300.json");
      log("=== 300s audio max-pace RTF (optional; CPU backlog needs a long settle) ===");
      try {
        runLiveClient([
          "--url",
          `ws://127.0.0.1:${port}/v1/realtime`,
          "--token",
          token,
          "--wav",
          WAV,
          "--pace",
          "max",
          "--loop-seconds",
          "300",
          "--settle-ms",
          "360000",
          "--hard-timeout-ms",
          "600000",
          "--out",
          rtfOut,
        ]);
        rtf = JSON.parse(readFileSync(rtfOut, "utf8"));
        gate(
          "rtf-300",
          rtf.rtf != null && rtf.rtf <= RTF_GATE,
          `rtf=${rtf.rtf} wallMs=${rtf.wallMs} audio=${rtf.audioDurationSec}s (gate ≤ ${RTF_GATE})`,
          { optional: true },
        );
      } catch (err) {
        gate("rtf-300", false, err.message || String(err), { optional: true });
      }
    } else {
      log("skip 300s RTF (SPIKE_SKIP_RTF=1)");
    }

    const peakMiB = peakRss / 1048576;
    gate(
      "rss",
      rssSamples > 0 && peakRss > 0 && peakRss < RSS_GATE_BYTES,
      `peak=${peakMiB.toFixed(1)} MiB samples=${rssSamples} (gate < ${RSS_GATE_BYTES / 1048576} MiB)`,
      { optional: true },
    );

    const summary = {
      platform: process.platform,
      arch: os.arch(),
      device: ready.device,
      firstPartialMs: live.firstPartialMs,
      stopToFinalMs: live.stopToFinalMs,
      deltaCount: live.deltaCount,
      completedCount: live.completedCount,
      finalText: live.finalText,
      rtf: rtf ? rtf.rtf : null,
      rtfWallMs: rtf ? rtf.wallMs : null,
      peakRssMiB: Number(peakMiB.toFixed(1)),
      rssSamples,
      failures,
      optionalFailures,
    };
    writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
    log(`SPIKE_VERDICT: ${failures.length ? "FAIL" : "PASS"}`);
    log(JSON.stringify(summary, null, 2));
  } finally {
    clearInterval(rssTimer);
    stopServe(child);
    try {
      serveFd.end();
    } catch {
      /* ignore */
    }
  }

  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
