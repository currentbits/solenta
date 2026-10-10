"use strict";

// Settings, workflow templates, automations and app status.

const { randomUUID } = require("node:crypto");
const { getProvider } = require("./providers.js");
const { getMemoryStatus } = require("./memory-sup.js");
const {
  normalizeModelForProvider,
  isKnownProviderId,
} = require("./services-notes.js");

/**
 * Validate a workflow template before save.
 * Availability of the provider binary is NOT required to save.
 *
 * @param {{ name?: string, phases?: unknown }} template
 */
function validateWorkflowTemplate(template) {
  if (!template || typeof template !== "object") {
    throw new Error("Template is required");
  }
  const name = template.name != null ? String(template.name).trim() : "";
  if (!name) {
    throw new Error("Template name is required");
  }

  const phases = template.phases;
  if (!Array.isArray(phases)) {
    throw new Error("Template phases must be an array");
  }
  if (phases.length < 1 || phases.length > 6) {
    throw new Error("Template must have between 1 and 6 phases");
  }

  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    if (!phase || typeof phase !== "object") {
      throw new Error(`Phase ${i + 1}: invalid phase object`);
    }
    const phaseName =
      phase.name != null ? String(phase.name).trim() : "";
    if (!phaseName) {
      throw new Error(`Phase ${i + 1}: name is required`);
    }
    if (phaseName.length > 24) {
      throw new Error(
        `Phase "${phaseName}": name must be at most 24 characters`,
      );
    }

    const agentCount = phase.agentCount;
    if (
      typeof agentCount !== "number" ||
      !Number.isInteger(agentCount) ||
      agentCount < 1 ||
      agentCount > 4
    ) {
      throw new Error(
        `Phase "${phaseName}": agentCount must be an integer from 1 to 4`,
      );
    }

    const instruction =
      phase.instruction != null ? String(phase.instruction).trim() : "";
    if (!instruction) {
      throw new Error(`Phase "${phaseName}": instruction is required`);
    }
    if (String(phase.instruction).length > 2000) {
      throw new Error(
        `Phase "${phaseName}": instruction must be at most 2000 characters`,
      );
    }

    const providerId =
      phase.provider != null ? String(phase.provider).trim() : "";
    if (!providerId) {
      throw new Error(`Phase "${phaseName}": provider is required`);
    }
    const entry = getProvider(providerId);
    if (!entry || entry.kind === "simulate") {
      throw new Error(
        `Phase "${phaseName}": unknown provider "${providerId}"`,
      );
    }

    // ONE rule for accepting a model, shared with setProvider. This used to be
    // an inline membership check, which meant filling the previously-empty
    // model lists made template phases STRICTER than before while setProvider
    // got looser: a template saved with a custom id then threw on a no-op
    // re-save. Routing through the helper also gives phases the trim, empty and
    // length guards the inline block never had.
    try {
      normalizeModelForProvider(entry, phase.model);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Phase "${phaseName}": ${msg}`);
    }
  }
}

/**
 * @param {import('./store').Store} store
 */
function listTemplates(store) {
  return store.listTemplates();
}

/**
 * Validate and save a workflow template.
 * @param {import('./store').Store} store
 * @param {{ id?: string, name: string, phases: object[] }} template
 */
function saveTemplate(store, template) {
  validateWorkflowTemplate(template);
  const phases = (template.phases || []).map((p) => ({
    name: String(p.name).trim(),
    agentCount: p.agentCount,
    instruction: String(p.instruction),
    provider: String(p.provider).trim(),
    // Store the NORMALIZED value. Validating and then persisting the raw
    // string meant a padded id stored padded, and " " + 100 chars + " " passed
    // the length guard and then stored 102 characters.
    // The entry argument is unused by normalizeModelForProvider now that the
    // list is a suggestion; pass null rather than computing a lookup for show.
    model: normalizeModelForProvider(null, p.model),
  }));
  const saved = store.saveTemplate({
    id: template.id,
    name: String(template.name).trim(),
    phases,
  });
  store.save();
  return saved;
}

/**
 * @param {import('./store').Store} store
 * @param {{ id: string }} input
 */
function removeTemplate(store, input) {
  const id = input && input.id != null ? String(input.id) : "";
  if (!id) {
    throw new Error("Template id is required");
  }
  store.removeTemplate(id);
  store.save();
}

/**
 * #164: write a saved template into the thread's checkout as WORKFLOW.md (or
 * over the repo's existing .solenta/workflow.md). An existing file is only
 * replaced with `overwrite`; otherwise returns written:false so the UI can ask.
 * @param {import('./store').Store} store
 * @param {{ id: string, threadId: string, overwrite?: boolean }} input
 * @returns {{ written: boolean, path: string }}
 */
function exportTemplateToRepo(store, input) {
  const fs = require("node:fs");
  const path = require("node:path");
  const repoWorkflow = require("./repoWorkflow.js");
  const template = store.getTemplate(String((input && input.id) || ""));
  if (!template) throw new Error("Unknown workflow template");
  const thread = store.getThread(String((input && input.threadId) || ""));
  if (!thread) throw new Error("Pick a thread to export into its repo");
  const project = store.getProject(thread.projectId);
  if (!project) throw new Error(`Unknown project: ${thread.projectId}`);
  if (project.remoteHost || require("./wsl.js").wslTarget(project)) {
    throw new Error("Export to repo is not supported for remote projects");
  }
  const dir = thread.worktreePath || project.path;
  const rel =
    repoWorkflow.findRepoWorkflow(dir) || repoWorkflow.REPO_WORKFLOW_FILES[0];
  const file = path.join(dir, rel);
  if (fs.existsSync(file) && !(input && input.overwrite)) {
    return { written: false, path: file };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, repoWorkflow.serializeRepoWorkflow(template));
  return { written: true, path: file };
}

/**
 * @param {import('./store').Store} store
 * @returns {{ dailyBudgetUsd: number | null, orchestrationBudgetUsd: number | null, autoSettleAfterDays: number | null }}
 */
function getSettings(store) {
  return store.getSettings();
}

/**
 * Validate and persist settings. Does not touch threads.
 * @param {import('./store').Store} store
 * @param {Partial<{ dailyBudgetUsd: number | null, orchestrationBudgetUsd: number | null, autoSettleAfterDays: number | null }>} patch
 * @returns {{ dailyBudgetUsd: number | null, orchestrationBudgetUsd: number | null, autoSettleAfterDays: number | null }}
 */
function setSettings(store, patch, opts) {
  const next = store.setSettings(patch || {}, opts);
  store.save();
  return next;
}

const AUTOMATION_PRESETS = new Set(["hourly", "daily", "weekly"]);

/**
 * @param {unknown} hour
 * @param {"hourly" | "daily" | "weekly"} preset
 * @returns {number | null}
 */
function normalizeAutomationHour(preset, hour) {
  if (preset === "hourly") return null;
  if (hour == null || hour === "") {
    throw new Error("Hour is required for daily and weekly automations");
  }
  const n = Number(hour);
  if (!Number.isInteger(n) || n < 0 || n > 23) {
    throw new Error("Hour must be an integer from 0 to 23");
  }
  return n;
}

/**
 * @param {import('./store').Store} store
 * @param {object} input
 * @returns {object}
 */
function normalizeAutomationInput(store, input, existing) {
  const src = input && typeof input === "object" ? input : {};
  const base = existing || {};

  const nameRaw = Object.prototype.hasOwnProperty.call(src, "name")
    ? src.name
    : base.name;
  const name = nameRaw != null ? String(nameRaw).trim() : "";
  if (!name) {
    throw new Error("Automation name is required");
  }

  const projectId = Object.prototype.hasOwnProperty.call(src, "projectId")
    ? String(src.projectId || "")
    : String(base.projectId || "");
  if (!projectId) {
    throw new Error("Project is required");
  }
  if (!store.getProject(projectId)) {
    throw new Error(`Unknown project: ${projectId}`);
  }

  const promptRaw = Object.prototype.hasOwnProperty.call(src, "prompt")
    ? src.prompt
    : base.prompt;
  const prompt = promptRaw != null ? String(promptRaw) : "";
  if (!String(prompt).trim()) {
    throw new Error("Prompt is required");
  }

  const provider = Object.prototype.hasOwnProperty.call(src, "provider")
    ? String(src.provider || "")
    : String(base.provider || "");
  if (!provider || !isKnownProviderId(provider)) {
    throw new Error(`Unknown provider: ${src.provider ?? base.provider}`);
  }

  const modelRaw = Object.prototype.hasOwnProperty.call(src, "model")
    ? src.model
    : base.model;
  const model = normalizeModelForProvider(getProvider(provider), modelRaw);

  const preset = Object.prototype.hasOwnProperty.call(src, "preset")
    ? String(src.preset || "")
    : String(base.preset || "");
  if (!AUTOMATION_PRESETS.has(preset)) {
    throw new Error(
      `Invalid preset: ${preset || "(empty)"}. Expected hourly, daily, or weekly`,
    );
  }

  const hourRaw = Object.prototype.hasOwnProperty.call(src, "hour")
    ? src.hour
    : base.hour;
  const hour = normalizeAutomationHour(preset, hourRaw);

  let enabled = base.enabled !== undefined ? Boolean(base.enabled) : true;
  if (Object.prototype.hasOwnProperty.call(src, "enabled")) {
    enabled = Boolean(src.enabled);
  }

  return { name, projectId, prompt, provider, model, preset, hour, enabled };
}

/**
 * @param {import('./store').Store} store
 */
function listAutomations(store) {
  return store.getAutomations().map((a) => ({ ...a }));
}

/**
 * @param {import('./store').Store} store
 * @param {object} input
 */
function addAutomation(store, input) {
  const { nextFire } = require("./automations.js");
  const fields = normalizeAutomationInput(store, input, null);
  const now = Date.now();
  const created = {
    id: randomUUID(),
    ...fields,
    lastRunAt: null,
    nextRunAt: nextFire(fields.preset, fields.hour, now),
    lastError: null,
    consecutiveFailures: 0,
    pendingRunThreadId: null,
  };
  const list = store.getAutomations().slice();
  list.push(created);
  store.setAutomations(list);
  store.save();
  return { ...created };
}

/**
 * @param {import('./store').Store} store
 * @param {{ id: string } & object} input
 */
function updateAutomation(store, input) {
  const { nextFire } = require("./automations.js");
  const id = input && input.id != null ? String(input.id) : "";
  const existing = store.getAutomation(id);
  if (!existing) {
    throw new Error(`Unknown automation: ${id}`);
  }
  const fields = normalizeAutomationInput(store, input, existing);
  const scheduleChanged =
    fields.preset !== existing.preset || fields.hour !== existing.hour;
  // #160: turning it back on is the explicit re-enable after an auto-pause.
  const reEnabled = fields.enabled && !existing.enabled;
  const updated = {
    ...existing,
    ...fields,
    ...(reEnabled ? { consecutiveFailures: 0, lastError: null } : {}),
    nextRunAt: scheduleChanged
      ? nextFire(fields.preset, fields.hour, Date.now())
      : existing.nextRunAt,
  };
  store.setAutomations(
    store.getAutomations().map((a) => (a && a.id === id ? updated : a)),
  );
  store.save();
  return { ...updated };
}

/**
 * @param {import('./store').Store} store
 * @param {{ id: string }} input
 */
function removeAutomation(store, input) {
  const id = input && input.id != null ? String(input.id) : "";
  if (!id) {
    throw new Error("Automation id is required");
  }
  const existing = store.getAutomation(id);
  if (!existing) {
    throw new Error(`Unknown automation: ${id}`);
  }
  store.setAutomations(store.getAutomations().filter((a) => !a || a.id !== id));
  store.save();
}

/**
 * Live app status: today's spend, memory health (with counts), and which build
 * is running. A /health failure degrades to nulls; status must never throw.
 * @param {import('./store').Store} store
 * @param {{ health?: () => Promise<any>, status?: () => any, pkg?: any, platform?: string }} [deps] injectable for tests
 */
async function appStatus(store, deps = {}) {
  const spend = store.getSpendToday();
  const spendTodayUsd = Math.round(spend * 100) / 100;
  const base = deps.status ? deps.status() : getMemoryStatus();

  let entries = null;
  let vectors = null;
  let lastError = null;
  /** @type {{ root: string, key: string }[]} */
  let collisions = [];
  if (base.running) {
    try {
      const health = deps.health ? await deps.health() : await fetchMemoryHealth(base.port);
      if (health && typeof health === "object") {
        entries = Number.isFinite(health.entryCount) ? health.entryCount : null;
        vectors =
          health.vectors && Number.isFinite(health.vectors.count)
            ? health.vectors.count
            : null;
        const je = health.janitor && health.janitor.lastError;
        lastError = je ? `${je.step}: ${je.message}` : null;
        if (Array.isArray(health.projectCollisions)) collisions = health.projectCollisions;
      }
    } catch {
      // health unreachable: report nulls rather than failing status
    }
  }

  let version = "0.0.0";
  let sha = null;
  let time = null;
  let channel = null;
  try {
    const pkg = deps.pkg || require("../package.json");
    version = String(pkg.version || version);
    sha = pkg.buildSha ? String(pkg.buildSha) : null;
    time = pkg.buildTime ? String(pkg.buildTime) : null;
    channel = pkg.channel ? String(pkg.channel) : null;
  } catch {
    // dev tree without a stamped package: leave nulls
  }

  return {
    spendTodayUsd,
    memory: { ...base, entries, vectors, lastError, collisions },
    build: { version, sha, time, channel, platform: deps.platform || process.platform },
  };
}

/** GET /health on the local memory server; resolves null on any failure. */
function fetchMemoryHealth(port) {
  return new Promise((resolve) => {
    if (!port) return resolve(null);
    let settled = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let deadline;
    /** @param {any} value */
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      try {
        req.destroy();
      } catch {
        // already closed
      }
      resolve(value);
    };
    const req = require("node:http").get(
      { host: "127.0.0.1", port, path: "/health", timeout: 1500 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          // Health is a small JSON document; refuse to buffer a runaway body.
          if (body.length > 256 * 1024) return finish(null);
          body += c;
        });
        res.on("end", () => {
          // A 500 whose body happens to parse is not health.
          if (res.statusCode !== 200) return finish(null);
          try {
            finish(JSON.parse(body));
          } catch {
            finish(null);
          }
        });
      },
    );
    req.on("error", () => finish(null));
    req.on("timeout", () => finish(null));
    // `timeout` is socket INACTIVITY, so a server dribbling a byte at a time can
    // hold status open forever. This is the absolute deadline. It is armed AFTER
    // http.get: an invalid port makes get() throw synchronously, and a timer
    // armed first would outlive the rejection and then fire into a TDZ `req`.
    deadline = setTimeout(() => finish(null), 2000);
  });
}

module.exports = {
  validateWorkflowTemplate,
  listTemplates,
  saveTemplate,
  removeTemplate,
  exportTemplateToRepo,
  getSettings,
  setSettings,
  listAutomations,
  addAutomation,
  updateAutomation,
  removeAutomation,
  appStatus,
};
