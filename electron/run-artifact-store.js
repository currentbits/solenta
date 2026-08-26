"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  DEFAULT_LIMITS,
  artifactError,
  probeRunArtifact,
} = require("./run-artifact-media.js");

const STAGING_DIR = ".staging";
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;
const VALID_SOURCES = new Set([
  "simulator",
  "verification",
  "browser",
  "manual",
]);
const MIME_BY_KIND = {
  image: "image/png",
  video: "video/mp4",
};
const EXT_BY_KIND = {
  image: "png",
  video: "mp4",
};

/**
 * @param {object} limits
 */
function mergeLimits(limits) {
  return { ...DEFAULT_LIMITS, ...limits };
}

/**
 * @param {unknown} id
 */
function isSafeOpaqueId(id) {
  const value = String(id || "");
  return value.length > 0 && SAFE_ID_RE.test(value) && value === path.basename(value);
}

/**
 * @param {object} artifact
 */
function isValidArtifactMetadata(artifact) {
  if (!artifact || typeof artifact !== "object") return false;
  if (!isSafeOpaqueId(artifact.id)) return false;
  if (!isSafeOpaqueId(artifact.threadId)) return false;
  if (artifact.runId != null && !isSafeOpaqueId(artifact.runId)) return false;
  if (!VALID_SOURCES.has(artifact.source)) return false;
  if (artifact.kind !== "image" && artifact.kind !== "video") return false;
  if (artifact.mimeType !== MIME_BY_KIND[artifact.kind]) return false;
  if (!artifact.name || typeof artifact.name !== "string") return false;
  if (path.isAbsolute(artifact.name)) return false;
  if (!Number.isFinite(artifact.size) || artifact.size <= 0) return false;
  if (!artifact.createdAt) return false;
  return true;
}

/**
 * @param {object} store
 * @param {string} threadId
 */
function sumThreadBytes(store, threadId) {
  return store
    .getRunArtifacts(threadId)
    .slice()
    .filter(isValidArtifactMetadata)
    .reduce((sum, artifact) => sum + artifact.size, 0);
}

/**
 * @param {object} store
 */
function sumGlobalBytes(store) {
  let total = 0;
  const threads =
    store && typeof store.getThreads === "function" ? store.getThreads() : [];
  for (const thread of threads) {
    if (!thread || !thread.id) continue;
    total += sumThreadBytes(store, String(thread.id));
  }
  return total;
}

/**
 * @param {object} artifact
 */
function artifactFileRelPath(artifact) {
  const runDir = artifact.runId ? String(artifact.runId) : "manual";
  const ext = EXT_BY_KIND[artifact.kind];
  return path.join(
    String(artifact.threadId),
    runDir,
    `${String(artifact.id)}.${ext}`,
  );
}

/**
 * @param {string} root
 * @param {string} threadId
 * @param {string | null} runId
 */
function resolveDestDir(root, threadId, runId) {
  if (!isSafeOpaqueId(threadId)) {
    throw artifactError("invalid_artifact", "Invalid thread id");
  }
  if (runId != null && !isSafeOpaqueId(runId)) {
    throw artifactError("invalid_artifact", "Invalid run id");
  }
  const runDir = runId || "manual";
  const rootResolved = path.resolve(root);
  const destDir = path.resolve(root, threadId, runDir);
  if (
    destDir !== rootResolved &&
    !destDir.startsWith(rootResolved + path.sep)
  ) {
    throw artifactError("invalid_artifact", "Artifact path escapes root");
  }
  return destDir;
}

