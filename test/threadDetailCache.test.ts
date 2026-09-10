/**
 * In-memory ThreadDetail LRU (#1225). Count + byte budget; no disk.
 * Run: node --experimental-strip-types --test test/threadDetailCache.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatMessage, ThreadDetail } from "../src/shared/ipc.ts";
import {
  createThreadDetailCache,
  estimateThreadDetailBytes,
} from "../src/threadDetailCache.ts";

function msg(text: string, id = "m"): ChatMessage {
  return { id, role: "assistant", text, createdAt: 1 };
}

function d(
  id: string,
  text: string,
  extra?: { projectId?: string; messages?: ChatMessage[] },
): ThreadDetail {
  return {
    thread: { id, projectId: extra?.projectId ?? "p1" } as ThreadDetail["thread"],
    messages: extra?.messages ?? [msg(text)],
    workLog: [],
    workflow: null,
    usage: null,
  };
}

describe("estimateThreadDetailBytes", () => {
  it("grows with message text and tool payloads", () => {
    const small = d("t", "hi");
    const large = d("t", "h".repeat(10_000));
    assert.ok(estimateThreadDetailBytes(large) > estimateThreadDetailBytes(small));
    const withTool: ThreadDetail = {
      ...small,
      messages: [
        {
          ...msg("x"),
          tool: {
            id: "tool-1",
            name: "Bash",
            input: "y".repeat(5_000),
            output: "z".repeat(5_000),
            isError: false,
            done: true,
          },
        },
      ],
    };
    assert.ok(estimateThreadDetailBytes(withTool) > estimateThreadDetailBytes(small) + 9_000);
  });
});

describe("ThreadDetailCache", () => {
  it("returns the same object that was set", () => {
    const cache = createThreadDetailCache();
    const detail = d("a", "hello");
    assert.equal(cache.set("a", detail), true);
    assert.equal(cache.get("a"), detail);
  });

  it("evicts the least recently used entry when over the count cap", () => {
    const cache = createThreadDetailCache({ maxEntries: 2, maxBytes: 50_000 });
    cache.set("a", d("a", "one"));
    cache.set("b", d("b", "two"));
    cache.set("c", d("c", "three"));
    assert.equal(cache.get("a"), undefined);
    assert.ok(cache.get("b"));
    assert.ok(cache.get("c"));
    assert.equal(cache.size, 2);
  });

  it("treats get as a recency touch so a reread entry survives the next insert", () => {
    const cache = createThreadDetailCache({ maxEntries: 2, maxBytes: 50_000 });
    cache.set("a", d("a", "one"));
    cache.set("b", d("b", "two"));
    assert.ok(cache.get("a"));
    cache.set("c", d("c", "three"));
    assert.equal(cache.get("b"), undefined);
    assert.ok(cache.get("a"));
    assert.ok(cache.get("c"));
  });

  it("evicts older entries to stay within the byte budget", () => {
    const chunk = d("x", "n".repeat(1_000));
    const chunkBytes = estimateThreadDetailBytes(chunk);
    const cache = createThreadDetailCache({
      maxEntries: 8,
      maxBytes: chunkBytes * 2 + 50,
    });
    cache.set("a", d("a", "n".repeat(1_000)));
    cache.set("b", d("b", "n".repeat(1_000)));
    cache.set("c", d("c", "n".repeat(1_000)));
    assert.equal(cache.get("a"), undefined);
    assert.ok(cache.get("b"));
    assert.ok(cache.get("c"));
    assert.ok(cache.bytes <= chunkBytes * 2 + 50);
  });

  it("does not admit a single detail larger than the byte budget", () => {
    const cache = createThreadDetailCache({ maxEntries: 8, maxBytes: 500 });
    const huge = d("huge", "x".repeat(5_000));
    assert.equal(cache.set("huge", huge), false);
    assert.equal(cache.get("huge"), undefined);
    assert.equal(cache.size, 0);
    assert.equal(cache.bytes, 0);
  });

  it("drops a previously cached detail when a replacement exceeds the budget", () => {
    const cache = createThreadDetailCache({ maxEntries: 8, maxBytes: 500 });
    const small = d("t", "ok");
    assert.equal(cache.set("t", small), true);
    assert.equal(cache.set("t", d("t", "x".repeat(5_000))), false);
    assert.equal(cache.get("t"), undefined);
    assert.equal(cache.size, 0);
    assert.equal(cache.bytes, 0);
  });

  it("recomputes retained bytes when a cached detail is replaced", () => {
    const cache = createThreadDetailCache({ maxEntries: 8, maxBytes: 50_000 });
    cache.set("t", d("t", "abc"));
    const grown = d("t", "n".repeat(2_000));
    cache.set("t", grown);
    assert.equal(cache.bytes, estimateThreadDetailBytes(grown));
    assert.equal(cache.size, 1);
    const shrunk = d("t", "z");
    cache.set("t", shrunk);
    assert.equal(cache.bytes, estimateThreadDetailBytes(shrunk));
  });

  it("evicts siblings when a streamed replacement grows past the remaining budget", () => {
    const cache = createThreadDetailCache({ maxEntries: 8, maxBytes: 2_500 });
    cache.set("a", d("a", "n".repeat(1_000)));
    cache.set("b", d("b", "n".repeat(1_000)));
    assert.equal(cache.size, 2);
    cache.set("b", d("b", "n".repeat(2_000)));
    assert.equal(cache.get("a"), undefined);
    assert.ok(cache.get("b"));
    assert.equal(cache.size, 1);
  });

  it("retain drops entries whose threads are no longer in the authoritative list", () => {
    const cache = createThreadDetailCache();
    cache.set("a", d("a", "one"));
    cache.set("b", d("b", "two"));
    cache.retain(new Set(["b"]));
    assert.equal(cache.get("a"), undefined);
    assert.ok(cache.get("b"));
    assert.equal(cache.size, 1);
  });

  it("dropProject removes every cached detail for that project", () => {
    const cache = createThreadDetailCache();
    cache.set("a", d("a", "one", { projectId: "p1" }));
    cache.set("b", d("b", "two", { projectId: "p2" }));
    cache.dropProject("p1");
    assert.equal(cache.get("a"), undefined);
    assert.ok(cache.get("b"));
  });
});
