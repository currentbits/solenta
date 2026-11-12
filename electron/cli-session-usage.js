"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { resolveClaudeHome } = require("./cli-sessions-claude.js");
const { resolveCodexHome } = require("./cli-sessions-codex.js");
const { localDayKey } = require("./store-util.js");
const { applyModelPrices } = require("./modelPrices.js");

const MAX_LINE = 1024 * 1024;
const MAX_RECORDS = 200_000;
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_FILES = 10_000;
const count = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
const text = (v) => typeof v === "string" && v.length <= 256 ? v : "";
const model = (v) => ["__proto__", "constructor", "prototype"].includes(v) ? "" : text(v);
const counts = (u) => [count(u.input_tokens), count(u.cached_input_tokens), count(u.cache_write_input_tokens), count(u.output_tokens)];
const validUsage = (u, caches) => u && typeof u === "object" && !Array.isArray(u)
  && ["input_tokens", "output_tokens"].every((key) => Number.isSafeInteger(u[key]) && u[key] >= 0)
  && caches.every((key) => u[key] == null || (Number.isSafeInteger(u[key]) && u[key] >= 0));

/** Keep usage fields only; never retain conversation content in the cache. */
function parseUsage(row, provider, state) {
  const p = row.payload || {};
  if (provider === "codex") {
    if (row.type === "session_meta" && !state.session) {
      state.session = text(p.id) || text(p.session_id);
      state.fork = Boolean(p.forked_from_id || p.parent_thread_id || p.source?.subagent?.thread_spawn?.parent_thread_id);
      state.parent = text(p.forked_from_id) || text(p.parent_thread_id) || text(p.source?.subagent?.thread_spawn?.parent_thread_id);
    }
    if (row.type === "turn_context") {
      state.model = model(p.model);
      state.turn = text(p.turn_id);
    }
    if (row.type !== "event_msg" || p.type !== "token_count" || !p.info) return null;
  } else if (row.type !== "assistant" || !row.message?.usage) return null;

  const at = Date.parse(row.timestamp);
  if (!Number.isFinite(at)) return { skipped: true };
  if (provider === "claude") {
    const message = row.message;
    if (!text(message.id) || !model(message.model)) return { skipped: true };
    const u = message.usage;
    if (!validUsage(u, ["cache_read_input_tokens", "cache_creation_input_tokens"])) return { skipped: true };
    return {
      key: `claude:${message.id}`, at, provider, model: message.model,
      tokens: [count(u.input_tokens), count(u.cache_read_input_tokens), count(u.cache_creation_input_tokens), count(u.output_tokens)],
    };
  }
  const total = p.info.total_token_usage;
  const last = p.info.last_token_usage;
  // A fork without stable turn identity cannot distinguish copied history.
  if (!validUsage(last, ["cached_input_tokens", "cache_write_input_tokens"])
      || !validUsage(total, ["cached_input_tokens", "cache_write_input_tokens"])
      || !state.model || (!state.turn && (!state.session || state.fork))) return { skipped: true };
  const tokens = counts(last);
  if (tokens[1] + tokens[2] > tokens[0]) return { skipped: true };
  const signature = counts(total).join(":");
  if (signature === state.lastSignature) return null;
  state.lastSignature = signature;
  return {
    key: `codex:${state.turn ? `turn:${state.turn}` : `session:${state.session}`}:${signature}`,
    at, provider, model: state.model,
    session: state.session, fork: state.fork,
    tokens: [tokens[0] - tokens[1] - tokens[2], tokens[1], tokens[2], tokens[3]],
  };
}

function rootsFor(instances = []) {
  const homes = [
    { provider: "claude", home: resolveClaudeHome() },
    { provider: "codex", home: resolveCodexHome() },
  ];
  for (const instance of instances) {
    const key = instance.provider === "claude" ? "CLAUDE_CONFIG_DIR" : instance.provider === "codex" ? "CODEX_HOME" : null;
    if (key && instance.env?.[key]) homes.push({ provider: instance.provider, home: instance.env[key] });
  }
  return homes.flatMap(({ provider, home }) => (provider === "claude" ? ["projects"] : ["sessions", "archived_sessions"])
    .map((dir) => ({ provider, root: path.resolve(home, dir) })));
}

/** Async bounded traversal also covers archived rollouts and Claude subagents. */
async function discover(roots, stats) {
  const files = new Map();
  const seen = new Set();
  async function walk(dir, provider, depth) {
    if (files.size >= MAX_FILES || depth > 8) { stats.partial = true; return; }
    if (seen.has(dir)) return;
    seen.add(dir);
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch (error) { if (error.code !== "ENOENT") stats.skippedFiles++; return; }
    for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
      if (files.size >= MAX_FILES) { stats.partial = true; break; }
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file, provider, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const st = await fsp.lstat(file);
          if (st.isFile()) files.set(file, { file, provider, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, ctimeMs: st.ctimeMs });
        } catch { stats.skippedFiles++; }
      }
    }
  }
  for (const { root, provider } of roots) {
    try { await walk(await fsp.realpath(root), provider, 0); }
    catch (error) { if (error.code !== "ENOENT") stats.skippedFiles++; }
  }
  return [...files.values()].sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));
}

