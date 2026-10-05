"use strict";

// Turn checkpoints (create/list/restore), turn diffs and run stats.

const fs = require("node:fs");
const { PATCH_TRUNCATE, invalidateGitReads, tailErr, gitTryAsync } = require("./worktrees-git.js");
const { diff, commit } = require("./worktrees-changes.js");

// ---------------------------------------------------------------------------
// Round 50: worktree turn checkpoints (async git only — never execFileSync)
// ---------------------------------------------------------------------------

const CHECKPOINT_SUBJECT_PREFIX = "coder-checkpoint: turn ";

/**
 * Parse `git diff --shortstat` output.
 * " 3 files changed, 24 insertions(+), 9 deletions(-)"
 * Missing insertion/deletion clauses become 0. Returns null when unparseable.
 *
 * @param {string} text
 * @returns {{ files: number, additions: number, deletions: number } | null}
 */
function parseShortstat(text) {
  const s = String(text || "");
  const files = s.match(/(\d+)\s+files?\s+changed/);
  if (!files) return null;
  const add = s.match(/(\d+)\s+insertions?\(\+\)/);
  const del = s.match(/(\d+)\s+deletions?\(-\)/);
  return {
    files: Number(files[1]),
    additions: add ? Number(add[1]) : 0,
    deletions: del ? Number(del[1]) : 0,
  };
}

async function runStats(opts) {
  try {
    const { store, threadId } = opts;
    if (!threadId) return [];
    const thread = store.getThread(threadId);
    if (!thread || !thread.worktreePath) return [];
    const cwd = thread.worktreePath;
    if (!fs.existsSync(cwd)) return [];

    const list = await listCheckpoints({ store, threadId });
    if (!list.length) return [];

    const oldestFirst = [...list].sort((a, b) => {
      if (a.turn !== b.turn) return a.turn - b.turn;
      return a.at - b.at;
    });

    /** @type {Array<{ sha: string, turn: number, files: number, additions: number, deletions: number }>} */
    const out = [];
    for (let i = 0; i < oldestFirst.length; i++) {
      const cp = oldestFirst[i];
      const from = i === 0 ? `${cp.sha}^` : oldestFirst[i - 1].sha;
      const diff = await gitTryAsync(
        cwd,
        ["diff", "--shortstat", from, cp.sha],
        { raw: true },
      );
      if (!diff.ok) continue;
      const parsed = parseShortstat(diff.stdout);
      if (!parsed) continue;
      out.push({
        sha: cp.sha,
        turn: cp.turn,
        files: parsed.files,
        additions: parsed.additions,
        deletions: parsed.deletions,
      });
    }
    return out;
  } catch {
    return [];
  }
}

const EMPTY_TURN_DIFF = { files: [], patch: "", truncated: false };

/**
 * Unquote a git path (`"foo bar"` → `foo bar`). Porcelain and name-status
 * quote paths that contain spaces.
 * @param {string} filePath
 */
function unquoteGitPath(filePath) {
  return String(filePath || "").replace(/^"|"$/g, "");
}

/**
 * Checkpoint-to-checkpoint patch for one turn (#148).
 * Same pairing as runStats: N vs N-1, first vs `<sha>^`.
 * Never throws: missing worktree / unknown sha / git failures return empty.
 * `sha` must be one of this thread's checkpoints — never an arbitrary rev.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @param {string} opts.sha
 * @returns {Promise<{ files: Array<{path: string, status: string, additions: number, deletions: number}>, patch: string, truncated: boolean }>}
 */
