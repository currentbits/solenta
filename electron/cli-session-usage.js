"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { resolveClaudeHome } = require("./cli-sessions-claude.js");
const { resolveCodexHome } = require("./cli-sessions-codex.js");
const { localDayKey } = require("./store-util.js");
const { applyModelPrices } = require("./modelPrices.js");

const MAX_LINE = 1024 * 1024;
const MAX_RECORDS = 200_000;
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_FILES = 10_000;
/** Bytes hashed at the head and just before the resume offset to detect rewrites. */
const PROBE = 4096;
const count = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
const text = (v) => typeof v === "string" && v.length <= 256 ? v : "";
const model = (v) => ["__proto__", "constructor", "prototype"].includes(v) ? "" : text(v);
const counts = (u) => [count(u.input_tokens), count(u.cached_input_tokens), count(u.cache_write_input_tokens), count(u.output_tokens)];
const validUsage = (u, caches) => u && typeof u === "object" && !Array.isArray(u)
  && ["input_tokens", "output_tokens"].every((key) => Number.isSafeInteger(u[key]) && u[key] >= 0)
  && caches.every((key) => u[key] == null || (Number.isSafeInteger(u[key]) && u[key] >= 0));
const reportedCost = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;

/** Keep usage fields only; never retain conversation content in the cache. */
function parseUsage(row, provider, state) {
  const p = row.payload || {};
  if (provider === "codex") {
    if (row.type === "session_meta" && !state.session) {
      const spawnParent = text(p.source?.subagent?.thread_spawn?.parent_thread_id);
      state.session = text(p.id) || text(p.session_id);
      state.fork = Boolean(p.forked_from_id || p.parent_thread_id || spawnParent);
      state.parent = text(p.forked_from_id) || text(p.parent_thread_id) || spawnParent;
      // A spawned subagent belongs to its parent's run; a fork does not.
      state.subagentOf = spawnParent;
    }
    if (row.type === "turn_context") {
      state.model = model(p.model);
      state.turn = text(p.turn_id);
    }
    if (row.type !== "event_msg" || p.type !== "token_count" || !p.info) return null;
  } else {
    // Subagent sidechains carry their parent's sessionId.
    if (!state.session && text(row.sessionId)) state.session = row.sessionId;
    if (row.type !== "assistant" || !row.message?.usage) return null;
  }

  const at = Date.parse(row.timestamp);
  if (!Number.isFinite(at)) return { skipped: true };
  if (provider === "claude") {
    const message = row.message;
    if (!text(message.id) || !model(message.model)) return { skipped: true };
    const u = message.usage;
    if (!validUsage(u, ["cache_read_input_tokens", "cache_creation_input_tokens"])) return { skipped: true };
    const cost = reportedCost(row.costUSD);
    return {
      key: `claude:${message.id}`, at, provider, model: message.model, session: state.session || "",
      tokens: [count(u.input_tokens), count(u.cache_read_input_tokens), count(u.cache_creation_input_tokens), count(u.output_tokens)],
      ...(cost !== undefined ? { costUsd: cost } : {}),
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

/**
 * Every local home the user can pick, each isolated by id: the default
 * Claude/Codex homes plus each configured instance's own home.
 */
function homesFor(instances = []) {
  const homes = [
    { id: "claude", provider: "claude", label: "Claude Code", home: resolveClaudeHome() },
    { id: "codex", provider: "codex", label: "Codex", home: resolveCodexHome() },
  ];
  for (const instance of instances) {
    const key = instance.provider === "claude" ? "CLAUDE_CONFIG_DIR" : instance.provider === "codex" ? "CODEX_HOME" : null;
    if (key && instance.env?.[key]) {
      homes.push({ id: `instance:${instance.ref}`, provider: instance.provider, label: instance.name || instance.ref, home: instance.env[key] });
    }
  }
  return homes;
}

function rootsFor(homes) {
  return homes.flatMap(({ id, provider, home }) => (provider === "claude" ? ["projects"] : ["sessions", "archived_sessions"])
    .map((dir) => ({ homeId: id, provider, root: path.resolve(home, dir) })));
}

/** Async bounded traversal also covers archived rollouts and Claude subagents. */
async function discover(roots, stats) {
  const files = new Map();
  const seen = new Set();
  async function walk(dir, root, depth) {
    if (files.size >= MAX_FILES || depth > 8) { stats.partial = true; return; }
    if (seen.has(dir)) return;
    seen.add(dir);
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch (error) { if (error.code !== "ENOENT") stats.skippedFiles++; return; }
    for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
      if (files.size >= MAX_FILES) { stats.partial = true; break; }
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file, root, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const st = await fsp.lstat(file);
          if (st.isFile()) files.set(file, { file, provider: root.provider, homeId: root.homeId, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, ctimeMs: st.ctimeMs });
        } catch (error) { if (error.code === "ENOENT") stats.missingFiles++; else stats.skippedFiles++; }
      }
    }
  }
  for (const root of roots) {
    try { await walk(await fsp.realpath(root.root), root, 0); }
    catch (error) { if (error.code !== "ENOENT") stats.skippedFiles++; }
  }
  return [...files.values()].sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));
}

