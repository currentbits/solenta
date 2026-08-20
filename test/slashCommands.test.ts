/**
 * Pure `/` palette rules (issue #472).
 *
 * Run: node --experimental-strip-types --test test/slashCommands.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SLASH_COMMANDS,
  commandQuery,
  matchSlashCommands,
} from "../src/slashCommands.ts";

describe("commandQuery", () => {
  it("returns the leading token while it is still one word", () => {
    assert.equal(commandQuery("/"), "/");
    assert.equal(commandQuery("/co"), "/co");
    assert.equal(commandQuery("/compact"), "/compact");
  });

  it("closes once a space starts the task", () => {
    assert.equal(commandQuery("/handoff "), null);
    assert.equal(commandQuery("/handoff implement"), null);
  });

  it("ignores a slash that is not at the start", () => {
    assert.equal(commandQuery("see /foo"), null);
    assert.equal(commandQuery(""), null);
    assert.equal(commandQuery(" /model"), null);
  });
});

describe("matchSlashCommands", () => {
  it("lists the CLI verbs and the orchestration trio on a lone /", () => {
    const names = matchSlashCommands("/").map((c) => c.name);
    for (const name of [
      "/compact",
      "/rewind",
      "/review",
      "/undo",
      "/usage",
      "/context",
      "/model",
      "/effort",
      "/permissions",
      "/goal",
      "/fork",
      "/new",
      "/handoff",
      "/advisor",
      "/committee",
      "/btw",
      "/clear",
    ]) {
      assert.ok(names.includes(name), `${name} in the palette`);
    }
  });

  it("filters by prefix: /co hits compact, committee, context", () => {
    const names = matchSlashCommands("/co").map((c) => c.name);
    assert.deepEqual(names, ["/compact", "/context", "/committee"]);
  });

  it("does not invent a match for an unknown /foo", () => {
    assert.deepEqual(matchSlashCommands("/foo"), []);
  });

  it("appends CLI skill commands after the built-in palette", () => {
    const extras = [
      { name: "/imagine", hint: "Generate an image", kind: "insert" as const },
      { name: "/si:review", hint: "Audit auto-memory", kind: "insert" as const },
    ];
    const names = matchSlashCommands("/", extras).map((c) => c.name);
    assert.ok(names.indexOf("/imagine") > names.indexOf("/clear"));
    assert.ok(names.includes("/si:review"));
  });

  it("filters extras by prefix: /im hits /imagine, not /si:review", () => {
    const extras = [
      { name: "/imagine", hint: "Generate an image", kind: "insert" as const },
      { name: "/si:review", hint: "Audit auto-memory", kind: "insert" as const },
    ];
    assert.deepEqual(
      matchSlashCommands("/im", extras).map((c) => c.name),
      ["/imagine"],
    );
  });

  it("skips an extra whose name is already a Solenta verb", () => {
    const extras = [
      { name: "/review", hint: "Grok code-review skill", kind: "insert" as const },
      { name: "/imagine", hint: "Generate an image", kind: "insert" as const },
    ];
    const review = matchSlashCommands("/review", extras);
    assert.equal(review.length, 1);
    assert.equal(review[0].action, "review");
    assert.ok(
      matchSlashCommands("/", extras).some((c) => c.name === "/imagine"),
    );
  });

  it("keeps orchestration verbs insert-only so the runner still sees them", () => {
    for (const name of ["/handoff", "/advisor", "/committee", "/btw", "/goal"]) {
      const cmd = SLASH_COMMANDS.find((c) => c.name === name);
      assert.equal(cmd?.kind, "insert", `${name} inserts`);
    }
  });

  it("treats /undo as the rewind action and /context as usage", () => {
    assert.equal(
      SLASH_COMMANDS.find((c) => c.name === "/undo")?.action,
      "rewind",
    );
    assert.equal(
      SLASH_COMMANDS.find((c) => c.name === "/context")?.action,
      "usage",
    );
  });
});
