"use strict";

/**
 * Whether a thread state change is a "come back to me" moment (issue #31).
 * States are thread.status plus the synthetic "waiting" (working, but blocked
 * on a permission prompt). Unattended orchestration workers stall there
 * invisibly otherwise.
 *
 * @param {string | undefined | null} prevStatus
 * @param {string | undefined | null} nextStatus
 * @returns {boolean}
 */
function isNotifyTransition(prevStatus, nextStatus) {
  if (prevStatus === nextStatus) return false;
  // A thread that lands "failed" with no run of its own — an orchestrator
  // wake-up the budget gate rejected (issue #34) — is exactly the stall the
  // user must hear about. A never-seen thread (no prev) stays quiet.
  if (nextStatus === "failed" && prevStatus) return true;
  if (prevStatus !== "working" && prevStatus !== "waiting") return false;
  return (
    nextStatus === "done" || nextStatus === "failed" || nextStatus === "waiting"
  );
}

/**
 * Whether a thread state change should post a desktop notification.
 * Never notify while the app window is focused. Webhooks use
 * isNotifyTransition instead so they still fire from --serve-web / a phone.
 *
 * @param {string | undefined | null} prevStatus
 * @param {string | undefined | null} nextStatus
 * @param {boolean} windowFocused
 * @returns {boolean}
 */
function shouldNotify(prevStatus, nextStatus, windowFocused) {
  if (windowFocused) return false;
  return isNotifyTransition(prevStatus, nextStatus);
}

/**
 * Twin of src/threadSnooze.ts effectiveSnoozed. Electron stays CJS and
 * does not import the renderer module; keep the two in lockstep.
 * A live snooze silences desktop notifications until the timer elapses
 * or the thread raises its hand (fresh done/failed, or awaitingInput).
 *
 * @param {{ snoozedUntil?: number | null, snoozedAt?: number | null, status?: string, updatedAt?: number, awaitingInput?: boolean } | null | undefined} thread
 * @param {number} now
 * @returns {boolean}
 */
function isEffectivelySnoozed(thread, now) {
  if (!thread) return false;
  const until = thread.snoozedUntil;
  if (until == null || !Number.isFinite(until) || !Number.isFinite(now)) {
    return false;
  }
  if (until <= now) return false;
  if (thread.awaitingInput) return false;
  const at = thread.snoozedAt;
  if (at != null && Number.isFinite(at) && Number.isFinite(thread.updatedAt)) {
    if (
      (thread.status === "failed" || thread.status === "done") &&
      thread.updatedAt > at
    ) {
      return false;
    }
  }
  return true;
}

/**
 * @param {unknown} u
 * @returns {boolean}
 */
function isHttpUrl(u) {
  if (typeof u !== "string" || !u) return false;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * done / failed / waiting. nextStatus is already the synthetic "waiting"
 * from threadNotifyState (working + awaitingInput).
 * @param {string | undefined | null} nextStatus
 * @returns {"done" | "failed" | "waiting"}
 */
function notifyEvent(nextStatus) {
  if (nextStatus === "waiting") return "waiting";
  if (nextStatus === "failed") return "failed";
  return "done";
}

/**
 * Desktop-notification body copy, reused as the webhook text.
 * @param {"done" | "failed" | "waiting"} event
 */
function notifyBody(event) {
  if (event === "waiting") return "needs permission";
  if (event === "failed") return "failed";
  return "done";
}

/**
 * @param {{ url?: string | null, onDone?: boolean, onFailed?: boolean, onWaiting?: boolean } | null | undefined} webhook
 * @param {"done" | "failed" | "waiting"} event
 */
function webhookEventEnabled(webhook, event) {
  if (!webhook) return false;
  if (event === "waiting") return webhook.onWaiting !== false;
  if (event === "failed") return webhook.onFailed !== false;
  return webhook.onDone !== false;
}

/**
 * Outbound webhook is the phone-push twin of shouldNotify: same transitions,
 * but it fires even while the window is focused (issue #167). Mute, snooze,
 * and a missing/invalid URL still silence it. Independent of the desktop
 * notifications toggle.
 *
 * @param {{
 *   prevStatus?: string | null,
 *   nextStatus?: string | null,
 *   webhook?: { url?: string | null, onDone?: boolean, onFailed?: boolean, onWaiting?: boolean } | null,
 *   muted?: boolean,
 *   snoozed?: boolean,
 * }} opts
 */
function shouldPostWebhook(opts) {
  const webhook = opts && opts.webhook;
  if (!webhook || !isHttpUrl(webhook.url)) return false;
  if (opts.muted || opts.snoozed) return false;
  if (!isNotifyTransition(opts.prevStatus, opts.nextStatus)) return false;
  return webhookEventEnabled(webhook, notifyEvent(opts.nextStatus));
}

/**
 * @param {{ id?: string, projectId?: string, title?: string } | null | undefined} thread
 * @param {"done" | "failed" | "waiting"} event
 */
function buildWebhookPayload(thread, event) {
  const title = (thread && thread.title) || "Thread";
  const text = `${title}: ${notifyBody(event)}`;
  /** @type {{ event: string, threadId: string, projectId?: string, title: string, status: string, text: string, content: string, message: string }} */
  const payload = {
    event,
    threadId: thread && thread.id ? String(thread.id) : "",
    title,
    status: event,
    text,
    content: text,
    message: text,
  };
  if (thread && thread.projectId) payload.projectId = String(thread.projectId);
  return payload;
}

/**
 * @param {string} url
 * @returns {"ntfy" | "generic"}
 */
function webhookKind(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === "ntfy.sh" || host === "ntfy.cloud" || host.startsWith("ntfy.")) {
      return "ntfy";
    }
  } catch {
    // fall through
  }
  return "generic";
}

