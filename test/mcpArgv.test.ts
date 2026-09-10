/**
 * Local MCP argument field: quoted argv and JSON string arrays.
 * Run: npm run test:renderer -- test/mcpArgv.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseMcpArgv } from "../src/parseMcpArgv.ts";

describe("parseMcpArgv", () => {
  it("keeps a spaced path and a spaced value as single elements", () => {
    assert.deepEqual(
      parseMcpArgv('"/tmp/My Tools/server.mjs" --label "hello world"'),
      {
        ok: true,
        args: ["/tmp/My Tools/server.mjs", "--label", "hello world"],
      },
    );
  });

  it("round-trips quotes, backslashes, Unicode, and empty values", () => {
    assert.deepEqual(
      parseMcpArgv(`'say "hi"' "back\\\\slash" "" "café 字"`),
      {
        ok: true,
        args: ['say "hi"', "back\\slash", "", "café 字"],
      },
    );
  });

  it("accepts a JSON string array", () => {
    assert.deepEqual(
      parseMcpArgv('["/tmp/My Tools/server.mjs", "--label", "hello world", ""]'),
      {
        ok: true,
        args: ["/tmp/My Tools/server.mjs", "--label", "hello world", ""],
      },
    );
  });

  it("rejects unclosed quotes without inventing tokens", () => {
    const out = parseMcpArgv('"/tmp/My Tools/server.mjs');
    assert.equal(out.ok, false);
    if (out.ok) throw new Error("expected failure");
    assert.match(out.error, /quot/i);
  });

  it("rejects a trailing backslash", () => {
    const out = parseMcpArgv("ok \\");
    assert.equal(out.ok, false);
    if (out.ok) throw new Error("expected failure");
    assert.match(out.error, /backslash|escape/i);
  });

  it("does not expand $, *, or backticks", () => {
    assert.deepEqual(parseMcpArgv("$HOME *.js `whoami`"), {
      ok: true,
      args: ["$HOME", "*.js", "`whoami`"],
    });
  });

  it("treats a bracket token that is not a JSON string array as argv", () => {
    assert.deepEqual(parseMcpArgv("[debug]"), {
      ok: true,
      args: ["[debug]"],
    });
  });
});
