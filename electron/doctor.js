"use strict";

const { execCommandAsync } = require("./ssh.js");
const { pathSide, isWindowsMount } = require("./wsl.js");

/**
 * Windows doctor (#435).
 *
 * On win32, projects.add runs four probes and returns what will break
 * BEFORE the user hits it: core.longpaths, a POSIX shell (Git Bash),
 * Node 22 (Codex), and which side of the WSL boundary the repo is on.
 *
 * Advisory, never blocking — a failed check is a report, not a reject.
 * Off win32 this is a no-op (returns null) so addProject stays identical.
 *
 * Probes go through ssh.js execCommandAsync so a WSL-side or ssh-remote
 * repo is checked on THAT side, not with a bare local spawn. Tests inject
 * platform (second arg or setPlatform) and swap the spawn with
 * ssh.setExecFile — same hook as electron/test/ssh.test.js.
 */

/** @type {NodeJS.Platform} */
let platformImpl = process.platform;

/**
 * Test hook: pretend we are on another platform. Pass null/undefined
 * to restore process.platform.
 * @param {NodeJS.Platform | null | undefined} p
 */
function setPlatform(p) {
  platformImpl = typeof p === "string" && p ? p : process.platform;
}

function getPlatform() {
  return platformImpl;
}

/** Hard cap so a hung probe cannot stall add. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * @param {{ remoteHost?: string, remotePath?: string, path?: string } | null | undefined} project
 * @param {string} bin
 * @param {string[]} argv
 * @returns {Promise<{ ok: boolean, stdout: string }>}
 */
async function probe(project, bin, argv) {
  try {
    const out = await execCommandAsync(project, bin, argv, {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout: String(out || "").trim() };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/**
 * @param {string} raw
 * @returns {number | null}
 */
function parseNodeMajor(raw) {
  const m = String(raw || "")
    .trim()
    .match(/^v?(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * @typedef {object} DoctorCheck
 * @property {"longpaths" | "gitBash" | "node22" | "wslBoundary"} id
 * @property {boolean} ok
 * @property {string} message
 * @property {string} [fix]
 */

/**
 * @typedef {object} WindowsDoctorReport
 * @property {DoctorCheck[]} checks
 */

/**
 * @param {{ remoteHost?: string, remotePath?: string, path?: string } | null | undefined} project
 * @param {NodeJS.Platform} [platform]
 * @returns {Promise<WindowsDoctorReport | null>}
 */
async function runWindowsDoctor(project, platform = getPlatform()) {
  if (platform !== "win32") return null;

  /** @type {DoctorCheck[]} */
  const checks = [];
  try {
    const side = pathSide(project && project.path, platform);
    const remote = Boolean(project && project.remoteHost);
    // Linux git has no MAX_PATH. Only a Windows-side local repo needs this.
    const needsLongpaths = side.side === "windows" && !remote;

    // The three probes are independent, so run them together: sequentially
    // they stack three PROBE_TIMEOUT_MS waits into a 15s frozen add dialog on
    // exactly the machine this doctor exists for.
    const [longpaths, bash, node] = await Promise.all([
      needsLongpaths
        ? probe(project, "git", ["config", "--get", "core.longpaths"])
        : Promise.resolve(null),
      probe(project, "bash", ["-c", "echo ok"]),
      probe(project, "node", ["-v"]),
    ]);

    if (longpaths) {
      const enabled = /^true$/i.test(longpaths.stdout);
      checks.push({
        id: "longpaths",
        ok: enabled,
        message: enabled ? "Git long paths are enabled" : "Git long paths are off",
        fix: enabled ? undefined : "Run: git config --global core.longpaths true",
      });
    } else {
      checks.push({
        id: "longpaths",
        ok: true,
        message: "Git long paths are not needed on this side",
      });
    }

    const bashOk = bash.ok && bash.stdout === "ok";
    checks.push({
      id: "gitBash",
      ok: bashOk,
      message: bashOk
        ? "POSIX shell is available"
        : side.side === "wsl"
          ? "bash is missing in the WSL distro"
          : "No POSIX shell (Git Bash) on PATH",
      fix: bashOk
        ? undefined
        : side.side === "wsl"
          ? "Install bash in the WSL distro"
          : "Install Git for Windows and keep Git Bash on PATH",
    });

    const major = node.ok ? parseNodeMajor(node.stdout) : null;
    const nodeOk = major != null && major >= 22;
    checks.push({
      id: "node22",
      ok: nodeOk,
      message: nodeOk
        ? `Node ${major} is available`
        : node.ok
          ? `Node ${major} is too old (Codex needs 22)`
          : "Node is not on PATH (Codex needs 22)",
      fix: nodeOk ? undefined : "Install Node 22+ on this side of the WSL boundary",
    });

    const onMount = side.side === "wsl" && isWindowsMount(side.linuxPath);
    if (onMount) {
      checks.push({
        id: "wslBoundary",
        ok: false,
        message: "Repo is on /mnt/<drive> — the WSL boundary crossed the wrong way",
        fix: "Move the repo into the distro (e.g. ~/src) and add that path instead",
      });
    } else if (side.side === "wsl") {
      checks.push({
        id: "wslBoundary",
        ok: true,
        message: `Repo is inside WSL (${side.distro})`,
      });
    } else if (remote) {
      checks.push({
        id: "wslBoundary",
        ok: true,
        message: "Repo is an SSH remote, not on the WSL boundary",
      });
    } else {
      checks.push({
        id: "wslBoundary",
        ok: true,
        message: "Repo is on a Windows drive",
      });
    }
  } catch {
    // ponytail: never throw out of the doctor — add must still succeed.
  }
  return { checks };
}

module.exports = {
  runWindowsDoctor,
  setPlatform,
};