/**
 * Slack incoming webhooks read `text`; Discord reads `content`. ntfy topic
 * URLs want a plain body plus Title header. One POST either way.
 *
 * @param {string} url
 * @param {{ event: string, title: string, text: string, content: string, message: string }} payload
 * @returns {{ headers: Record<string, string>, body: string }}
 */
function shapeWebhookRequest(url, payload) {
  if (webhookKind(url) === "ntfy") {
    const tags =
      payload.event === "failed"
        ? "x"
        : payload.event === "waiting"
          ? "hourglass"
          : "white_check_mark";
    return {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        Title: String(payload.title || "Solenta").slice(0, 200),
        Tags: tags,
      },
      body: payload.text,
    };
  }
  return {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

/**
 * Fire-and-forget POST. Never throws into the run path.
 *
 * @param {{
 *   thread?: { id?: string, projectId?: string, title?: string, muted?: boolean },
 *   prevStatus?: string | null,
 *   nextStatus?: string | null,
 *   webhook?: { url?: string | null, onDone?: boolean, onFailed?: boolean, onWaiting?: boolean } | null,
 *   muted?: boolean,
 *   snoozed?: boolean,
 *   fetchImpl?: (input: string, init?: object) => Promise<unknown>,
 *   timeoutMs?: number,
 *   recordSecretUse?: (evt: { purpose: string, key: string }) => void,
 *   log?: (err: unknown) => void,
 * }} opts
 */
async function dispatchWebhook(opts) {
  try {
    if (!shouldPostWebhook(opts)) return;
    const url = opts.webhook && opts.webhook.url;
    if (!url) return;
    const event = notifyEvent(opts.nextStatus);
    const payload = buildWebhookPayload(opts.thread, event);
    const request = shapeWebhookRequest(url, payload);
    if (typeof opts.recordSecretUse === "function") {
      try {
        opts.recordSecretUse({ purpose: "webhook-post", key: "webhook:url" });
      } catch {
        // audit must never block the post
      }
    }
    const doFetch = opts.fetchImpl || globalThis.fetch;
    if (typeof doFetch !== "function") return;
    const timeoutMs =
      opts.timeoutMs != null && Number.isFinite(Number(opts.timeoutMs))
        ? Number(opts.timeoutMs)
        : 5000;
    /** @type {RequestInit} */
    const init = {
      method: "POST",
      headers: request.headers,
      body: request.body,
      redirect: "error",
    };
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      init.signal = AbortSignal.timeout(timeoutMs);
    }
    await doFetch(url, init);
  } catch (err) {
    if (typeof opts.log === "function") {
      try {
        opts.log(err);
      } catch {
        // never throw
      }
    }
  }
}

module.exports = {
  shouldNotify,
  isNotifyTransition,
  isEffectivelySnoozed,
  notifyEvent,
  notifyBody,
  shouldPostWebhook,
  buildWebhookPayload,
  shapeWebhookRequest,
  dispatchWebhook,
};
