/**
 * electron/failuremodes.js: normalized-signature clustering (issue #280).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  clusterFailureModes,
  STALL_AFTER_MS,
} = require("../failuremodes.js");

const NOW = 1_700_000_000_000;

function thread(over) {
  return {
    projectId: "p1",
    title: over.title ?? over.id,
    status: "failed",
    provider: "claude",
    createdAt: NOW,
    updatedAt: NOW,
    runStartedAt: null,
    archived: false,
    ...over,
  };
}

function event(text, at, extra) {
  return { role: "event", text, createdAt: at, ...extra };
}

function cluster(over) {
  return clusterFailureModes({
    threads: [],
    messagesByThread: {},
    workLogByThread: {},
    nowMs: NOW,
    ...over,
  });
}

describe("clusterFailureModes", () => {
  it("clusters the same error with different paths/ids/pids into one mode", () => {
    const modes = cluster({
      threads: [
        thread({ id: "a", title: "Spawn A", provider: "claude" }),
        thread({ id: "b", title: "Spawn B", provider: "codex", projectId: "p2" }),
        thread({ id: "c", title: "Spawn C", provider: "kimi" }),
      ],
      messagesByThread: {
        a: [
          event(
            "Run error: spawn /usr/local/bin/claude ENOENT (pid 18421)",
            NOW - 300,
          ),
        ],
        b: [
          event(
            "Run error: spawn /opt/homebrew/bin/claude ENOENT (pid 22004)",
            NOW - 200,
          ),
        ],
        c: [
          event(
            "Run error: spawn /Users/willem/.local/bin/claude ENOENT (pid 991)",
            NOW - 100,
          ),
        ],
      },
    });
    assert.equal(modes.length, 1);
    assert.equal(modes[0].count, 3);
    assert.equal(modes[0].offenders.length, 3);
    assert.match(modes[0].signature, /ENOENT/);
    assert.doesNotMatch(modes[0].signature, /usr|homebrew|willem|18421|22004/);
    assert.equal(modes[0].sample.includes("/usr/local/bin/claude"), true);
    assert.deepEqual(
      modes[0].offenders.map((o) => o.threadId),
      ["c", "b", "a"],
    );
    assert.equal(modes[0].offenders[0].kind, "failed");
    assert.equal(modes[0].offenders[0].provider, "kimi");
    assert.equal(modes[0].offenders[1].projectId, "p2");
    assert.equal(modes[0].lastAt, NOW - 100);
    assert.equal(typeof modes[0].id, "string");
    assert.equal(modes[0].id.length, 12);
    assert.equal(modes[0].id, cluster({
      threads: [
        thread({ id: "a" }),
        thread({ id: "b" }),
        thread({ id: "c" }),
      ],
      messagesByThread: {
        a: [event("Run error: spawn /tmp/x/claude ENOENT (pid 1)", NOW)],
        b: [event("Run error: spawn /tmp/y/claude ENOENT (pid 2)", NOW)],
        c: [event("Run error: spawn /tmp/z/claude ENOENT (pid 3)", NOW)],
      },
    })[0].id);
  });

  it("excludes a one-off failure (count < 2)", () => {
    const modes = cluster({
      threads: [
        thread({ id: "solo" }),
        thread({ id: "pair1" }),
        thread({ id: "pair2" }),
      ],
      messagesByThread: {
        solo: [event("Run error: unique snowflake crash", NOW)],
        pair1: [event("Run error: Daily budget of $20 reached", NOW - 10)],
        pair2: [event("Run error: Daily budget of $50 reached", NOW)],
      },
    });
    assert.equal(modes.length, 1);
    assert.match(modes[0].signature, /Daily budget/);
    assert.match(modes[0].signature, /<n>/);
    assert.equal(modes[0].count, 2);
    assert.equal(
      modes.some((m) => /snowflake/.test(m.signature)),
      false,
    );
  });

  it("discards an over-normalized signature instead of forming a giant bucket", () => {
    const modes = cluster({
      threads: [
        thread({ id: "n1" }),
        thread({ id: "n2" }),
        thread({ id: "n3" }),
        thread({ id: "keep1" }),
        thread({ id: "keep2" }),
      ],
      messagesByThread: {
        n1: [event("/tmp/alpha/job 18421", NOW)],
        n2: [event("/var/beta/job 22004", NOW - 1)],
        n3: [event("   `only quoted`   99   ", NOW - 2)],
        keep1: [event("Run error: spawn claude ENOENT", NOW)],
        keep2: [event("Run error: spawn claude ENOENT", NOW - 1)],
      },
    });
    assert.equal(modes.length, 1);
    assert.match(modes[0].signature, /ENOENT/);
    assert.equal(modes[0].count, 2);
  });

  it("detects a stalled working thread with an old runStartedAt", () => {
    const modes = cluster({
      threads: [
        thread({
          id: "s1",
          title: "Hung A",
          status: "working",
          runStartedAt: NOW - STALL_AFTER_MS - 5_000,
        }),
        thread({
          id: "s2",
          title: "Hung B",
          status: "working",
          runStartedAt: NOW - STALL_AFTER_MS * 2,
        }),
        thread({
          id: "fresh",
          status: "working",
          runStartedAt: NOW - 60_000,
        }),
      ],
      messagesByThread: {},
    });
    assert.equal(modes.length, 1);
    assert.equal(modes[0].count, 2);
    assert.equal(
      modes[0].offenders.every((o) => o.kind === "stalled"),
      true,
    );
    assert.match(modes[0].signature, /stalled: working/);
    assert.deepEqual(
      modes[0].offenders.map((o) => o.threadId).sort(),
      ["s1", "s2"],
    );
  });

  it("detects awaitingInput sitting unanswered as stalled", () => {
    const modes = cluster({
      threads: [
        thread({
          id: "w1",
          status: "working",
          awaitingInput: true,
          runStartedAt: NOW - STALL_AFTER_MS - 1,
          updatedAt: NOW - STALL_AFTER_MS - 1,
        }),
        thread({
          id: "w2",
          status: "working",
          awaitingInput: true,
          runStartedAt: NOW - STALL_AFTER_MS * 3,
          updatedAt: NOW - STALL_AFTER_MS * 3,
        }),
      ],
    });
    assert.equal(modes.length, 1);
    assert.equal(modes[0].offenders[0].kind, "stalled");
    assert.match(modes[0].signature, /awaiting input/);
  });

  it("a thread that failed the same way twice contributes a retried occurrence", () => {
    const modes = cluster({
      threads: [
        thread({ id: "repeat", title: "Flaky" }),
      ],
      messagesByThread: {
        repeat: [
          event("Run error: spawn /tmp/a/claude ENOENT", NOW - 200),
          event("Run error: spawn /tmp/b/claude ENOENT", NOW - 50),
        ],
      },
    });
    assert.equal(modes.length, 1);
    assert.equal(modes[0].count, 2);
    assert.equal(modes[0].offenders.length, 2);
    assert.equal(modes[0].offenders[0].kind, "retried");
    assert.equal(modes[0].offenders[0].at, NOW - 50);
    assert.equal(modes[0].offenders[1].kind, "failed");
    assert.equal(modes[0].offenders[1].at, NOW - 200);
  });

  it("ranks by count then recency with a stable signature tiebreak", () => {
    const input = {
      threads: [
        thread({ id: "a1" }),
        thread({ id: "a2" }),
        thread({ id: "a3" }),
        thread({ id: "b1" }),
        thread({ id: "b2" }),
        thread({ id: "c1" }),
        thread({ id: "c2" }),
      ],
      messagesByThread: {
        a1: [event("Run error: alpha boom", NOW - 900)],
        a2: [event("Run error: alpha boom", NOW - 800)],
        a3: [event("Run error: alpha boom", NOW - 700)],
        b1: [event("Run error: zeta late", NOW - 10)],
        b2: [event("Run error: zeta late", NOW)],
        c1: [event("Run error: beta mid", NOW - 10)],
        c2: [event("Run error: beta mid", NOW)],
      },
    };
    const first = cluster(input);
    const second = cluster(input);
    assert.deepEqual(
      first.map((m) => m.signature),
      second.map((m) => m.signature),
    );
    assert.equal(first.length, 3);
    assert.equal(first[0].count, 3);
    assert.match(first[0].signature, /alpha/);
    assert.equal(first[1].count, 2);
    assert.equal(first[2].count, 2);
    assert.ok(first[1].lastAt === first[2].lastAt);
    assert.ok(first[1].signature < first[2].signature);
    assert.match(first[1].signature, /beta/);
    assert.match(first[2].signature, /zeta/);
  });

  it("returns without throwing on corrupt input", () => {
    let modes;
    assert.doesNotThrow(() => {
      modes = clusterFailureModes({
        threads: [
          null,
          undefined,
          "nope",
          { title: "no id", status: "failed" },
          thread({ id: "x", projectId: undefined, updatedAt: undefined }),
          thread({ id: "y" }),
        ],
        messagesByThread: { x: null, y: "not-an-array" },
        workLogByThread: undefined,
        nowMs: "later",
      });
    });
    assert.ok(Array.isArray(modes));
    assert.doesNotThrow(() => {
      assert.deepEqual(clusterFailureModes(null), []);
      assert.deepEqual(clusterFailureModes(undefined), []);
      assert.deepEqual(clusterFailureModes({}), []);
    });
  });

  it("caps offenders at 20 while count keeps the true total", () => {
    const threads = [];
    const messagesByThread = {};
    for (let i = 0; i < 25; i++) {
      const id = `t${String(i).padStart(2, "0")}`;
      threads.push(thread({ id, title: `T${i}` }));
      messagesByThread[id] = [
        event("Run error: spawn claude ENOENT", NOW + i),
      ];
    }
    const modes = cluster({ threads, messagesByThread });
    assert.equal(modes.length, 1);
    assert.equal(modes[0].count, 25);
    assert.equal(modes[0].offenders.length, 20);
    assert.equal(modes[0].offenders[0].threadId, "t24");
    assert.equal(modes[0].offenders[19].threadId, "t05");
    assert.equal(modes[0].lastAt, NOW + 24);
  });

  it("keeps HTTP status codes and unwraps the runner exit wrapper", () => {
    const modes = cluster({
      threads: [thread({ id: "h1" }), thread({ id: "h2" })],
      messagesByThread: {
        h1: [
          event("Run error (exit 1):\nHTTP 404 from https://api.example.com/v1", NOW),
        ],
        h2: [
          event("Run error (exit 127):\nHTTP 404 from https://other.test/v2", NOW - 1),
        ],
      },
    });
    assert.equal(modes.length, 1);
    assert.match(modes[0].signature, /404/);
    assert.doesNotMatch(modes[0].signature, /example\.com|other\.test/);
  });
});
