"use strict";

/**
 * Plan and run audited provider-plugin activation. Commands are argv arrays
 * only — never a shell string. Inputs come from the main-owned manifest.
 */

const { execFile } = require("node:child_process");
const { parseGitHubSkillUrl } = require("./skillPackages.js");

const PLUGIN_NAME_RE = /^[a-z0-9-]+$/;
const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 16 * 1024;
const MAX_ERROR_CHARS = 200;
const ALLOWED_BINARIES = new Set(["codex", "grok"]);
const PIN_REF_ERROR =
  "Provider plugin activation cannot safely pin the previewed ref.";

const RECOGNIZED = new Set(["claude-plugin", "codex-plugin", "grok-plugin"]);
const COVERABLE = new Set(["plugin", "hooks", "commands"]);

function extraKind(extra) {
  if (extra && extra.activation && typeof extra.activation.kind === "string") {
    return extra.activation.kind;
  }
  return extra && typeof extra.kind === "string" ? extra.kind : "";
}

function pluginNameOf(extra) {
  if (extra && typeof extra.pluginName === "string" && extra.pluginName.trim()) {
    return extra.pluginName.trim();
  }
  if (extra && typeof extra.label === "string" && extra.label.trim()) {
    return extra.label.trim();
  }
  return "";
}

function resolveSource(manifest) {
  if (!manifest || manifest.kind === "local") return null;
  if (typeof manifest.sourceUrl !== "string" || !manifest.sourceUrl.trim()) {
    return null;
  }
  try {
    return parseGitHubSkillUrl(manifest.sourceUrl);
  } catch {
    return null;
  }
}

function isRootRepoSource(source) {
  return Boolean(
    source &&
      source.kind === "repo" &&
      !source.ref &&
      !source.path,
  );
}

/**
 * @param {{
 *   kind?: string,
 *   sourceUrl?: string,
 *   plugins?: object[],
 * }} manifest
 */
function planPluginActions(manifest) {
  const extras = Array.isArray(manifest && manifest.plugins)
    ? manifest.plugins
    : [];
  const source = resolveSource(manifest);
  const pinned = Boolean(source) && !isRootRepoSource(source);
  const ownerRepo = source ? `${source.owner}/${source.repo}` : "";
  const marketplace =
    source && PLUGIN_NAME_RE.test(source.repo) ? source.repo : "";

  const hasRecognized = extras.some((extra) => RECOGNIZED.has(extraKind(extra)));
  const seenKinds = new Set();
  /** @type {object[]} */
  const plan = [];
  for (const extra of extras) {
    const kind = extraKind(extra);
    const base = {
      provider: extra.provider,
      label: extra.label,
      kind,
    };
    if (pinned) {
      plan.push({
        ...base,
        status: "unsupported",
        error: PIN_REF_ERROR,
      });
      continue;
    }
    if (!RECOGNIZED.has(kind)) {
      const canBeCovered = COVERABLE.has(kind) && hasRecognized;
      plan.push({
        ...base,
        deferred: canBeCovered,
        status: canBeCovered ? undefined : "unsupported",
      });
      continue;
    }
    if (seenKinds.has(kind)) {
      plan.push({ ...base, deferred: true });
      continue;
    }
    seenKinds.add(kind);
    if (!source || !marketplace) {
      plan.push({ ...base, status: "unsupported" });
      continue;
    }
    if (kind === "grok-plugin") {
      plan.push({
        ...base,
        commands: [
          {
            binary: "grok",
            args: ["plugin", "install", ownerRepo, "--trust"],
          },
        ],
      });
      continue;
    }
    const name = pluginNameOf(extra);
    if (!PLUGIN_NAME_RE.test(name)) {
      plan.push({ ...base, status: "unsupported" });
      continue;
    }
    const spec = `${name}@${marketplace}`;
    if (kind === "codex-plugin") {
      plan.push({
        ...base,
        commands: [
          {
            binary: "codex",
            args: ["plugin", "marketplace", "add", ownerRepo],
          },
          { binary: "codex", args: ["plugin", "add", spec] },
        ],
      });
      continue;
    }
    plan.push({
      ...base,
      status: "manual",
      instructions: [
        `/plugin marketplace add ${ownerRepo}`,
        `/plugin install ${spec}`,
      ],
    });
  }
  return plan;
}

