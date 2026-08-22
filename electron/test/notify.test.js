const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  shouldNotify,
  isEffectivelySnoozed,
  isNotifyTransition,
  shouldPostWebhook,
  buildWebhookPayload,
  shapeWebhookRequest,
  dispatchWebhook,
} = require("../notify.js");

describe("shouldNotify", () => {
  it("notifies working -> done when the window is not focused", () => {
    assert.equal(shouldNotify("working", "done", false), true);
  });

  it("notifies working -> failed when the window is not focused", () => {
    assert.equal(shouldNotify("working", "failed", false), true);
  });

  it("never notifies while the window is focused", () => {
    assert.equal(shouldNotify("working", "done", true), false);
    assert.equal(shouldNotify("working", "failed", true), false);
  });

  it("notifies working -> waiting: a run blocked on a prompt is a stall", () => {
    assert.equal(shouldNotify("working", "waiting", false), true);
    assert.equal(shouldNotify("working", "waiting", true), false);
    // One prompt, one notification.
    assert.equal(shouldNotify("waiting", "waiting", false), false);
  });

  it("still notifies once the answered run settles", () => {
    assert.equal(shouldNotify("waiting", "working", false), false);
    assert.equal(shouldNotify("waiting", "done", false), true);
    assert.equal(shouldNotify("waiting", "failed", false), true);
  });

  it("notifies a background failure with no live run (issue #34)", () => {
    // Budget-gated orchestrator wake-up: the thread was idle/done, not working.
    assert.equal(shouldNotify("done", "failed", false), true);
    assert.equal(shouldNotify("idle", "failed", false), true);
    assert.equal(shouldNotify("done", "failed", true), false);
    // One failure, one notification.
    assert.equal(shouldNotify("failed", "failed", false), false);
  });

  it("does not notify other status transitions", () => {
    assert.equal(shouldNotify("working", "working", false), false);
    assert.equal(shouldNotify("working", "idle", false), false);
    assert.equal(shouldNotify("idle", "working", false), false);
    assert.equal(shouldNotify("idle", "done", false), false);
    assert.equal(shouldNotify("done", "done", false), false);
    assert.equal(shouldNotify("failed", "done", false), false);
    assert.equal(shouldNotify(undefined, "done", false), false);
    assert.equal(shouldNotify(null, "failed", false), false);
  });
});

describe("isEffectivelySnoozed", () => {
  const NOW = 1_700_000_000_000;

  it("future until is snoozed; past until is not", () => {
    assert.equal(
      isEffectivelySnoozed(
        { snoozedUntil: NOW + 1000, snoozedAt: NOW - 100, status: "idle", updatedAt: NOW - 200 },
        NOW,
      ),
      true,
    );
    assert.equal(
      isEffectivelySnoozed(
        { snoozedUntil: NOW - 1, snoozedAt: NOW - 1000, status: "idle", updatedAt: NOW - 200 },
        NOW,
      ),
      false,
    );
  });

  it("raised-hand completion or awaitingInput is not snoozed", () => {
    assert.equal(
      isEffectivelySnoozed(
        {
          snoozedUntil: NOW + 10_000,
          snoozedAt: NOW - 5000,
          status: "done",
          updatedAt: NOW - 100,
        },
        NOW,
      ),
      false,
    );
    assert.equal(
      isEffectivelySnoozed(
        {
          snoozedUntil: NOW + 10_000,
          snoozedAt: NOW - 100,
          status: "working",
          updatedAt: NOW - 200,
          awaitingInput: true,
        },
        NOW,
      ),
      false,
    );
  });

  it("null / missing thread is never snoozed", () => {
    assert.equal(isEffectivelySnoozed(null, NOW), false);
    assert.equal(isEffectivelySnoozed({}, NOW), false);
  });
});

describe("isNotifyTransition", () => {
  it("is the focus-free twin of shouldNotify", () => {
    assert.equal(isNotifyTransition("working", "done"), true);
    assert.equal(isNotifyTransition("working", "failed"), true);
    assert.equal(isNotifyTransition("working", "waiting"), true);
    assert.equal(isNotifyTransition("waiting", "done"), true);
    assert.equal(isNotifyTransition("done", "failed"), true);
    assert.equal(isNotifyTransition("working", "working"), false);
    assert.equal(isNotifyTransition("idle", "working"), false);
    assert.equal(isNotifyTransition(undefined, "done"), false);
  });
});

const WEBHOOK_ON = {
  url: "https://example.com/hook",
  onDone: true,
  onFailed: true,
  onWaiting: true,
};