async function turnDiff(opts) {
  try {
    const { store, threadId, sha } = opts;
    if (!threadId || !sha) return { ...EMPTY_TURN_DIFF };
    const thread = store.getThread(threadId);
    if (!thread || !thread.worktreePath) return { ...EMPTY_TURN_DIFF };
    const cwd = thread.worktreePath;
    if (!fs.existsSync(cwd)) return { ...EMPTY_TURN_DIFF };

    const list = await listCheckpoints({ store, threadId });
    if (!list.length) return { ...EMPTY_TURN_DIFF };

    const oldestFirst = [...list].sort((a, b) => {
      if (a.turn !== b.turn) return a.turn - b.turn;
      return a.at - b.at;
    });
    const idx = oldestFirst.findIndex((c) => c.sha === sha);
    if (idx < 0) return { ...EMPTY_TURN_DIFF };

    const cp = oldestFirst[idx];
    const from = idx === 0 ? `${cp.sha}^` : oldestFirst[idx - 1].sha;
    const to = cp.sha;

    const nameStatus = await gitTryAsync(
      cwd,
      ["diff", "--name-status", from, to, "--"],
      { raw: true },
    );
    const numstat = await gitTryAsync(
      cwd,
      ["diff", "--numstat", from, to, "--"],
      { raw: true },
    );
    const patchResult = await gitTryAsync(
      cwd,
      ["diff", from, to, "--"],
      { raw: true },
    );

    if (!nameStatus.ok && !numstat.ok && !patchResult.ok) {
      return { ...EMPTY_TURN_DIFF };
    }

    /** @type {Map<string, { path: string, status: string, additions: number, deletions: number }>} */
    const byPath = new Map();
    if (nameStatus.ok) {
      for (const line of String(nameStatus.stdout || "").split("\n")) {
        if (!line.trim()) continue;
        const parts = line.split("\t");
        if (parts.length < 2) continue;
        const letter = (parts[0].trim().charAt(0) || "M").toUpperCase();
        const filePath = unquoteGitPath(parts[parts.length - 1]);
        if (!filePath) continue;
        byPath.set(filePath, {
          path: filePath,
          status: letter,
          additions: 0,
          deletions: 0,
        });
      }
    }
    if (numstat.ok) {
      for (const line of String(numstat.stdout || "").split("\n")) {
        if (!line.trim()) continue;
        const parts = line.split("\t");
        if (parts.length < 3) continue;
        const addStr = parts[0];
        const delStr = parts[1];
        let filePath = parts.slice(2).join("\t");
        if (filePath.includes(" => ")) {
          filePath = filePath.split(" => ").pop() || filePath;
        }
        filePath = unquoteGitPath(filePath);
        if (!filePath) continue;
        const additions = addStr === "-" ? 0 : parseInt(addStr, 10) || 0;
        const deletions = delStr === "-" ? 0 : parseInt(delStr, 10) || 0;
        const existing = byPath.get(filePath);
        if (existing) {
          existing.additions = additions;
          existing.deletions = deletions;
        } else {
          byPath.set(filePath, {
            path: filePath,
            status: "M",
            additions,
            deletions,
          });
        }
      }
    }

    let patch = patchResult.ok ? String(patchResult.stdout || "") : "";
    let truncated = false;
    if (patch.length > PATCH_TRUNCATE) {
      patch = patch.slice(0, PATCH_TRUNCATE);
      truncated = true;
    }

    return {
      files: [...byPath.values()],
      patch,
      truncated,
    };
  } catch {
    return { ...EMPTY_TURN_DIFF };
  }
}

/**
 * @param {string} subject
 * @returns {number | null}
 */
