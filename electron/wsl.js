"use strict";

/**
 * The WSL boundary (#397).
 *
 * On Windows a repo lives on one of two filesystems and the two are not
 * interchangeable: the Windows drives (C:\...) and a WSL distro's ext4 root,
 * reachable from Windows as the UNC path \\wsl$\<distro>\... (\\wsl.localhost
 * on newer builds). Crossing the boundary for every file op is the single
 * biggest source of slow git, broken file watching, and permission noise on
 * Windows — a WSL-side repo driven by Windows git is ~10x slower and drops
 * inotify events entirely.
 *
 * The rule: git, watchers and agents run on the SAME side as the worktree.
 * So a project whose path is a \\wsl$ UNC gets every command wrapped in
 * `wsl.exe -d <distro> --cd <linux path> -- <argv>`, which is exactly the
 * same seam ssh.js already uses for remote projects. `--` passes argv
 * straight to exec with no shell in between, so nothing needs quoting.
 *
 * This module is pure: detection only, no spawning, no requires. ssh.js owns
 * the wrapping so the two boundary kinds (ssh remote, WSL) share one seam.
 */

/** \\wsl$\Ubuntu\home\me\repo  or  \\wsl.localhost\Ubuntu-22.04\home\me\repo */
const WSL_UNC = /^\\\\wsl(?:\$|\.localhost)\\([^\\]+)\\?(.*)$/i;

/**
 * @typedef {object} PathSide
 * @property {"unix" | "windows" | "wsl"} side  which filesystem holds the path
 * @property {string | null} distro  WSL distro name, only when side is "wsl"
 * @property {string | null} linuxPath  the path as the distro sees it, only when side is "wsl"
 */

/**
 * Which side of the WSL boundary a project path lives on.
 *
 * Everything off win32 is "unix" — macOS and Linux have no boundary, and
 * callers must stay byte-for-byte unchanged there.
 *
 * @param {string | null | undefined} p
 * @param {NodeJS.Platform} [platform]
 * @returns {PathSide}
 */
function pathSide(p, platform = process.platform) {
  if (platform !== "win32") return { side: "unix", distro: null, linuxPath: null };
  const m = typeof p === "string" ? p.match(WSL_UNC) : null;
  if (!m) return { side: "windows", distro: null, linuxPath: null };
  const rest = (m[2] || "").replace(/\\/g, "/").replace(/\/+$/, "");
  return { side: "wsl", distro: m[1], linuxPath: `/${rest}` };
}

/**
 * A path inside the distro that actually points back at a Windows drive
 * (/mnt/c/...). Worktrees must never land here: it is the WSL boundary
 * crossed in the other direction, with the same slowness and no inotify.
 * @param {string | null | undefined} linuxPath
 */
function isWindowsMount(linuxPath) {
  return /^\/mnt\/[a-z](\/|$)/i.test(String(linuxPath || ""));
}

/**
 * The WSL wrap for a project, or null when the project is not WSL-side.
 * Branch ONLY on this — never on process.platform at the call site.
 *
 * @param {{ path?: string, remoteHost?: string } | null | undefined} project
 * @param {NodeJS.Platform} [platform]
 * @returns {{ distro: string, linuxPath: string } | null}
 */
function wslTarget(project, platform = process.platform) {
  if (!project || project.remoteHost) return null;
  const info = pathSide(project.path, platform);
  return info.side === "wsl"
    ? { distro: /** @type {string} */ (info.distro), linuxPath: /** @type {string} */ (info.linuxPath) }
    : null;
}

/**
 * Build the `wsl.exe` argv that runs argv inside the distro at linuxPath.
 * No shell, so no quoting: --cd takes the directory and -- ends wsl's own
 * flags. A local absolute binary path is a Windows path that does not exist
 * inside the distro, so only the basename is used (same rule as ssh.js).
 *
 * @param {string} distro
 * @param {string} linuxPath
 * @param {string[]} argv
 * @returns {{ bin: "wsl.exe", args: string[] }}
 */
function buildWslCommand(distro, linuxPath, argv) {
  return {
    bin: "wsl.exe",
    args: ["-d", String(distro), "--cd", String(linuxPath), "--", ...(Array.isArray(argv) ? argv : [])],
  };
}

module.exports = { pathSide, isWindowsMount, wslTarget, buildWslCommand };
