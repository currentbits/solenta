"use strict";

const { shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { listFiles, searchFiles } = require("./worktrees.js");
const { readToolImage, toolImageExists } = require("./tool-images.js");
const attachments = require("./attachments.js");
const appsnap = require("./appsnap.js");
const mediaProtocol = require("./media-protocol.js");
const { expandUserPath } = require("./fsBrowse.js");
const { resolveThreadRoot } = require("./ipc-shared.js");

/**
 * Drop a trailing `:line` / `:line:col` without eating a Windows drive.
 * @param {string} raw
 */
function stripLineSuffix(raw) {
  const m = String(raw).match(/^(.*?):(\d+)(?::(\d+))?$/);
  if (!m) return raw;
  if (/^[A-Za-z]$/.test(m[1])) return raw;
  return m[1];
}

/**
 * Validate a path exists and is the thread root or inside it.
 * Relative paths join against the thread worktree (or project checkout).
 * @param {import('./store').Store} store
 * @param {{ threadId?: string, path?: string }} input
 * @returns {string}
 */
function resolveAllowedShellPath(store, input) {
  if (!input || typeof input !== "object") {
    throw new Error("threadId is required");
  }
  const { root } = resolveThreadRoot(store, input.threadId);
  return resolveUnderRoot(root, input.path != null ? String(input.path) : root);
}

/**
 * Path checks for resolveAllowedShellPath against an already-resolved root.
 * @param {string} root
 * @param {string} raw
 * @returns {string}
 */
function resolveUnderRoot(root, raw) {
  if (!raw) throw new Error("Path is required");
  const expanded = expandUserPath(stripLineSuffix(raw));
  const resolved = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(root, expanded);
  if (!fs.existsSync(resolved)) {
    throw new Error("Path does not exist");
  }
  if (resolved === root) return resolved;
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Path is outside the thread workspace");
  }
  return resolved;
}

/**
 * Batch form of resolveAllowedShellPath: missing / outside paths are null.
 * The thread root is looked up once per call, not once per path (#1475).
 * @param {import('./store').Store} store
 * @param {string} threadId
 * @param {string[]} rawPaths
 * @returns {Array<string | null>}
 */
function tryResolveWorkspaceFiles(store, threadId, rawPaths) {
  let root;
  try {
    root = resolveThreadRoot(store, threadId).root;
  } catch {
    return rawPaths.map(() => null);
  }
  return rawPaths.map((raw) => {
    try {
      return resolveUnderRoot(root, raw);
    } catch {
      return null;
    }
  });
}

/** Max paths per files:resolve call; the renderer chunks at the same size. */
const RESOLVE_PATHS_MAX = 500;

/** IPC_HANDLERS rows for files:*, attachments:*, shell:*; ipc.js spreads them in. */
module.exports = {
  "files:list": async (ctx, input) => {
    return listFiles({
      store: ctx.store,
      threadId: input.threadId,
      query: input.query,
      limit: input.limit,
    });
  },
  "files:search": async (ctx, input) => {
    return searchFiles({
      store: ctx.store,
      threadId: input.threadId,
      query: input.query,
    });
  },
  "files:resolve": async (ctx, input) => {
    const threadId = input && input.threadId;
    if (!threadId) throw new Error("threadId is required");
    const raws = Array.isArray(input.paths)
      ? input.paths.slice(0, RESOLVE_PATHS_MAX).map((raw) => String(raw ?? ""))
      : [];
    const abs = tryResolveWorkspaceFiles(ctx.store, threadId, raws);
    return { resolved: raws.map((p, i) => ({ path: p, abs: abs[i] })) };
  },
  "files:image": async (ctx, input) => {
    const name = input && input.name;
    if (!(await toolImageExists(ctx.userDataPath, name))) {
      return { dataUrl: null };
    }
    if (ctx.serveDataUrls) {
      return { dataUrl: await readToolImage(ctx.userDataPath, name) };
    }
    return { dataUrl: mediaProtocol.toolImageUrl(name) };
  },
  "attachments:pick": async (ctx, input) => {
    if (!ctx.dialog || typeof ctx.dialog.showOpenDialog !== "function") {
      throw new Error("Attachment picker is not available in this mode");
    }
    return {
      attachments: await attachments.pickAttachments(ctx.dialog, {
        includeImages: !input || input.includeImages !== false,
      }),
    };
  },
  "attachments:fromPaths": async (ctx, input) => {
    return {
      attachments: attachments.classifyPaths(input && input.paths),
    };
  },
  "attachments:saveImage": async (ctx, input) => {
    return {
      attachment: attachments.saveImage(
        ctx.userDataPath,
        input && input.threadId,
        input && input.dataUrl,
      ),
    };
  },
  "attachments:saveFile": async (ctx, input) => {
    return {
      attachment: attachments.saveFile(
        ctx.userDataPath,
        input && input.threadId,
        input && input.name,
        input && input.dataUrl,
      ),
    };
  },
  "attachments:saveFolder": async (ctx, input) => {
    return {
      attachment: attachments.saveFolder(
        ctx.userDataPath,
        input && input.threadId,
        input && input.name,
        input && input.files,
      ),
    };
  },
  "attachments:readImage": async (ctx, input) => {
    const filePath = input && input.path;
    const resolved = await attachments.resolveImageFile(filePath);
    if (!resolved) return { dataUrl: null };
    if (ctx.serveDataUrls) {
      return { dataUrl: await attachments.readImage(filePath) };
    }
    return { dataUrl: mediaProtocol.localImageUrl(resolved.path) };
  },
  "attachments:listWindows": async () => {
    try {
      return await appsnap.listWindows();
    } catch {
      return { windows: [] };
    }
  },
  "attachments:captureWindow": async (ctx, input) => {
    const threadId = input && input.threadId;
    const sourceId = input && input.sourceId;
    const png = await appsnap.captureWindowPng(sourceId);
    return {
      attachment: attachments.savePng(ctx.userDataPath, threadId, png),
    };
  },
  "shell:reveal": async (ctx, input) => {
    const target = resolveAllowedShellPath(ctx.store, input);
    shell.showItemInFolder(target);
  },
  "shell:openPath": async (ctx, input) => {
    const target = resolveAllowedShellPath(ctx.store, input);
    const err = await shell.openPath(target);
    if (err) throw new Error(err);
  },
  "shell:editors": async () => {
    return require("./openIn.js").listEditors();
  },
  "shell:openIn": async (ctx, input) => {
    const target = resolveAllowedShellPath(ctx.store, input);
    await require("./openIn.js").openIn(target, input && input.editor, {
      line: input && input.line,
      col: input && input.column,
      openPath: (p) => shell.openPath(p),
    });
  },
};