async function digest(handle, start, end) {
  const length = Math.max(0, end - start);
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(buffer, read, length - read, start + read);
    if (!bytesRead) break;
    read += bytesRead;
  }
  return crypto.createHash("sha256").update(buffer.subarray(0, read)).digest("hex");
}

/** Hashes of the head and of the bytes just before `offset`; a rewrite changes either. */
async function probe(handle, offset) {
  return `${await digest(handle, 0, Math.min(PROBE, offset))}:${await digest(handle, Math.max(0, offset - PROBE), offset)}`;
}

/**
 * Stream complete lines from where the previous read stopped. Same inode,
 * no shrink and an unchanged probe mean the file only grew; anything else
 * (truncation, replacement, in-place rewrite) restarts from byte 0. An
 * unterminated last line is left unconsumed and re-read next time.
 */
async function readFile(info, prev) {
  const handle = await fsp.open(info.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new Error("changed");
    const grown = prev && prev.ino === st.ino && st.size >= prev.offset && await probe(handle, prev.offset) === prev.probe;
    const entry = grown
      ? { ...prev, records: prev.records.slice(), state: { ...prev.state } }
      : { ino: st.ino, offset: 0, records: [], state: {}, skippedRecords: 0, partial: false };
    entry.rewritten = Boolean(prev && !grown);
    entry.readFrom = entry.offset;
    entry.tail = false;
    const parse = (line) => {
      if (entry.records.length >= MAX_RECORDS) { entry.partial = true; return; }
      // Avoid decoding tool output and prompt bodies that cannot carry usage.
      if (!line.includes('"usage"') && !line.includes('"token_count"') && !line.includes('"session_meta"')
        && !line.includes('"turn_context"') && !line.includes('"sessionId"')) return;
      let row;
      try { row = JSON.parse(line.toString("utf8")); } catch { entry.skippedRecords++; return; }
      if (!row || typeof row !== "object") return;
      const record = parseUsage(row, info.provider, entry.state);
      if (record?.skipped) entry.skippedRecords++;
      else if (record) entry.records.push(record);
    };
    if (st.size > entry.offset) {
      let pending = Buffer.alloc(0);
      // Resuming inside an overlong line keeps skipping it to its newline.
      let skipping = Boolean(entry.skipLine);
      let consumed = entry.offset;
      for await (const chunk of handle.createReadStream({ autoClose: false, start: entry.offset, end: st.size - 1, highWaterMark: 64 * 1024 })) {
        let start = 0;
        for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
          const segment = chunk.subarray(start, end);
          if (!skipping && pending.length + segment.length <= MAX_LINE) parse(pending.length ? Buffer.concat([pending, segment]) : segment);
          else entry.skippedRecords++;
          consumed += pending.length + segment.length + 1;
          pending = Buffer.alloc(0); skipping = false; start = end + 1;
        }
        const tail = chunk.subarray(start);
        if (skipping || pending.length + tail.length > MAX_LINE) { consumed += pending.length + tail.length; pending = Buffer.alloc(0); skipping = true; }
        else pending = pending.length ? Buffer.concat([pending, tail]) : Buffer.from(tail);
      }
      // An overlong unterminated line is already skipped; a short one waits for its newline.
      entry.tail = pending.length > 0 || skipping;
      entry.skipLine = skipping;
      entry.offset = consumed;
    }
    entry.probe = await probe(handle, entry.offset);
    // Appends after the snapshot are picked up next scan; shrink/replace is not safe.
    const after = await handle.stat();
    if (after.ino !== st.ino || after.size < st.size) throw new Error("changed");
    Object.assign(entry, { size: st.size, stamp: `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}` });
    entry.session = entry.state.session;
    entry.parent = entry.state.parent;
    entry.fork = entry.state.fork;
    entry.subagentOf = entry.state.subagentOf;
    return entry;
  } finally { await handle.close(); }
}

/**
 * @param {{ claude?: Record<string, number>, codex?: Record<string, number> }} [owned]
 *   Provider session id → epoch ms from which that session's responses were
 *   Solenta's (the owning thread's creation; earlier history was imported).
 */
function ownership(owned = {}) {
  const since = (provider, session) => session && Object.hasOwn(owned[provider] || {}, session) ? owned[provider][session] : undefined;
  return (entry, provider, row) => {
    const from = since(provider, row.session || entry.session) ?? since(provider, entry.subagentOf);
    return from !== undefined && row.at >= from;
  };
}

