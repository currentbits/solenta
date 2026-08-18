"use strict";


const { createMemoryProxy } = require("./memory-proxy.js");

const TITLE_MAX = 80;
const BODY_TEXT_MAX = 1200;

/**
 * Build the memory entry title for a run outcome.
 * @param {{ provider: string, threadTitle: string }} opts
 * @returns {string}
 */
function buildRunTitle(opts) {
  const provider = String((opts && opts.provider) || "unknown");
  const threadTitle = String((opts && opts.threadTitle) || "Untitled");
  const raw = `${provider} run: ${threadTitle}`;
  if (raw.length <= TITLE_MAX) return raw;
  return raw.slice(0, TITLE_MAX);
}

/**
 * Build the memory entry body: truncated assistant/error text + footer.
 * @param {object} opts
 * @param {string} [opts.text]
 * @param {string} opts.provider
 * @param {string | null | undefined} opts.model
 * @param {"done" | "failed" | "stopped"} opts.status
 * @param {number} [opts.tokensIn]
 * @param {number} [opts.tokensOut]
 * @param {number} [opts.costUsd]
 * @returns {string}
 */
function buildRunBody(opts) {
  const text = String((opts && opts.text) || "").slice(0, BODY_TEXT_MAX);
  const provider = String((opts && opts.provider) || "unknown");
  const model =
    opts && opts.model != null && opts.model !== ""
      ? String(opts.model)
      : "null";
  const status = String((opts && opts.status) || "done");
  const tokensIn = Number(opts && opts.tokensIn) || 0;
  const tokensOut = Number(opts && opts.tokensOut) || 0;
  const costUsd = Number(opts && opts.costUsd) || 0;
  const footer = `provider=${provider} model=${model} status=${status} tokens_in=${tokensIn} tokens_out=${tokensOut} cost_usd=${costUsd}`;
  return text ? `${text}\n${footer}` : footer;
}

/**
 * Fire-and-forget: POST a run outcome to shared memory via the existing proxy.
 * Never throws; silent no-op when the memory server is not running.
 *
 * @param {object} args
 * @param {{ title?: string, provider?: string, model?: string | null }} args.thread
 * @param {{ slug?: string } | null} args.project
 * @param {object} args.outcome
 * @param {"done" | "failed" | "stopped"} args.outcome.status
 * @param {string} [args.outcome.text]
 * @param {string} [args.outcome.provider]
 * @param {string | null} [args.outcome.model]
 * @param {number} [args.outcome.tokensIn]
 * @param {number} [args.outcome.tokensOut]
 * @param {number} [args.outcome.costUsd]
 * @param {object} [deps]
 * @param {string} [deps.userDataPath]
 * @param {() => { running: boolean, adopted: boolean, port: number | null }} [deps.getStatus]
 * @param {number} [deps.timeoutMs]
 * @param {{ store: (input: object) => Promise<unknown> }} [deps.proxy]
 * @returns {Promise<void>}
 */
async function recordRunOutcome(args, deps = {}) {
  try {
    if (!args || !args.thread || !args.outcome) return;

    const thread = args.thread;
    const project = args.project;
    const outcome = args.outcome;
    const provider =
      outcome.provider != null
        ? String(outcome.provider)
        : String(thread.provider || "unknown");

    // Never record simulate provider runs.
    if (provider === "simulate") return;

    const model =
      outcome.model !== undefined ? outcome.model : thread.model ?? null;
    const title = buildRunTitle({
      provider,
      threadTitle: thread.title || "Untitled",
    });
    const body = buildRunBody({
      text: outcome.text,
      provider,
      model,
      status: outcome.status,
      tokensIn: outcome.tokensIn,
      tokensOut: outcome.tokensOut,
      costUsd: outcome.costUsd,
    });
    const payload = {
      type: "run",
      title,
      body,
      // Send the repo PATH raw: the memory server canonicalizes every
      // boundary (paths, worktrees, owner/repo slugs) to one key. A second
      // implementation here could only drift out of sync with it.
      project: project && project.path ? String(project.path) : null,
    };
    if (thread.id) {
      payload.citations = [{ kind: "thread", id: String(thread.id) }];
    }

    let proxy = deps.proxy;
    if (!proxy) {
      if (!deps.userDataPath) return;
      proxy = createMemoryProxy({
        userDataPath: deps.userDataPath,
        getStatus: deps.getStatus,
        timeoutMs: deps.timeoutMs,
      });
    }

    await proxy.store(payload);
  } catch {
    // Silent no-op: memory down, network error, bad payload — never affect runs.
  }
}

module.exports = {
  recordRunOutcome,
  buildRunTitle,
  buildRunBody,
  TITLE_MAX,
  BODY_TEXT_MAX,
};
