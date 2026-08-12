/**
 * Direct fakeCoder.threads.fork honesty (round 49 rework B2).
 * UI wiring never hits the unknown-source branch; without this, gutting the
 * rejection still leaves the suite green.
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createFakeCoder,
  project,
  thread,
  detail,
} from "./support/fakeCoder.ts";

describe("fakeCoder.threads.fork honesty", () => {
  it("rejects unknown source with the production error string (byte-equal)", async () => {
    const fake = createFakeCoder({
      projects: [project()],
      threads: [thread({ id: "t-exists", title: "exists" })],
      details: {
        "t-exists": detail({
          thread: thread({ id: "t-exists", title: "exists" }),
        }),
      },
    });

    await assert.rejects(
      () => fake.api.threads.fork({ threadId: "nope" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        // Production: `throw new Error(\`Unknown thread: ${sourceId}\`)`
        assert.equal(err.message, "Unknown thread: nope");
        return true;
      },
    );
    // Still recorded so channel-level assertions stay usable.
    assert.equal(fake.of("threads.fork").length, 1);
  });

  it("valid fork resolves with handoffFrom and truncates title; reasoningEffort null", async () => {
    const long = "L".repeat(80);
    const source = thread({
      id: "t-src",
      title: long,
      provider: "claude",
      model: "m1",
      permissionMode: "acceptEdits",
      reasoningEffort: "high",
      sessionId: "sess-keep",
    });
    const fake = createFakeCoder({
      projects: [project()],
      threads: [source],
      details: { "t-src": detail({ thread: source }) },
    });

    const forked = await fake.api.threads.fork({ threadId: "t-src" });
    assert.notEqual(forked.id, "t-src");
    assert.equal(forked.handoffFrom, "t-src");
    assert.equal(forked.sessionId, null);
    assert.equal(forked.provider, "claude");
    assert.equal(forked.model, "m1");
    assert.equal(forked.permissionMode, "acceptEdits");
    // Production fork leaves reasoningEffort null (createThread default).
    assert.equal(forked.reasoningEffort, null);
    // THREAD_TITLE_MAX = 60; "Fork: " + long source is truncated.
    assert.equal(forked.title.length, 60);
    assert.ok(forked.title.startsWith("Fork: "));
    // Source never modified.
    const still = (await fake.api.threads.list()).find((t) => t.id === "t-src");
    assert.ok(still);
    assert.equal(still!.sessionId, "sess-keep");
    assert.equal(still!.title, long);
  });
});
