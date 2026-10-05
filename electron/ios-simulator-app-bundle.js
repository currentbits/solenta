"use strict";

// createIOSSimulatorService seam: resolving a thread's execution root and
// validating the .app bundle inside it (#1447 pass V2, seam 3). Convention:
// see the header of electron/runner-watchdogs.js; plan:
// docs/superpowers/specs/2026-10-05-ios-simulator-split.md.

const path = require("node:path");
const {
  BUNDLE_ID_RE,
  iosError,
  isWithin,
  invalidAppPath,
  invalidBundle,
  validateRelativeAppPath,
} = require("./ios-simulator-parse.js");

const BUNDLE_WALK_LIMIT = 20_000;

/**
 * @param {object} ctx - createIOSSimulatorService context
 */
function createAppBundle(ctx) {
  const {
    store,
    prepareThreadWorktree,
    resolvedWorktreeBase,
    broadcast,
    fsApi,
    processAdapter,
    resolveThread,
    selectedDeveloperDirectory,
  } = ctx;

  async function resolveExecutionRoot(inputThreadId) {
    let { thread, project, threadId } = resolveThread(inputThreadId);
    const isolated = Boolean(thread.pendingWorktree || thread.worktreePath);
    if (isolated) {
      await prepareThreadWorktree({
        store,
        threadId,
        worktreeBase: resolvedWorktreeBase,
        broadcast,
      });
      thread = store.getThread(threadId);
      if (!thread || !thread.worktreePath) {
        throw iosError("worktree_missing", "Thread worktree is unavailable");
      }
    }
    const root = isolated ? thread.worktreePath : project.path;
    let canonical;
    try {
      canonical = await fsApi.promises.realpath(root);
    } catch {
      if (isolated) {
        throw iosError("worktree_missing", "Thread worktree is unavailable");
      }
      throw iosError("unexpected", "Project path is unavailable");
    }
    return { thread, project, root: canonical, threadId };
  }

  async function validateBundleWithinRoot(root, bundlePath) {
    const infoPlistPath = path.join(bundlePath, "Info.plist");
    let infoStat;
    try {
      infoStat = await fsApi.promises.lstat(infoPlistPath);
    } catch {
      throw invalidBundle();
    }
    if (!infoStat.isFile() || infoStat.isSymbolicLink()) {
      throw invalidBundle();
    }

    const queue = [bundlePath];
    let entries = 0;
    while (queue.length > 0) {
      const current = queue.shift();
      let names;
      try {
        names = await fsApi.promises.readdir(current);
      } catch {
        throw invalidBundle();
      }
      for (const name of names) {
        entries += 1;
        if (entries > BUNDLE_WALK_LIMIT) throw invalidBundle();
        const entryPath = path.join(current, name);
        let stat;
        try {
          stat = await fsApi.promises.lstat(entryPath);
        } catch {
          throw invalidBundle();
        }
        if (stat.isSymbolicLink()) {
          let target;
          try {
            target = await fsApi.promises.realpath(entryPath);
          } catch {
            throw invalidBundle();
          }
          if (!isWithin(root, target)) throw invalidBundle();
          let targetStat;
          try {
            targetStat = await fsApi.promises.lstat(target);
          } catch {
            throw invalidBundle();
          }
          if (targetStat.isDirectory()) {
            throw invalidBundle();
          }
          continue;
        }
        if (stat.isDirectory()) {
          queue.push(entryPath);
        }
      }
    }
  }

  async function prepareAppBundle(input) {
    const threadId = input && input.threadId;
    const relativeAppPath = input && input.relativeAppPath;
    validateRelativeAppPath(relativeAppPath);
    const { root } = await resolveExecutionRoot(threadId);
    const candidate = path.resolve(root, relativeAppPath);
    if (!isWithin(root, candidate)) throw invalidAppPath();
    let canonical;
    try {
      canonical = await fsApi.promises.realpath(candidate);
    } catch {
      throw invalidAppPath();
    }
    if (!isWithin(root, canonical)) throw invalidAppPath();
    if (!canonical.endsWith(".app")) throw invalidAppPath();
    let bundleStat;
    try {
      bundleStat = await fsApi.promises.lstat(canonical);
    } catch {
      throw invalidAppPath();
    }
    if (!bundleStat.isDirectory() || bundleStat.isSymbolicLink()) {
      throw invalidAppPath();
    }
    await validateBundleWithinRoot(root, canonical);
    const developerDir = await selectedDeveloperDirectory();
    let bundleIdText;
    try {
      bundleIdText = String(
        await processAdapter.readBundleId(
          developerDir,
          path.join(canonical, "Info.plist"),
        ),
      ).trim();
    } catch {
      throw invalidBundle();
    }
    if (!BUNDLE_ID_RE.test(bundleIdText)) throw invalidBundle();
    return Object.freeze({ bundleId: bundleIdText, appPath: canonical });
  }

  return { prepareAppBundle };
}

module.exports = { createAppBundle };