function createCliUsageReader() {
  const cache = new Map();
  let pending = Promise.resolve();
  async function scan({ instances = [], homes: selected, owned, scope = "cli", prices = {}, now = new Date() } = {}) {
    const stats = {
      files: 0, skippedFiles: 0, missingFiles: 0, skippedRecords: 0, partial: false, unpricedModels: [],
      scope, solentaResponses: 0, rereadFiles: 0, reportedCostUsd: 0, estimatedCostUsd: 0, homes: [],
    };
    const all = homesFor(instances);
    const chosen = all.filter((home) => !Array.isArray(selected) || selected.includes(home.id));
    stats.homes = all.map(({ id, provider, label }) => ({ id, provider, label, selected: chosen.some((home) => home.id === id) }));
    const chosenIds = new Set(chosen.map((home) => home.id));
    const isOwned = ownership(owned);
    const since = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 89).getTime();
    const files = await discover(rootsFor(chosen), stats);
    const live = new Set(files.map((f) => f.file));
    for (const [file, entry] of cache) {
      if (live.has(file)) continue;
      // A previously read log of a selected home vanished: its history is gone.
      if (chosenIds.has(entry.homeId)) stats.missingFiles++;
      if (chosenIds.has(entry.homeId) || !all.some((home) => home.id === entry.homeId)) cache.delete(file);
    }
    const unique = new Map();
    const loadedSessions = new Map();
    let bytes = 0;
    let cachedRecords = 0;
    for (const info of files) {
      if (info.mtimeMs < since) { cache.delete(info.file); continue; }
      let entry = cache.get(info.file);
      const stamp = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      if (entry?.stamp !== stamp) {
        const appendOnly = entry && entry.ino === info.ino && info.size >= entry.offset;
        const need = appendOnly ? info.size - entry.offset : info.size;
        if (bytes + need > MAX_BYTES) { stats.partial = true; cache.delete(info.file); continue; }
        bytes += need;
        try {
          entry = { ...await readFile(info, entry), homeId: info.homeId };
          cache.set(info.file, entry);
          if (entry.rewritten) stats.rereadFiles++;
        } catch (error) {
          cache.delete(info.file);
          if (error.code === "ENOENT") stats.missingFiles++; else stats.skippedFiles++;
          continue;
        }
      }
      stats.files++;
      stats.skippedRecords += entry.skippedRecords + (entry.tail ? 1 : 0);
      stats.partial ||= entry.partial;
      if (entry.session && info.provider === "codex") loadedSessions.set(entry.session, {
        parent: entry.parent, fork: entry.fork, complete: !entry.partial && !entry.skippedRecords,
      });
      cachedRecords += entry.records.length;
      if (cachedRecords > MAX_RECORDS) cache.delete(info.file);
      for (const row of entry.records) {
        if (unique.size >= MAX_RECORDS && !unique.has(row.key)) {
          stats.partial = true;
          if (entry.session && loadedSessions.has(entry.session)) loadedSessions.get(entry.session).complete = false;
          break;
        }
        const owns = isOwned(entry, info.provider, row);
        const previous = unique.get(row.key);
        // Claude repeats usage on content blocks; keep the fullest snapshot.
        // A response Solenta ran anywhere (fork/resume copies too) stays Solenta's.
        if (!previous) unique.set(row.key, { ...row, owned: owns });
        else {
          const fullest = row.tokens.reduce((a, b) => a + b, 0) > previous.tokens.reduce((a, b) => a + b, 0) ? row : previous;
          const cost = fullest.costUsd ?? previous.costUsd ?? row.costUsd;
          unique.set(row.key, {
            ...fullest, at: Math.min(row.at, previous.at), fork: Boolean(row.fork && previous.fork), owned: previous.owned || owns,
            ...(cost !== undefined ? { costUsd: cost } : {}),
          });
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
      if (scope === "external" && row.owned) { stats.solentaResponses++; continue; }
      // Retimed fork copies need their original ancestor to recover the day.
      if (row.fork && !ancestryKnown(row.session)) { stats.skippedRecords++; continue; }
      if (!row.tokens.some((n) => n > 0)) continue;
      const models = ((byDay[localDayKey(new Date(row.at))] ??= Object.create(null))[row.provider] ??= Object.create(null));
      const cell = models[row.model] ??= {
        costUsd: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, turns: 0, wastedUsd: 0,
        unpricedTokens: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
      };
      ["inputTokens", "cachedInputTokens", "cacheWriteTokens", "outputTokens"].forEach((key, index) => {
        cell[key] += row.tokens[index];
        // Only responses without a CLI-reported cost may get an API-rate estimate.
        if (row.costUsd === undefined) cell.unpricedTokens[key] += row.tokens[index];
      });
      cell.turns++;
      if (row.costUsd !== undefined) { cell.costUsd += row.costUsd; stats.reportedCostUsd += row.costUsd; }
      else if (!Object.hasOwn(prices, row.model)) unpriced.add(row.model);
    }
    stats.unpricedModels = [...unpriced].sort();
    const report = applyModelPrices({ byDay, threadsByDay: {} }, prices);
    let total = 0;
    for (const providers of Object.values(report.byDay)) for (const models of Object.values(providers)) for (const cell of Object.values(models)) total += cell.costUsd;
    stats.estimatedCostUsd = Math.max(0, total - stats.reportedCostUsd);
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

module.exports = { createCliUsageReader, parseUsage, homesFor, rootsFor };
