"use strict";

/**
 * Per-thread sandbox (#436 / #397).
 *
 * Whether a run is actually confined depends on the AGENT crossed with the
 * REPO LOCATION, not a global setting. This module only reports what we
 * actually pass today (providers.js buildArgs). It does not invent flags.
 *
 * Provider truth, checked against buildArgs + live CLI help:
 *   claude  --permission-mode <mode>, no OS-sandbox flag
 *   grok    default/acceptEdits remapped to --always-approve /
 *           --permission-mode bypassPermissions (tools unprompted);
 *           plan/bypassPermissions pass through; no --sandbox
 *   kimi    -p cannot combine with -y/--auto/--plan; tools unprompted
 *   opencode --auto for bypassPermissions/acceptEdits; omitted otherwise
 *   cursor  --mode plan without --force; every other mode is --force
 *   codex   --sandbox read-only | workspace-write | danger-full-access
 *           from permissionMode (issue #170)
 *   simulate / generic / unknown: nothing
 *
 * Location is a separate confinement story the badge must tell apart:
 *   ssh remote → another host; WSL UNC on win32 → inside the distro;
 *   otherwise the process is a plain local child with the user's filesystem.
 *
 * Seatbelt (#803): on macOS a local thread whose agent profile has write or
 * network rules runs under sandbox-exec (runner-seatbelt.js). That, and only
 * that, makes a non-Codex run sandboxed here. The predicate is the same one
 * the runner uses, so the badge cannot claim a wrap the spawn did not do.
 *
 * Pure: no spawning, platform injected (defaults to process.platform).
 */

const { wslTarget } = require("./wsl.js");
const { seatbeltApplies } = require("./seatbelt.js");

/**
 * @typedef {object} SandboxInfo
 * @property {boolean} sandboxed
 * @property {string} reason
 */

/**
 * @param {{ remoteHost?: string, path?: string } | null | undefined} project
 * @param {NodeJS.Platform} [platform]
 */
function locationReason(project, platform) {
  if (project && project.remoteHost) return "runs on ssh remote";
  const wsl = wslTarget(project, platform);
  if (wsl) return `runs inside WSL ${wsl.distro}`;
  return "runs locally as your user";
}

/**
 * Agent-side answer only. Location is joined in resolveSandbox.
 * @param {string | null | undefined} provider
 * @param {string | null | undefined} permissionMode
 * @returns {SandboxInfo}
 */
function agentSandbox(provider, permissionMode) {
  const id = String(provider || "claude");
  const mode = String(permissionMode || "default");

  if (id === "codex") {
    const sandbox =
      mode === "plan"
        ? "read-only"
        : mode === "bypassPermissions"
          ? "danger-full-access"
          : "workspace-write";
    if (sandbox === "danger-full-access") {
      return {
        sandboxed: false,
        reason: "Codex --sandbox danger-full-access (not gated)",
      };
    }
    return {
      sandboxed: true,
      reason: `Codex --sandbox ${sandbox}`,
    };
  }

  if (id === "claude") {
    if (mode === "bypassPermissions") {
      return {
        sandboxed: false,
        reason: "Claude --permission-mode bypassPermissions (not gated)",
      };
    }
    return {
      sandboxed: false,
      reason: `Claude --permission-mode ${mode}; no OS sandbox`,
    };
  }

  if (id === "grok") {
    if (mode === "default" || mode === "acceptEdits") {
      return {
        sandboxed: false,
        reason:
          "Grok --always-approve / --permission-mode bypassPermissions (tools unprompted); no --sandbox",
      };
    }
    if (mode === "bypassPermissions") {
      return {
        sandboxed: false,
        reason: "Grok --permission-mode bypassPermissions (not gated); no --sandbox",
      };
    }
    return {
      sandboxed: false,
      reason: `Grok --permission-mode ${mode}; no --sandbox`,
    };
  }

  if (id === "kimi") {
    return {
      sandboxed: false,
      reason: "Kimi -p ignores permission mode; tools run unprompted",
    };
  }

  if (id === "opencode") {
    const auto = mode === "bypassPermissions" || mode === "acceptEdits";
    return {
      sandboxed: false,
      reason: auto
        ? "OpenCode --auto (tools unprompted); no OS sandbox"
        : "OpenCode run without --auto; no OS sandbox",
    };
  }

  if (id === "cursor") {
    if (mode === "plan") {
      return {
        sandboxed: false,
        reason: "Cursor --mode plan (read-only); no --force",
      };
    }
    return {
      sandboxed: false,
      reason: "Cursor --force (tools unprompted); no OS sandbox",
    };
  }

  if (id === "simulate") {
    return { sandboxed: false, reason: "Simulate; no sandbox" };
  }

  return { sandboxed: false, reason: `${id} has no sandbox flags` };
}

/**
 * @param {{ rules: Array<{ kind: string }> }} policy
 */
function seatbeltReason(policy) {
  const writes = policy.rules.filter((r) => r.kind === "write").length;
  const nets = policy.rules.filter((r) => r.kind === "network").length;
  const parts = [
    `writes confined to the worktree${writes ? ` and ${writes} write rule${writes === 1 ? "" : "s"}` : ""}`,
  ];
  if (nets) {
    parts.push(`egress via Solenta's proxy (${nets} network rule${nets === 1 ? "" : "s"})`);
  }
  return `Seatbelt: ${parts.join(", ")}`;
}

/**
 * @param {{
 *   provider?: string | null,
 *   permissionMode?: string | null,
 *   project?: { remoteHost?: string, path?: string } | null,
 *   policy?: { rules: Array<{ kind: string }> } | null,
 * } | null | undefined} input
 * @param {NodeJS.Platform} [platform]
 * @returns {SandboxInfo}
 */
function resolveSandbox(input, platform = process.platform) {
  const agent = agentSandbox(
    input && input.provider,
    input && input.permissionMode,
  );
  const where = locationReason(input && input.project, platform);
  const policy = input && input.policy;
  if (policy && seatbeltApplies(policy, input && input.project, platform)) {
    return {
      sandboxed: true,
      reason: `${seatbeltReason(policy)}; ${agent.reason.replace(/; no OS sandbox$/, "")}; ${where}`,
    };
  }
  return {
    sandboxed: agent.sandboxed,
    reason: `${agent.reason}; ${where}`,
  };
}

module.exports = { resolveSandbox };
