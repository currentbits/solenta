"use strict";

const { shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const {
  listFiles,
  searchFiles,
  lsFiles,
  gitTryAsync,
} = require("./worktrees.js");
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

/** Files pane (#1506): preview cap, entries per directory, whole-tree cap. */
const PREVIEW_MAX_BYTES = 1024 * 1024;
const TREE_DIR_MAX = 2000;
const TREE_ALL_MAX = 20000;
const IMAGE_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
};

/**
 * Root for the files pane. Remote projects list over ssh, which this pane
 * does not do, so they are refused rather than read from the local stub path.
 * @param {import('./store').Store} store
 * @param {string} threadId
 */
function filesPaneRoot(store, threadId) {
  if (!threadId) throw new Error("threadId is required");
  const { project, root } = resolveThreadRoot(store, threadId);
  if (project.remoteHost) {
    throw new Error("Files are not available for remote projects");
  }
  return root;
}

/**
 * resolveUnderRoot, then the same check on real paths so a symlink inside
 * the checkout cannot point the pane at a file outside it.
 * @param {string} root
 * @param {string} raw
 */
async function resolveRealUnderRoot(root, raw) {
  const resolved = resolveUnderRoot(root, raw);
  const [realRoot, real] = await Promise.all([
    fs.promises.realpath(root),
    fs.promises.realpath(resolved),
  ]);
  const rel = path.relative(realRoot, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Path is outside the thread workspace");
  }
  return { abs: resolved, rel: path.relative(root, resolved) };
}

const toPosix = (p) => p.split(path.sep).join("/");

/**
 * Repo-relative paths git ignores, from `git check-ignore`. Exit 1 (none
 * ignored) and 128 (not a repo) both mean "nothing to hide".
 * ponytail: names git has to quote (quotes, control chars) never match the
 * output and show as not ignored; switch to --stdin -z if that matters.
 * @param {string} root
 * @param {string[]} rels
 */
async function ignoredSet(root, rels) {
  if (!rels.length) return new Set();
  const out = await gitTryAsync(
    root,
    ["-c", "core.quotePath=false", "check-ignore", "--", ...rels],
    { raw: true },
  );
  return new Set(String(out.stdout || "").split("\n").filter(Boolean));
}

/**
 * One directory of the files pane, dirs first. Ignored entries are dropped
 * unless showIgnored, then flagged. `.git` is never listed.
 * @param {string} root
 * @param {{ dir?: string, showIgnored?: boolean }} input
 */
async function listTreeDir(root, input) {
  const { abs, rel } = input.dir
    ? await resolveRealUnderRoot(root, String(input.dir))
    : { abs: root, rel: "" };
  const dirents = (await fs.promises.readdir(abs, { withFileTypes: true }))
    .filter((d) => d.name !== ".git");
  const truncated = dirents.length > TREE_DIR_MAX;
  const rows = await Promise.all(
    dirents.slice(0, TREE_DIR_MAX).map(async (d) => {
      let dir = d.isDirectory();
      if (d.isSymbolicLink()) {
        // Follow for the icon only; opening it goes through the realpath guard.
        dir = await fs.promises
          .stat(path.join(abs, d.name))
          .then((s) => s.isDirectory())
          .catch(() => false);
      }
      return { name: d.name, path: toPosix(path.join(rel, d.name)), dir };
    }),
  );
  const ignored = await ignoredSet(root, rows.map((r) => r.path));
  const entries = rows
    .filter((r) => input.showIgnored || !ignored.has(r.path))
    .map((r) => (ignored.has(r.path) ? { ...r, ignored: true } : r))
    .sort((a, b) =>
      a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name),
    );
  return { entries, truncated };
}

/**
 * Every file for the pane's filter: git's own list (gitignore respected),
 * or a bounded walk when the root is not a repo (Scratch).
 * @param {string} root
 */
async function listTreeAll(root) {
  let files;
  try {
    files = await lsFiles(root);
  } catch {
    const all = await fs.promises.readdir(root, {
      recursive: true,
      withFileTypes: true,
    });
    files = all
      .filter((d) => d.isFile())
      .map((d) => toPosix(path.relative(root, path.join(d.parentPath, d.name))))
      .filter((p) => !p.startsWith(".git/"));
  }
  const truncated = files.length > TREE_ALL_MAX;
  return {
    entries: files.slice(0, TREE_ALL_MAX).map((p) => ({
      name: p.slice(p.lastIndexOf("/") + 1),
      path: p,
      dir: false,
    })),
    truncated,
  };
}

/**
 * Read-only preview of one file: text, an image data URL, or why not.
 * @param {string} root
 * @param {string} raw
 */
async function readPreview(root, raw) {
  const { abs } = await resolveRealUnderRoot(root, raw);
  const stat = await fs.promises.stat(abs);
  if (!stat.isFile()) throw new Error("Not a file");
  const size = stat.size;
  if (size > PREVIEW_MAX_BYTES) return { kind: "tooLarge", size };
  const buf = await fs.promises.readFile(abs);
  const ext = path.extname(abs).slice(1).toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (mime) {
    return { kind: "image", size, dataUrl: `data:${mime};base64,${buf.toString("base64")}` };
  }
  // Same sniff git uses: a NUL in the first 8000 bytes means binary.
  if (buf.subarray(0, 8000).includes(0)) return { kind: "binary", size };
  return { kind: "text", size, text: buf.toString("utf8") };
}

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
  "files:tree": async (ctx, input) => {
    const root = filesPaneRoot(ctx.store, input && input.threadId);
    return input.all ? listTreeAll(root) : listTreeDir(root, input);
  },
  "files:read": async (ctx, input) => {
    const root = filesPaneRoot(ctx.store, input && input.threadId);
    return readPreview(root, String((input && input.path) || ""));
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
      openPath: (p) => shell.openPath(p),
    });
  },
};