describe("shouldPostWebhook", () => {
  it("posts on the same transitions as desktop notify, including while focused", () => {
    assert.equal(
      shouldPostWebhook({
        prevStatus: "working",
        nextStatus: "done",
        webhook: WEBHOOK_ON,
      }),
      true,
    );
    assert.equal(
      shouldPostWebhook({
        prevStatus: "working",
        nextStatus: "waiting",
        webhook: WEBHOOK_ON,
      }),
      true,
    );
    assert.equal(
      shouldPostWebhook({
        prevStatus: "idle",
        nextStatus: "failed",
        webhook: WEBHOOK_ON,
      }),
      true,
    );
  });

  it("does nothing without an http(s) URL", () => {
    assert.equal(
      shouldPostWebhook({
        prevStatus: "working",
        nextStatus: "done",
        webhook: { ...WEBHOOK_ON, url: null },
      }),
      false,
    );
    assert.equal(
      shouldPostWebhook({
        prevStatus: "working",
        nextStatus: "done",
        webhook: { ...WEBHOOK_ON, url: "ftp://example.com/hook" },
      }),
      false,
    );
    assert.equal(
      shouldPostWebhook({
        prevStatus: "working",
        nextStatus: "done",
        webhook: null,
      }),
      false,
    );
  });

  it("honors per-event toggles, mute, and snooze", () => {
    assert.equal(
      shouldPostWebhook({
        prevStatus: "working",
        nextStatus: "done",
        webhook: { ...WEBHOOK_ON, onDone: false },
      }),
      false,
    );
    assert.equal(
      shouldPostWebhook({
        prevStatus: "working",
        nextStatus: "failed",
        webhook: { ...WEBHOOK_ON, onFailed: false },
      }),
      false,
    );
    assert.equal(
      shouldPostWebhook({
        prevStatus: "working",
        nextStatus: "waiting",
        webhook: { ...WEBHOOK_ON, onWaiting: false },
      }),
      false,
    );
    assert.equal(
      shouldPostWebhook({
        prevStatus: "working",
        nextStatus: "done",
        webhook: WEBHOOK_ON,
        muted: true,
      }),
      false,
    );
    assert.equal(
      shouldPostWebhook({
        prevStatus: "working",
        nextStatus: "done",
        webhook: WEBHOOK_ON,
        snoozed: true,
      }),
      false,
    );
  });
});

describe("buildWebhookPayload / shapeWebhookRequest", () => {
  const thread = { id: "t1", projectId: "p1", title: "Ship it", status: "done" };

  it("builds a small JSON payload Slack and Discord both accept", () => {
    const payload = buildWebhookPayload(thread, "done");
    assert.equal(payload.event, "done");
    assert.equal(payload.threadId, "t1");
    assert.equal(payload.projectId, "p1");
    assert.equal(payload.title, "Ship it");
    assert.equal(payload.status, "done");
    assert.equal(payload.text, "Ship it: done");
    assert.equal(payload.content, payload.text);
    assert.equal(payload.message, payload.text);
  });

  it("uses waiting/failed copy matching the desktop notification body", () => {
    assert.equal(
      buildWebhookPayload(thread, "waiting").text,
      "Ship it: needs permission",
    );
    assert.equal(buildWebhookPayload(thread, "failed").text, "Ship it: failed");
    assert.equal(buildWebhookPayload({ id: "x" }, "done").title, "Thread");
  });

  it("shapes ntfy as text/plain with a Title header; everyone else as JSON", () => {
    const payload = buildWebhookPayload(thread, "done");
    const generic = shapeWebhookRequest("https://example.com/hook", payload);
    assert.equal(generic.headers["Content-Type"], "application/json");
    assert.equal(JSON.parse(generic.body).text, "Ship it: done");

    const slack = shapeWebhookRequest(
      "https://hooks.slack.com/services/T/B/X",
      payload,
    );
    assert.equal(slack.headers["Content-Type"], "application/json");
    assert.equal(JSON.parse(slack.body).text, "Ship it: done");

    const discord = shapeWebhookRequest(
      "https://discord.com/api/webhooks/1/token",
      payload,
    );
    assert.equal(JSON.parse(discord.body).content, "Ship it: done");

    const ntfy = shapeWebhookRequest("https://ntfy.sh/solenta", payload);
    assert.match(ntfy.headers["Content-Type"], /text\/plain/);
    assert.equal(ntfy.headers.Title, "Ship it");
    assert.equal(ntfy.body, "Ship it: done");
  });
});

describe("dispatchWebhook", () => {
  it("POSTs once on a notify-worthy transition and swallows fetch errors", async () => {
    /** @type {{ url: string, init: RequestInit }[]} */
    const calls = [];
    await dispatchWebhook({
      thread: { id: "t1", title: "Ship it" },
      prevStatus: "working",
      nextStatus: "done",
      webhook: WEBHOOK_ON,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        throw new Error("down");
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, WEBHOOK_ON.url);
    assert.equal(calls[0].init.method, "POST");
    assert.equal(JSON.parse(String(calls[0].init.body)).event, "done");
  });

  it("does not POST when the URL is empty or the event is toggled off", async () => {
    let n = 0;
    const fetchImpl = async () => {
      n += 1;
      return { ok: true, status: 200 };
    };
    await dispatchWebhook({
      thread: { id: "t1" },
      prevStatus: "working",
      nextStatus: "done",
      webhook: { ...WEBHOOK_ON, url: null },
      fetchImpl,
    });
    await dispatchWebhook({
      thread: { id: "t1" },
      prevStatus: "working",
      nextStatus: "done",
      webhook: { ...WEBHOOK_ON, onDone: false },
      fetchImpl,
    });
    assert.equal(n, 0);
  });
});