function parseCheckpointTurn(subject) {
  const m = String(subject || "").match(
    /^coder-checkpoint:\s*turn\s+(\d+)\s*$/i,
  );
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Count existing checkpoint commits in a worktree (any order).
 * @param {string} cwd
 * @returns {Promise<number>}
 */
async function countCheckpointCommits(cwd) {
  const log = await gitTryAsync(cwd, [
    "log",
    "--grep=coder-checkpoint:",
    "--format=%s",
  ]);
  if (!log.ok || !String(log.stdout || "").trim()) return 0;
  return String(log.stdout)
    .split(/\r?\n/)
    .filter((line) => parseCheckpointTurn(line) != null).length;
}

/**
 * After a successful turn: if the thread has a dirty WORKTREE, auto-commit
 * `coder-checkpoint: turn N`. Best-effort — never throws, never fails the turn.
 * Never touches the main project repo.
 *
 * @param {import('./store').Store} store
 * @param {string} threadId
 * @returns {Promise<{ sha: string, turn: number, message: string } | null>}
 */
async function maybeCreateCheckpoint(store, threadId) {
  try {
    const thread = store.getThread(threadId);
    if (!thread || !thread.worktreePath) return null;
    const cwd = thread.worktreePath;
    if (!fs.existsSync(cwd)) return null;

    const status = await gitTryAsync(cwd, ["status", "--porcelain", "-uall"], {
      raw: true,
    });
    if (!status.ok) return null;
    if (!String(status.stdout || "").trim()) return null; // clean → no commit

    const n = (await countCheckpointCommits(cwd)) + 1;
    const message = `${CHECKPOINT_SUBJECT_PREFIX}${n}`;
    let lastId = "";
    try {
      const msgs = store.getMessages(threadId);
      const last = msgs.length ? msgs[msgs.length - 1] : null;
      lastId = last && last.id ? String(last.id) : "";
    } catch {
      // Trailer is optional; a store glitch must not skip the git commit.
    }

    const add = await gitTryAsync(cwd, ["add", "-A"]);
    if (!add.ok) return null;

    const commitArgs = [
      "-c",
      "user.email=solenta@local",
      "-c",
      "user.name=Solenta",
      "commit",
      "-m",
      message,
    ];
    if (lastId) {
      // Body trailer, not the subject: listCheckpoints / parseCheckpointTurn
      // read %s only. Restore uses this to keep the turn that produced the
      // commit (git %ct is 1s; the assistant often shares that second).
      commitArgs.push("-m", `Solenta-Message-Id: ${lastId}`);
    }
    const commit = await gitTryAsync(cwd, commitArgs);
    if (!commit.ok) return null;

    const rev = await gitTryAsync(cwd, ["rev-parse", "HEAD"]);
    invalidateGitReads(cwd);
    if (!rev.ok || !rev.stdout) return { sha: "", turn: n, message };
    return { sha: String(rev.stdout).trim(), turn: n, message };
  } catch {
    return null;
  }
}

/**
 * List checkpoints in the thread worktree, newest-first.
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @returns {Promise<Array<{ sha: string, turn: number, message: string, at: number }>>}
 */
async function listCheckpoints(opts) {
  const { store, threadId } = opts;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (!thread.worktreePath) {
    return [];
  }
  const cwd = thread.worktreePath;
  if (!fs.existsSync(cwd)) return [];

  // %H sha, %ct committer unix, %s subject — newest first (git log default).
  // --first-parent: a merge of a worker branch makes that worker's
  // coder-checkpoint commits reachable. Walking them would let restore
  // (and rewind) hard-reset onto the fork's tree and drop this thread's
  // work. First parent is this thread's own line.
  const log = await gitTryAsync(cwd, [
    "log",
    "--first-parent",
    "--grep=coder-checkpoint:",
    "--format=%H\t%ct\t%s",
  ]);
  if (!log.ok || !String(log.stdout || "").trim()) return [];

  /** @type {Array<{ sha: string, turn: number, message: string, at: number }>} */
  const out = [];
  for (const line of String(log.stdout).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const sha = parts[0];
    const ct = Number(parts[1]);
    const message = parts.slice(2).join("\t");
    const turn = parseCheckpointTurn(message);
    if (turn == null) continue;
    out.push({
      sha,
      turn,
      message,
      at: Number.isFinite(ct) ? ct * 1000 : 0,
    });
  }
  return out;
}

const MESSAGE_ID_TRAILER = /^Solenta-Message-Id:\s+(\S+)/m;

/**
 * @param {string} cwd
 * @param {string} sha
 * @returns {Promise<string | null>}
 */
async function readCheckpointMessageId(cwd, sha) {
  const body = await gitTryAsync(cwd, ["log", "-1", "--format=%b", sha]);
  if (!body.ok) return null;
  const m = String(body.stdout || "").match(MESSAGE_ID_TRAILER);
  return m ? m[1] : null;
}

/**
 * Drop messages after the checkpoint turn. Prefer the body trailer written
 * at commit time; old checkpoints fall back to createdAt vs git %ct, with
 * +999ms slack so the assistant that shares the committer second is kept.
 *
 * @param {import('./store').Store} store
 * @param {string} threadId
 * @param {string | null} keepMessageId
 * @param {number} checkpointAt
 * @returns {number} messages dropped
 */
function rewindTranscriptToCheckpoint(store, threadId, keepMessageId, checkpointAt) {
  const msgs = store.getMessages(threadId);
  if (keepMessageId) {
    const idx = msgs.findIndex((m) => m && m.id === keepMessageId);
    if (idx >= 0) {
      const next = msgs[idx + 1];
      if (!next) return 0;
      return store.truncateFromMessage(threadId, next.id);
    }
  }
  const slackEnd = Number(checkpointAt) + 999;
  const dropIdx = msgs.findIndex((m) => {
    const t = Number(m && m.createdAt);
    return Number.isFinite(t) && t > slackEnd;
  });
  if (dropIdx < 0) return 0;
  return store.truncateFromMessage(threadId, msgs[dropIdx].id);
}

/**
 * Hard-reset the thread WORKTREE to a prior checkpoint sha and rewind the
 * transcript to that turn (issue #149). CLI sessions cannot be rewound, so
 * sessionId is cleared and replayContext is set — same as threads.rewind.
 * Guards (in order): unknown thread → run active → no worktree → sha not ours.
 * A dirty worktree is checkpointed first so the reset never eats uncommitted work.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @param {string} opts.sha
 * @param {(threadId: string) => boolean} [opts.isRunning]
 * @param {boolean} [opts.rewindConversation] default true; false when
 *   threads.rewind already truncated (restoreFiles).
 * @param {() => unknown} [opts.cleanupRunArtifacts]
 * @returns {Promise<void>}
 */
async function restoreCheckpoint(opts) {
  const { store, threadId, sha, isRunning } = opts;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (typeof isRunning === "function" && isRunning(threadId)) {
    throw new Error("Cannot restore a checkpoint while a run is active");
  }
  if (!thread.worktreePath) {
    throw new Error(
      `Thread ${threadId} has no worktree; call setupWorktree first`,
    );
  }

  const want = String(sha || "").trim();
  if (!want) {
    throw new Error(`Unknown checkpoint: ${sha}`);
  }

  // THIS THREAD's HEAD-reachable checkpoints only. Sibling worktrees of the
  // same project share an object DB, so `git log -1 <sha>` would accept
  // another thread's checkpoint and hard-reset into foreign state (data
  // loss). Membership in listCheckpoints is the contract boundary.
  const list = await listCheckpoints({ store, threadId });
  const match = list.find(
    (c) => c.sha === want || c.sha.startsWith(want) || want.startsWith(c.sha),
  );
  if (!match) {
    throw new Error(`Unknown checkpoint: ${sha}`);
  }

  // Uncommitted work here (manual edits, or a run whose post-turn checkpoint
  // failed) would be destroyed by the reset. Commit it first — best-effort,
  // same as the post-turn path. ponytail: the safety commit is off-HEAD after
  // the reset so it drops out of listCheckpoints; recovery is `git reflog` in
  // the worktree. Surface it in the UI if anyone actually needs it back.
  await maybeCreateCheckpoint(store, threadId);

  const reset = await gitTryAsync(thread.worktreePath, [
    "reset",
    "--hard",
    match.sha,
  ]);
  if (!reset.ok) {
    throw new Error(
      tailErr(reset.stderr || reset.combined, "git reset --hard failed"),
    );
  }

  // Files first: a failed reset must not leave a truncated transcript.
  // rewindThread(restoreFiles) already cut the transcript, so skip.
  if (opts.rewindConversation === false) return;

  const keepId = await readCheckpointMessageId(thread.worktreePath, match.sha);
  rewindTranscriptToCheckpoint(store, threadId, keepId, match.at);
  store.updateThread(threadId, {
    sessionId: null,
    replayContext: true,
  });
  // Reset is already on disk. Debounced save() would leave a crash window
  // with files rewound and the old transcript resurrected.
  store.saveNow();
  if (typeof opts.cleanupRunArtifacts === "function") {
    Promise.resolve()
      .then(() => opts.cleanupRunArtifacts())
      .catch(() => {});
  }
}

module.exports = {
  CHECKPOINT_SUBJECT_PREFIX,
  parseShortstat,
  runStats,
  turnDiff,
  maybeCreateCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
};