function createRunArtifactStore({
  userDataPath,
  store,
  now = Date.now,
  randomUUID = crypto.randomUUID,
  probeFile = probeRunArtifact,
  syncFile = defaultSyncFile,
  openStagingFile = defaultOpenStagingFile,
  renameFile = fs.promises.rename.bind(fs.promises),
  limits = {},
  beforePersist = null,
}) {
  const mergedLimits = mergeLimits(limits);
  const root = path.join(userDataPath, "run-artifacts");
  const stagingRoot = path.join(root, STAGING_DIR);
  /** @type {Map<string, { token: string, path: string, kind: string, mimeType: string, createdAt: number }>} */
  const staged = new Map();
  /** @type {Set<string>} */
  const inFlightDestPaths = new Set();
  let mutationChain = Promise.resolve();

  /**
   * @param {() => Promise<unknown>} fn
   */
  function enqueueMutation(fn) {
    const run = mutationChain.then(fn);
    mutationChain = run.catch(() => {});
    return run;
  }

  async function ensureStagingRoot() {
    await fs.promises.mkdir(stagingRoot, { recursive: true });
  }

  /**
   * @param {{ kind: "image" | "video", mimeType: string }} opts
   */
  async function stage(opts) {
    const kind = opts && opts.kind;
    const mimeType = opts && opts.mimeType;
    if (kind !== "image" && kind !== "video") {
      throw artifactError("invalid_artifact", "Unsupported artifact kind");
    }
    if (mimeType !== MIME_BY_KIND[kind]) {
      throw artifactError("invalid_artifact", "Unsupported artifact MIME type");
    }
    await ensureStagingRoot();
    const token = randomUUID();
    const filePath = path.join(stagingRoot, `${token}.bin`);
    const entry = {
      token,
      path: filePath,
      kind,
      mimeType,
      createdAt: now(),
    };
    staged.set(token, entry);
    try {
      const fh = await openStagingFile(filePath);
      await fh.close();
    } catch (err) {
      staged.delete(token);
      throw err;
    }
    return { token, path: filePath };
  }

  /**
   * @param {string} token
   */
  async function discard(token) {
    const entry = staged.get(String(token || ""));
    if (!entry) return;
    staged.delete(entry.token);
    try {
      await fs.promises.unlink(entry.path);
    } catch {
      // already removed
    }
  }

  /**
   * @param {object} item
   */
  function validateCommitItemShape(item) {
    if (!item || typeof item !== "object") {
      throw artifactError("invalid_artifact", "Invalid commit item");
    }
    if (item.path != null) {
      throw artifactError("invalid_artifact", "Caller path is not allowed");
    }
    const key = String(item.key || "");
    if (!key) {
      throw artifactError("invalid_artifact", "Commit item key is required");
    }
    const name = String(item.name || "");
    if (!name || path.isAbsolute(name)) {
      throw artifactError("invalid_artifact", "Invalid artifact name");
    }
    if (item.kind !== "image" && item.kind !== "video") {
      throw artifactError("invalid_artifact", "Unsupported artifact kind");
    }
    if (item.mimeType !== MIME_BY_KIND[item.kind]) {
      throw artifactError("invalid_artifact", "Unsupported artifact MIME type");
    }
    const token = String(item.stagingToken || "");
    if (!token) {
      throw artifactError("invalid_artifact", "Invalid staging token");
    }
    const entry = staged.get(token);
    if (!entry) {
      throw artifactError("invalid_artifact", "Invalid staging token");
    }
    if (entry.kind !== item.kind || entry.mimeType !== item.mimeType) {
      throw artifactError("invalid_artifact", "Staging kind mismatch");
    }
    return { item, entry, key, token };
  }

  /**
   * @param {object[]} items
   */
  function validateBatchItemIdentity(items) {
    const keys = new Set();
    const tokens = new Set();
    for (const item of items) {
      if (!item || typeof item !== "object") {
        throw artifactError("invalid_artifact", "Invalid commit item");
      }
      const key = String(item.key || "");
      if (keys.has(key)) {
        throw artifactError("invalid_artifact", "Duplicate commit item key");
      }
      keys.add(key);
      const token = String(item.stagingToken || "");
      if (tokens.has(token)) {
        throw artifactError("invalid_artifact", "Duplicate staging token");
      }
      tokens.add(token);
    }
  }

  /**
   * @param {Array<{ destPath: string, stagingPath: string, token: string, kind: string, mimeType: string, createdAt: number }>} moves
   */
  async function rollbackMoves(moves) {
    for (const move of moves) {
      inFlightDestPaths.delete(move.destPath);
      try {
        await renameFile(move.destPath, move.stagingPath);
        staged.set(move.token, {
          token: move.token,
          path: move.stagingPath,
          kind: move.kind,
          mimeType: move.mimeType,
          createdAt: move.createdAt,
        });
      } catch {
        // unrecoverable orphan; cleanup can reclaim once inFlight is cleared.
      }
    }
  }

  /**
   * @param {unknown} source
   */
  function validateSource(source) {
    if (!VALID_SOURCES.has(source)) {
      throw artifactError("invalid_artifact", "Invalid artifact source");
    }
  }

  async function cleanupUnlocked() {
    const referenced = new Set();
    const threads =
      store && typeof store.getThreads === "function" ? store.getThreads() : [];
    for (const thread of threads) {
      if (!thread || !thread.id) continue;
      const artifacts = store.getRunArtifacts(String(thread.id)).slice();
      for (const artifact of artifacts) {
        if (!isValidArtifactMetadata(artifact)) continue;
        referenced.add(path.join(root, artifactFileRelPath(artifact)));
      }
    }

    for (const entry of staged.values()) {
      referenced.add(entry.path);
    }
    for (const destPath of inFlightDestPaths) {
      referenced.add(destPath);
    }

    try {
      await fs.promises.mkdir(stagingRoot, { recursive: true });
      const stagingEntries = await fs.promises.readdir(stagingRoot);
      for (const name of stagingEntries) {
        const full = path.join(stagingRoot, name);
        if (referenced.has(full)) continue;
        try {
          await fs.promises.unlink(full);
        } catch {
          // ignore
        }
      }
    } catch {
      // staging dir missing
    }

    async function walk(dir) {
      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === STAGING_DIR) continue;
          await walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        if (referenced.has(full)) continue;
        try {
          await fs.promises.unlink(full);
        } catch {
          // ignore
        }
      }
    }

    await walk(root);
  }

  async function cleanup() {
    return enqueueMutation(() => cleanupUnlocked());
  }

  async function commitBatchUnlocked(batch) {
    const threadId = String(batch && batch.threadId || "");
    if (!threadId || !store.getThread(threadId)) {
      throw artifactError("invalid_artifact", "Thread not found");
    }
    if (!isSafeOpaqueId(threadId)) {
      throw artifactError("invalid_artifact", "Invalid thread id");
    }
    validateSource(batch && batch.source);

    const items = batch && batch.items;
    if (!Array.isArray(items) || items.length === 0) {
      throw artifactError("invalid_artifact", "Commit batch is empty");
    }
    validateBatchItemIdentity(items);

    const runId =
      batch.runId == null || batch.runId === "" ? null : String(batch.runId);
    const destDir = resolveDestDir(root, threadId, runId);

    const prepared = [];
    for (const item of items) {
      const shaped = validateCommitItemShape(item);
      const probe = await probeFile(shaped.entry.path, {
        kind: shaped.item.kind,
        mimeType: shaped.item.mimeType,
      }, mergedLimits);
      prepared.push({ ...shaped, probe });
    }

    const batchBytes = prepared.reduce((sum, row) => sum + row.probe.size, 0);
    let threadBytes = sumThreadBytes(store, threadId) + batchBytes;
    let globalBytes = sumGlobalBytes(store) + batchBytes;

    if (
      threadBytes > mergedLimits.maxThreadBytes ||
      globalBytes > mergedLimits.maxGlobalBytes
    ) {
      await cleanupUnlocked();
      threadBytes = sumThreadBytes(store, threadId) + batchBytes;
      globalBytes = sumGlobalBytes(store) + batchBytes;
    }

    if (threadBytes > mergedLimits.maxThreadBytes) {
      throw artifactError("artifact_limit", "Thread artifact cap exceeded");
    }
    if (globalBytes > mergedLimits.maxGlobalBytes) {
      throw artifactError("artifact_limit", "Global artifact cap exceeded");
    }

    await fs.promises.mkdir(destDir, { recursive: true });

    const keyToId = new Map();
    const moves = [];
    const createdAt = new Date(now()).toISOString();

    try {
      for (const { item, entry } of prepared) {
        const id = randomUUID();
        keyToId.set(item.key, id);
        const ext = EXT_BY_KIND[item.kind];
        const destPath = path.join(destDir, `${id}.${ext}`);
        await syncFile(entry.path);
        await renameFile(entry.path, destPath);
        staged.delete(entry.token);
        inFlightDestPaths.add(destPath);
        moves.push({
          destPath,
          stagingPath: entry.path,
          token: entry.token,
          kind: item.kind,
          mimeType: item.mimeType,
          createdAt: entry.createdAt,
        });
      }
    } catch (err) {
      await rollbackMoves(moves);
      throw err;
    }

    const infos = prepared.map(({ item, probe }) => {
      const id = keyToId.get(item.key);
      /** @type {Record<string, unknown>} */
      const info = {
        id,
        threadId,
        runId,
        source: batch.source,
        kind: item.kind,
        mimeType: item.mimeType,
        name: String(item.name),
        size: probe.size,
        createdAt,
      };
      if (batch.toolCallId) info.toolCallId = String(batch.toolCallId);
      if (item.kind === "image" && probe.width && probe.height) {
        info.width = probe.width;
        info.height = probe.height;
      }
      if (item.kind === "video" && probe.durationMs) {
        info.durationMs = probe.durationMs;
      }
      if (item.posterKey) {
        const posterId = keyToId.get(item.posterKey);
        if (posterId) info.posterArtifactId = posterId;
      }
      return info;
    });

    const metadataSnapshot = store.getRunArtifacts(threadId).slice();
    const updated = [...metadataSnapshot, ...infos];
    if (beforePersist) {
      await beforePersist({
        cleanupUnlocked,
        destPaths: moves.map((move) => move.destPath),
      });
    }
    try {
      store.setRunArtifacts(threadId, updated);
      store.saveNow();
    } catch (err) {
      store.setRunArtifacts(threadId, metadataSnapshot);
      await rollbackMoves(moves);
      throw err;
    }

    for (const move of moves) {
      inFlightDestPaths.delete(move.destPath);
    }

    return infos;
  }

  async function commitBatch(batch) {
    return enqueueMutation(() => commitBatchUnlocked(batch));
  }

  /**
   * @param {{ id: string, threadId?: string }} opts
   */
  async function open(opts) {
    const id = String(opts && opts.id || "");
    if (!id) return null;
    const found = store.findRunArtifact(id);
    if (!found) return null;
    if (
      opts &&
      opts.threadId != null &&
      String(opts.threadId) !== String(found.threadId)
    ) {
      return null;
    }
    const artifact = found.artifact;
    if (!isValidArtifactMetadata(artifact)) return null;

    const rel = artifactFileRelPath(artifact);
    const filePath = path.join(root, rel);
    let stat;
    try {
      stat = await fs.promises.lstat(filePath);
    } catch {
      return null;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) return null;

    let realFile;
    let realRoot;
    try {
      realFile = await fs.promises.realpath(filePath);
      realRoot = await fs.promises.realpath(root);
    } catch {
      return null;
    }
    if (
      realFile !== realRoot &&
      !realFile.startsWith(realRoot + path.sep)
    ) {
      return null;
    }

    const info = { ...artifact };
    delete info.path;
    return { info, path: filePath, size: stat.size };
  }

  return {
    stage,
    commitBatch,
    discard,
    open,
    cleanup,
  };
}

/**
 * @param {string} filePath
 */
async function defaultOpenStagingFile(filePath) {
  return fs.promises.open(filePath, "w", 0o600);
}

/**
 * @param {string} filePath
 */
async function defaultSyncFile(filePath) {
  const stat = await fs.promises.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw artifactError("invalid_artifact", "Artifact must be a regular file");
  }
  const fh = await fs.promises.open(filePath, "r+");
  try {
    try {
      await fh.sync();
    } catch {
      // fsync is best-effort; still rename so the write is not lost.
    }
  } finally {
    await fh.close();
  }
}

module.exports = {
  createRunArtifactStore,
  isValidArtifactMetadata,
  defaultSyncFile,
  defaultOpenStagingFile,
};
