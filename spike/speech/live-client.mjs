#!/usr/bin/env node
/**
 * Throwaway NeMo-Speech.cpp v0.1.0 realtime WebSocket client.
 * Streams 16 kHz mono little-endian PCM16 from a WAV file as ~100 ms frames.
 *
 * Usage:
 *   node live-client.mjs --url ws://127.0.0.1:PORT/v1/realtime --token TOKEN \
 *     --wav path.wav [--pace realtime|max] [--loop-seconds 300] [--out result.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    token: { type: "string" },
    wav: { type: "string" },
    pace: { type: "string", default: "realtime" },
    "loop-seconds": { type: "string", default: "0" },
    out: { type: "string" },
    "settle-ms": { type: "string", default: "15000" },
  },
});

if (!values.url || !values.token || !values.wav) {
  console.error("need --url --token --wav");
  process.exit(2);
}

const CHUNK_MS = 100;
const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const CHUNK_BYTES = (SAMPLE_RATE * BYTES_PER_SAMPLE * CHUNK_MS) / 1000; // 3200

function pcm16FromWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF") throw new Error("not RIFF");
  let offset = 12;
  let dataStart = -1;
  let dataSize = 0;
  let sr = 0;
  let ch = 0;
  let bps = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      ch = buf.readUInt16LE(body + 2);
      sr = buf.readUInt32LE(body + 4);
      bps = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      dataStart = body;
      dataSize = size;
      break;
    }
    offset = body + size + (size % 2);
  }
  if (dataStart < 0) throw new Error("no data chunk");
  if (sr !== SAMPLE_RATE || ch !== 1 || bps !== 16) {
    throw new Error(`expected 16kHz mono PCM16, got sr=${sr} ch=${ch} bps=${bps}`);
  }
  return buf.subarray(dataStart, dataStart + dataSize);
}

function eventText(msg) {
  if (!msg || typeof msg !== "object") return "";
  if (typeof msg.transcript === "string") return msg.transcript;
  if (typeof msg.text === "string") return msg.text;
  if (typeof msg.delta === "string") return msg.delta;
  const item = msg.item;
  if (item && typeof item === "object") {
    if (typeof item.transcript === "string") return item.transcript;
    const tr = item.input_audio_transcription;
    if (tr && typeof tr.transcript === "string") return tr.transcript;
    if (tr && typeof tr.text === "string") return tr.text;
  }
  return "";
}

const pcm = pcm16FromWav(readFileSync(values.wav));
const loopSeconds = Number(values["loop-seconds"] || 0);
const targetBytes =
  loopSeconds > 0 ? Math.ceil(loopSeconds * SAMPLE_RATE * BYTES_PER_SAMPLE) : pcm.length;
const audioDurationSec = targetBytes / (SAMPLE_RATE * BYTES_PER_SAMPLE);
const pace = values.pace === "max" ? "max" : "realtime";

const wsUrl = new URL(values.url);
wsUrl.searchParams.set("api_key", values.token);

const events = [];
const deltas = [];
const completed = [];
let sessionCreatedAt = null;
let firstAudioAt = null;
let lastAudioAt = null;
let commitAt = null;
let firstPartialAt = null;
let firstPartialText = "";
let lastPartialText = "";
let finalText = "";
let committedAt = null;
let completedAt = null;
let errorEvent = null;

function stamp(obj) {
  const rec = { t: Date.now(), ...obj };
  events.push(rec);
  return rec;
}

await new Promise((resolve, reject) => {
  const ws = new WebSocket(wsUrl);
  const settleMs = Number(values["settle-ms"] || 15000);
  let settled = false;
  let sessionUpdated = false;
  let sending = false;

  const finish = (err) => {
    if (settled) return;
    settled = true;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    if (err) reject(err);
    else resolve();
  };

  const hardTimeoutMs =
    settleMs +
    15_000 +
    (pace === "realtime" ? audioDurationSec * 1000 + 5_000 : Math.max(90_000, audioDurationSec * 1000));
  setTimeout(() => {
    if (!settled) finish(new Error(`timeout after ${hardTimeoutMs}ms`));
  }, hardTimeoutMs);

  ws.addEventListener("open", () => stamp({ kind: "socket.open" }));
  ws.addEventListener("error", (e) => {
    stamp({ kind: "socket.error", message: String(e.message || e) });
    finish(new Error(`websocket error: ${e.message || e}`));
  });
  ws.addEventListener("close", (e) => {
    stamp({ kind: "socket.close", code: e.code, reason: e.reason });
    if (!settled) {
      if (completedAt) finish();
      else finish(new Error(`socket closed before completed code=${e.code}`));
    }
  });

  async function sendAudio(socket) {
    let sent = 0;
    firstAudioAt = Date.now();
    while (sent < targetBytes) {
      if (settled) return;
      const remain = targetBytes - sent;
      const take = Math.min(CHUNK_BYTES, remain);
      const chunk = Buffer.alloc(take);
      for (let i = 0; i < take; i++) chunk[i] = pcm[(sent + i) % pcm.length];
      socket.send(chunk);
      sent += take;
      if (pace === "realtime" && take === CHUNK_BYTES) {
        await new Promise((r) => setTimeout(r, CHUNK_MS));
      }
    }
    lastAudioAt = Date.now();
    commitAt = Date.now();
    socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    stamp({ kind: "commit", sentBytes: sent });
    const deadline = Date.now() + settleMs;
    while (!completedAt && Date.now() < deadline && !settled) {
      await new Promise((r) => setTimeout(r, 20));
    }
    if (!completedAt) finish(new Error(`no completed event within ${settleMs}ms after commit`));
    else finish();
  }

  function kickSend() {
    if (sending || settled) return;
    sending = true;
    sendAudio(ws).catch(finish);
  }

  ws.addEventListener("message", (ev) => {
    let msg;
    if (typeof ev.data === "string") {
      try {
        msg = JSON.parse(ev.data);
      } catch {
        stamp({ kind: "recv.raw", data: ev.data.slice(0, 200) });
        return;
      }
    } else {
      stamp({ kind: "recv.binary", bytes: ev.data?.byteLength || 0 });
      return;
    }
    const type = msg.type || "unknown";
    stamp({ kind: "recv", type, msg });
    if (type === "session.created") {
      sessionCreatedAt = Date.now();
      ws.send(
        JSON.stringify({
          type: "session.update",
          session: { sample_rate: SAMPLE_RATE, automatic_punctuation: true },
        }),
      );
      setTimeout(() => {
        if (!sessionUpdated) kickSend();
      }, 1500);
      return;
    }
    if (type === "session.updated") {
      sessionUpdated = true;
      kickSend();
      return;
    }
    if (type === "error") {
      errorEvent = msg;
      return;
    }
    if (type === "input_audio_buffer.committed") {
      committedAt = Date.now();
      return;
    }
    if (type === "conversation.item.input_audio_transcription.delta") {
      const text = eventText(msg);
      deltas.push({ t: Date.now(), text, msg });
      if (!firstPartialAt && text) {
        firstPartialAt = Date.now();
        firstPartialText = text;
      }
      if (text) lastPartialText = text;
      return;
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      completedAt = Date.now();
      finalText = eventText(msg) || lastPartialText;
      completed.push({ t: completedAt, text: finalText, msg });
    }
  });
});

const firstPartialMs =
  firstPartialAt && firstAudioAt ? firstPartialAt - firstAudioAt : null;
const stopToFinalMs =
  completedAt && commitAt ? completedAt - commitAt : null;
const wallMs = (completedAt || Date.now()) - (firstAudioAt || Date.now());
const rtf = wallMs / 1000 / audioDurationSec;

const result = {
  pace,
  audioDurationSec,
  targetBytes,
  chunkBytes: CHUNK_BYTES,
  sessionCreatedAt,
  firstAudioAt,
  lastAudioAt,
  commitAt,
  committedAt,
  firstPartialAt,
  firstPartialMs,
  firstPartialText,
  lastPartialText,
  completedAt,
  stopToFinalMs,
  finalText,
  wallMs,
  rtf,
  deltaCount: deltas.length,
  completedCount: completed.length,
  errorEvent,
  events: events.map((e) =>
    e.kind === "recv" ? { t: e.t, kind: e.kind, type: e.type, msg: e.msg } : e,
  ),
};

if (values.out) writeFileSync(values.out, JSON.stringify(result, null, 2));
console.log(
  JSON.stringify(
    {
      pace,
      audioDurationSec,
      firstPartialMs,
      stopToFinalMs,
      rtf,
      wallMs,
      deltaCount: deltas.length,
      firstPartialText,
      finalText,
      errorEvent,
    },
    null,
    2,
  ),
);
if (!firstPartialAt || !completedAt) process.exit(1);
if (errorEvent && !finalText) process.exit(1);
