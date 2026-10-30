"use strict";

const zlib = require("node:zlib");

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
 * Whether a thread is waiting on the user, for the dock / taskbar badge
 * (#1506). The sidebar's "needs you" rows: blocked on a permission, plan
 * or question card, or failed / finished and unread (src/threadUnread.ts).
 * A failure the user has already looked at stops counting, or one old
 * failure would pin the badge forever. Muted, snoozed, archived, trashed
 * and memory-consolidation threads never count.
 *
 * @param {{ status?: string, awaitingInput?: boolean, pendingQuestion?: unknown, muted?: boolean, archived?: boolean, trashedAt?: number | null, memoryConsolidate?: boolean, updatedAt?: number, lastVisitedAt?: number | null, snoozedUntil?: number | null, snoozedAt?: number | null } | null | undefined} thread
 * @param {number} now
 * @returns {boolean}
 */
function needsUser(thread, now) {
  if (!thread || thread.muted || thread.archived) return false;
  if (Number.isFinite(thread.trashedAt) || thread.memoryConsolidate === true) {
    return false;
  }
  if (isEffectivelySnoozed(thread, now)) return false;
  if (thread.awaitingInput || thread.pendingQuestion) return true;
  const unread =
    thread.lastVisitedAt != null && Number(thread.updatedAt) > thread.lastVisitedAt;
  return (
    unread &&
    (thread.status === "failed" || thread.status === "done" || thread.status === "idle")
  );
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** @param {Buffer} buf */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * @param {string} type Four-letter PNG chunk type, e.g. "IHDR".
 * @param {Buffer} data
 */
function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/**
 * A filled-circle PNG in one flat color, hand-built with zlib (no image
 * dependency) for the small per-status notification icon (#1790). Good
 * enough at notification-icon size (Windows/Linux only; macOS ignores the
 * `icon` field and gets a title glyph instead, see notificationOptions).
 * @param {number} size
 * @param {[number, number, number]} rgb
 * @returns {Buffer}
 */
function circlePng(size, [r, g, b]) {
  const stride = 1 + size * 4; // filter byte + RGBA row
  const raw = Buffer.alloc(size * stride);
  const center = (size - 1) / 2;
  const radiusSq = (size / 2 - 1) * (size / 2 - 1);
  for (let y = 0; y < size; y++) {
    const rowStart = y * stride;
    for (let x = 0; x < size; x++) {
      const dx = x - center;
      const dy = y - center;
      const inside = dx * dx + dy * dy <= radiusSq;
      const o = rowStart + 1 + x * 4;
      raw[o] = inside ? r : 0;
      raw[o + 1] = inside ? g : 0;
      raw[o + 2] = inside ? b : 0;
      raw[o + 3] = inside ? 255 : 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Status dot colors, RGB. */
const STATUS_COLOR = {
  done: [0x2e, 0xa0, 0x43],
  failed: [0xd1, 0x3a, 0x2e],
  waiting: [0xd9, 0xa2, 0x1f],
};

/** Status title glyphs — macOS fallback where the `icon` field is ignored. */
const STATUS_GLYPH = { done: "✓", failed: "✕", waiting: "●" };

/** @type {Record<string, Buffer> | null} */
let statusIconCache = null;

/** @param {"done" | "failed" | "waiting"} event */
function statusIconPng(event) {
  if (!statusIconCache) {
    statusIconCache = {
      done: circlePng(48, STATUS_COLOR.done),
      failed: circlePng(48, STATUS_COLOR.failed),
      waiting: circlePng(48, STATUS_COLOR.waiting),
    };
  }
  return statusIconCache[event];
}

/**
 * Desktop notification options. No `silent`: the OS plays its default
 * sound, as it always has. The attention-sound setting never changes that.
 *
 * Outcome icon (#1790): pass `event` for a done/failed/waiting transition
 * ("waiting" covers both an approval prompt and a question card, same as
 * threadNotifyState). macOS ignores the Notification `icon` field for its
 * own app icon, so there the title gets a status glyph prefix instead;
 * Windows/Linux get a generated status-color PNG via `iconBuffer` — the
 * caller (main.js, which has `electron`) turns that into a NativeImage,
 * since this module stays requirable under plain Node for its tests.
 *
 * @param {string | undefined} title
 * @param {string} body
 * @param {{ event?: "done" | "failed" | "waiting", platform?: string }} [opts]
 */
function notificationOptions(title, body, opts = {}) {
  const base = { title: title || "Thread", body };
  const event = opts.event;
  if (!event) return base;
  const platform = opts.platform || process.platform;
  if (platform === "darwin") {
    return { ...base, title: `${STATUS_GLYPH[event]} ${base.title}` };
  }
  return { ...base, iconBuffer: statusIconPng(event) };
}

/**
 * The opt-in attention sound (#1506) covers the one case a notification
 * cannot: the window is focused, so shouldNotify posts nothing. Callers
 * have already applied the transition, mute and snooze checks.
 * @param {{ notificationSound?: boolean }} settings
 * @param {boolean} windowFocused
 */
function shouldPlayAlert(settings, windowFocused) {
  return windowFocused && settings.notificationSound === true;
}

/**
 * Per-event notification switches (#1725). Defaults are what shipped before
 * them: every thread transition on, CI failed (new) off.
 */
const NOTIFY_EVENT_DEFAULTS = Object.freeze({
  approval: true,
  turnFinished: true,
  turnFailed: true,
  automationFinished: true,
  ciFailed: false,
});

/**
 * Which switch governs a transition that isNotifyTransition passed.
 * @param {{ automationId?: string | null } | null | undefined} thread
 * @param {string | undefined | null} nextStatus
 * @returns {"approval" | "turnFinished" | "turnFailed" | "automationFinished"}
 */
function notifyEventKey(thread, nextStatus) {
  if (nextStatus === "waiting") return "approval";
  if (thread && thread.automationId) return "automationFinished";
  return nextStatus === "failed" ? "turnFailed" : "turnFinished";
}

/**
 * @param {Partial<Record<keyof typeof NOTIFY_EVENT_DEFAULTS, boolean>> | null | undefined} events
 * @param {keyof typeof NOTIFY_EVENT_DEFAULTS} key
 */
function notifyEventEnabled(events, key) {
  const v = events && events[key];
  return typeof v === "boolean" ? v : NOTIFY_EVENT_DEFAULTS[key];
}

/**
 * Desktop notification for a newly failing check on a watched PR, or null
 * when settings, focus or mute say no. Same gates as a thread transition.
 * @param {{ notifications?: boolean, notifyEvents?: object, notificationProjects?: string[] }} settings
 * @param {{ title?: string, muted?: boolean, projectId?: string | null } | null | undefined} thread
 * @param {boolean} windowFocused
 * @param {{ number: number, checks: Array<{ name: string }> }} info
 * @param {(id: string) => boolean} [projectExists]
 */
function ciFailedNotification(settings, thread, windowFocused, info, projectExists) {
  if (windowFocused || !thread || thread.muted) return null;
  if (settings.notifications === false) return null;
  if (!notifyEventEnabled(settings.notifyEvents, "ciFailed")) return null;
  if (!shouldNotifyForProject(settings, thread.projectId, projectExists)) return null;
  const names = info.checks.map((c) => c.name).join(", ");
  return notificationOptions(thread.title, `PR #${info.number} checks failed: ${names}`);
}

/**
 * Whether a thread in this project may notify (#1746): desktop
 * notification and alert sound. An empty list means every project. Ids
 * of deleted projects are ignored, so a list of only stale ids is "all"
 * rather than "none".
 * @param {{ notificationProjects?: string[] } | null | undefined} settings
 * @param {string | null | undefined} projectId
 * @param {(id: string) => boolean} [projectExists]
 * @returns {boolean}
 */
function shouldNotifyForProject(settings, projectId, projectExists = () => true) {
  const ids = Array.isArray(settings && settings.notificationProjects)
    ? settings.notificationProjects.filter(projectExists)
    : [];
  return ids.length === 0 || (projectId != null && ids.includes(projectId));
}

/**
 * Which local alerts a notify transition raises: the desktop notification
 * (background) and the opt-in sound (focused). The one place main.js asks,
 * so the project filter (#1746) covers both. Callers have already applied
 * the transition, mute and snooze checks.
 * @param {{ notifications?: boolean, notificationSound?: boolean, notificationProjects?: string[] }} settings
 * @param {{ projectId?: string | null }} thread
 * @param {string | undefined | null} prev
 * @param {string | undefined | null} next
 * @param {boolean} focused
 * @param {(id: string) => boolean} [projectExists]
 * @returns {{ notify: boolean, sound: boolean }}
 */
function threadAlerts(settings, thread, prev, next, focused, projectExists) {
  if (!shouldNotifyForProject(settings, thread.projectId, projectExists)) {
    return { notify: false, sound: false };
  }
  return {
    notify: settings.notifications !== false && shouldNotify(prev, next, focused),
    sound: shouldPlayAlert(settings, focused),
  };
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
 * The one POST. Never throws: the outcome comes back as a value so the
 * run path can ignore it and "Send test" (issue #167) can show it.
 *
 * @param {string} url
 * @param {ReturnType<typeof buildWebhookPayload>} payload
 * @param {{
 *   fetchImpl?: (input: string, init?: object) => Promise<unknown>,
 *   timeoutMs?: number,
 *   recordSecretUse?: (evt: { purpose: string, key: string }) => void,
 * }} [opts]
 * @returns {Promise<{ ok: boolean, status?: number, error?: string }>}
 */
async function postWebhook(url, payload, opts = {}) {
  if (typeof opts.recordSecretUse === "function") {
    try {
      opts.recordSecretUse({ purpose: "webhook-post", key: "webhook:url" });
    } catch {
      // audit must never block the post
    }
  }
  const doFetch = opts.fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") {
    return { ok: false, error: "fetch is unavailable" };
  }
  const request = shapeWebhookRequest(url, payload);
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
  try {
    const res = /** @type {{ ok?: unknown, status?: unknown } | null} */ (
      await doFetch(url, init)
    );
    const status =
      res && typeof res.status === "number" ? res.status : undefined;
    const ok =
      res && typeof res.ok === "boolean"
        ? res.ok
        : status == null || (status >= 200 && status < 300);
    if (ok) return status == null ? { ok: true } : { ok: true, status };
    return { ok: false, status, error: `HTTP ${status ?? "error"}` };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? String(err.message) : String(err),
    };
  }
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
  if (!shouldPostWebhook(opts)) return;
  const url = opts.webhook && opts.webhook.url;
  if (!url) return;
  const event = notifyEvent(opts.nextStatus);
  const result = await postWebhook(
    url,
    buildWebhookPayload(opts.thread, event),
    opts,
  );
  if (!result.ok && typeof opts.log === "function") {
    try {
      opts.log(new Error(result.error || "webhook POST failed"));
    } catch {
      // never throw
    }
  }
}

/**
 * "Send test" in Settings: POST a synthetic done payload to the saved URL
 * and report what came back. Deliberately ignores mute, snooze and the
 * per-event toggles — the user asked for this one, right now.
 *
 * @param {{
 *   webhook?: { url?: string | null } | null,
 *   fetchImpl?: (input: string, init?: object) => Promise<unknown>,
 *   timeoutMs?: number,
 *   recordSecretUse?: (evt: { purpose: string, key: string }) => void,
 * }} opts
 * @returns {Promise<{ ok: boolean, status?: number, error?: string }>}
 */
async function testWebhook(opts) {
  const url = opts && opts.webhook && opts.webhook.url;
  if (!isHttpUrl(url)) {
    return { ok: false, error: "Save an http(s) webhook URL first" };
  }
  const payload = buildWebhookPayload(
    { id: "webhook-test", title: "Solenta test" },
    "done",
  );
  return postWebhook(url, payload, opts);
}

module.exports = {
  shouldNotify,
  isNotifyTransition,
  isEffectivelySnoozed,
  needsUser,
  notificationOptions,
  shouldPlayAlert,
  NOTIFY_EVENT_DEFAULTS,
  notifyEventKey,
  notifyEventEnabled,
  ciFailedNotification,
  shouldNotifyForProject,
  threadAlerts,
  notifyEvent,
  notifyBody,
  shouldPostWebhook,
  buildWebhookPayload,
  shapeWebhookRequest,
  postWebhook,
  dispatchWebhook,
  testWebhook,
};