/** Stream bounded lines; an overlong tool-output line never fills the heap. */
async function readFile(info) {
  const records = [];
  const state = {};
  let skippedRecords = 0;
  let partial = false;
  const handle = await fsp.open(info.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.ino !== info.ino || st.size !== info.size || st.mtimeMs !== info.mtimeMs) throw new Error("changed");
    if (!st.size) return { records, skippedRecords, partial };
    let pending = Buffer.alloc(0);
    let skipping = false;
    const parse = (line) => {
      if (records.length >= MAX_RECORDS) { partial = true; return; }
      // Avoid decoding tool output and prompt bodies that cannot carry usage.
      if (!line.includes('"usage"') && !line.includes('"token_count"') && !line.includes('"session_meta"') && !line.includes('"turn_context"')) return;
      let row;
      try { row = JSON.parse(line.toString("utf8")); } catch { skippedRecords++; return; }
      if (!row || typeof row !== "object") return;
      const record = parseUsage(row, info.provider, state);
      if (record?.skipped) skippedRecords++;
      else if (record) records.push(record);
    };
    for await (const chunk of handle.createReadStream({ autoClose: false, end: st.size - 1, highWaterMark: 64 * 1024 })) {
      let start = 0;
      for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
        const segment = chunk.subarray(start, end);
        if (!skipping && pending.length + segment.length <= MAX_LINE) parse(pending.length ? Buffer.concat([pending, segment]) : segment);
        else skippedRecords++;
        pending = Buffer.alloc(0); skipping = false; start = end + 1;
      }
      const tail = chunk.subarray(start);
      if (!skipping && pending.length + tail.length <= MAX_LINE) pending = pending.length ? Buffer.concat([pending, tail]) : Buffer.from(tail);
      else { pending = Buffer.alloc(0); skipping = true; }
    }
    if (pending.length) parse(pending);
    if (skipping) skippedRecords++;
    const after = await handle.stat();
    if (after.size !== st.size || after.mtimeMs !== st.mtimeMs || after.ctimeMs !== st.ctimeMs) throw new Error("changed");
    return { records, skippedRecords, partial, session: state.session, parent: state.parent, fork: state.fork };
  } finally { await handle.close(); }
}

function createCliUsageReader() {
  const cache = new Map();
  let pending = Promise.resolve();
  async function scan({ instances = [], prices = {}, now = new Date() } = {}) {
    const stats = { files: 0, skippedFiles: 0, skippedRecords: 0, partial: false, unpricedModels: [] };
    const since = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 89).getTime();
    const files = await discover(rootsFor(instances), stats);
    const live = new Set(files.map((f) => f.file));
    for (const file of cache.keys()) if (!live.has(file)) cache.delete(file);
    const unique = new Map();
    const loadedSessions = new Map();
    let bytes = 0;
    let cachedRecords = 0;
    for (const info of files) {
      if (info.mtimeMs < since) { cache.delete(info.file); continue; }
      let entry = cache.get(info.file);
      const stamp = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      if (entry?.stamp !== stamp) {
        // shortcut: re-read growing logs; add guarded append offsets if refresh becomes slow.
        if (bytes + info.size > MAX_BYTES) { stats.partial = true; continue; }
        bytes += info.size;
        try { entry = { ...await readFile(info), stamp }; cache.set(info.file, entry); }
        catch { cache.delete(info.file); stats.skippedFiles++; continue; }
      }
      stats.files++;
      stats.skippedRecords += entry.skippedRecords;
      stats.partial ||= entry.partial;
      if (entry.session) loadedSessions.set(entry.session, {
        parent: entry.parent, fork: entry.fork, complete: !entry.partial && !entry.skippedRecords,
      });
      cachedRecords += entry.records.length;
      if (cachedRecords > MAX_RECORDS) cache.delete(info.file);
      for (const row of entry.records) {
        if (unique.size >= MAX_RECORDS && !unique.has(row.key)) {
          stats.partial = true;
          if (entry.session) loadedSessions.get(entry.session).complete = false;
          break;
        }
        const previous = unique.get(row.key);
        // Claude repeats usage on content blocks; keep the fullest snapshot.
        if (!previous) unique.set(row.key, row);
        else {
          const fullest = row.tokens.reduce((a, b) => a + b, 0) > previous.tokens.reduce((a, b) => a + b, 0) ? row : previous;
          unique.set(row.key, { ...fullest, at: Math.min(row.at, previous.at), fork: Boolean(row.fork && previous.fork) });
        }
      }
    }
    const ancestryKnown = (session) => {
      const visited = new Set();
      while (session && !visited.has(session)) {
        visited.add(session);
        const source = loadedSessions.get(session);
        if (!source?.complete) return false;
        if (!source.fork) return true;
        session = source.parent;
      }
      return false;
    };
    const byDay = Object.create(null);
    const unpriced = new Set();
    for (const row of unique.values()) {
      if (row.at < since || row.at > now.getTime()) continue;
      // Retimed fork copies need their original ancestor to recover the day.
      if (row.fork && !ancestryKnown(row.session)) { stats.skippedRecords++; continue; }
      if (!row.tokens.some((n) => n > 0)) continue;
      const models = ((byDay[localDayKey(new Date(row.at))] ??= Object.create(null))[row.provider] ??= Object.create(null));
      const cell = models[row.model] ??= { costUsd: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, turns: 0, wastedUsd: 0 };
      ["inputTokens", "cachedInputTokens", "cacheWriteTokens", "outputTokens"].forEach((key, index) => { cell[key] += row.tokens[index]; });
      cell.turns++;
      if (!Object.hasOwn(prices, row.model)) unpriced.add(row.model);
    }
    stats.unpricedModels = [...unpriced].sort();
    const report = applyModelPrices({ byDay, threadsByDay: {} }, prices);
    return { ...report, cli: stats };
  }
  return {
    read(input) {
      const next = pending.then(() => scan(input));
      pending = next.catch(() => {});
      return next;
    },
  };
}

module.exports = { createCliUsageReader, parseUsage, rootsFor };
