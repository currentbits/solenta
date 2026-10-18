/**
 * src/permissionRule.ts vs electron/permissionCommand.js must not drift:
 * the button shows the rule the main process would derive (#479).
 * Run: node --experimental-strip-types --test test/permissionRuleParity.test.ts
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { it } from "node:test";
import * as shared from "../src/permissionRule.ts";

const require = createRequire(import.meta.url);
const electron = require("../electron/permissionCommand.js") as typeof shared;

it("commandPrefix and WHOLE_TOOL_RULE match the main process", () => {
  assert.equal(shared.WHOLE_TOOL_RULE, electron.WHOLE_TOOL_RULE);
  for (const cmd of [
    "npm test -- foo",
    "FOO=1 BAR=x npm test",
    "git commit -m msg",
    "/usr/bin/git status",
    "cargo --offline test",
    "make",
    "rm -rf dist && npm build",
    "  ",
    "",
    null,
  ]) {
    assert.equal(shared.commandPrefix(cmd), electron.commandPrefix(cmd), String(cmd));
  }
});