function publicError(err) {
  const stderr = err && typeof err.stderr === "string" ? err.stderr : "";
  const message = err && err.message ? String(err.message) : "";
  let text = (stderr || message || "Plugin activation failed")
    .replace(/\s+/g, " ")
    .trim();
  text = text.replace(/(?:ghs_|ghp_|github_pat_)[A-Za-z0-9_]+/g, "");
  text = text.replace(/(?:[A-Za-z]:)?(?:\/|\\)[^\s"']+/g, "");
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > MAX_ERROR_CHARS) text = text.slice(0, MAX_ERROR_CHARS);
  return text || "Plugin activation failed";
}

function publicRow(action, status, extra) {
  const row = {
    provider: action.provider,
    label: action.label,
    status,
  };
  const instructions =
    extra && extra.instructions
      ? extra.instructions
      : action.instructions;
  if (status === "manual" && Array.isArray(instructions)) {
    row.instructions = instructions.slice();
  }
  const error =
    extra && extra.error
      ? extra.error
      : status === "unsupported" || status === "failed"
        ? action.error
        : undefined;
  if ((status === "failed" || status === "unsupported") && error) {
    row.error = error;
  }
  return row;
}

function resolveDeferred(action, recognized) {
  const activated = recognized.filter((row) => row.status === "activated");
  const manuals = recognized.filter(
    (row) => row.status === "manual" && Array.isArray(row.instructions) && row.instructions.length,
  );
  const faileds = recognized.filter((row) => row.status === "failed");
  if (activated.length) return publicRow(action, "covered");
  if (manuals.length) {
    return publicRow(action, "manual", {
      instructions: manuals[0].instructions,
    });
  }
  if (faileds.length) {
    return publicRow(action, "failed", {
      error: faileds[0].error || "Plugin activation failed",
    });
  }
  const pinned = recognized.find(
    (row) => row.status === "unsupported" && row.error,
  );
  return publicRow(
    action,
    "unsupported",
    pinned ? { error: pinned.error } : undefined,
  );
}

function isDeferred(action) {
  return Boolean(
    action &&
      (action.deferred || COVERABLE.has(action.kind)) &&
      action.status !== "unsupported" &&
      action.status !== "manual",
  );
}

/**
 * @param {object[]} plan
 * @param {{
 *   trustPluginCode?: boolean,
 *   runFile?: (binary: string, args: string[], opts?: object) => Promise<unknown>,
 * }} opts
 */
async function executePluginActions(plan, opts) {
  const actions = Array.isArray(plan) ? plan : [];
  if (!(opts && opts.trustPluginCode === true)) {
    return actions.map((action) => publicRow(action, "skipped"));
  }
  const runFile = opts && typeof opts.runFile === "function" ? opts.runFile : null;
  /** @type {Array<object | null>} */
  const out = [];
  /** @type {object[]} */
  const recognized = [];
  for (const action of actions) {
    if (isDeferred(action)) {
      out.push(null);
      continue;
    }
    if (action.status === "unsupported" || action.status === "manual") {
      const row = publicRow(action, action.status);
      recognized.push(row);
      out.push(row);
      continue;
    }
    const commands = Array.isArray(action.commands) ? action.commands : [];
    if (!commands.length) {
      const row = publicRow(action, "unsupported");
      recognized.push(row);
      out.push(row);
      continue;
    }
    if (!runFile) {
      const row = publicRow(action, "failed", {
        error: "Plugin activation is unavailable",
      });
      recognized.push(row);
      out.push(row);
      continue;
    }
    try {
      for (const cmd of commands) {
        await runFile(cmd.binary, cmd.args, { timeout: TIMEOUT_MS });
      }
      const row = publicRow(action, "activated");
      recognized.push(row);
      out.push(row);
    } catch (err) {
      const row = publicRow(action, "failed", { error: publicError(err) });
      recognized.push(row);
      out.push(row);
    }
  }
  return out.map((row, index) =>
    row || resolveDeferred(actions[index], recognized),
  );
}

async function activateSkillPlugins(opts) {
  const plan = planPluginActions(opts && opts.manifest);
  return executePluginActions(plan, {
    trustPluginCode: opts && opts.trustPluginCode,
    runFile: opts && opts.runFile,
  });
}

/**
 * Production runner. Tests may inject `execFile`. Callers cannot enable a shell.
 * @param {{ execFile?: typeof execFile }} [deps]
 */
/**
 * Logical allowlist name (`grok` / `codex`) → resolved provider bin.
 * Plugin plans always pass the short name; installs that only work via
 * CODER_GROK_BIN / CODER_CODEX_BIN must still activate (issue #706).
 * @param {string} bin
 * @param {NodeJS.ProcessEnv} [env]
 */
function resolvePluginBin(bin, env = process.env) {
  if (bin !== "grok" && bin !== "codex") return bin;
  try {
    const { getProvider, resolveBin } = require("./providers.js");
    const entry = getProvider(bin);
    const resolved = resolveBin(entry, env);
    return resolved || bin;
  } catch {
    return bin;
  }
}

function createSafeCommandRunner(deps) {
  const execFileImpl =
    deps && typeof deps.execFile === "function" ? deps.execFile : execFile;
  return function runFile(binary, args) {
    return new Promise((resolve, reject) => {
      const bin = typeof binary === "string" ? binary : "";
      const argv = Array.isArray(args) ? args.map((value) => String(value)) : [];
      if (!ALLOWED_BINARIES.has(bin)) {
        reject(new Error("Plugin activation is unavailable"));
        return;
      }
      execFileImpl(
        resolvePluginBin(bin),
        argv,
        {
          timeout: TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
          encoding: "utf8",
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
        (err, stdout, stderr) => {
          const out = typeof stdout === "string" ? stdout.slice(0, MAX_BUFFER) : "";
          const errText =
            typeof stderr === "string" ? stderr.slice(0, MAX_BUFFER) : "";
          if (err) {
            const wrapped = new Error("Plugin activation failed");
            wrapped.stderr = errText;
            reject(wrapped);
            return;
          }
          resolve({ stdout: out, stderr: errText });
        },
      );
    });
  };
}

module.exports = {
  PLUGIN_NAME_RE,
  TIMEOUT_MS,
  PIN_REF_ERROR,
  planPluginActions,
  executePluginActions,
  activateSkillPlugins,
  createSafeCommandRunner,
  resolvePluginBin,
};
