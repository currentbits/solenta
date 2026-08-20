/**
 * Edit-before-approve helpers (#509): command field extract/apply, prefix
 * glob for allow-always-after-edit, session addRules shape.
 *
 * Run: node --test electron/test/permissionCommand.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  commandField,
  extractCommand,
  applyCommand,
  resolveEditedCommand,
  commandPrefix,
  sessionAllowRule,
} = require("../permissionCommand.js");

describe("permissionCommand", () => {
  it("extracts command/cmd/script, ignoring other tools", () => {
    assert.equal(commandField({ command: "npm test" }), "command");
    assert.equal(extractCommand({ command: "npm test" }), "npm test");
    assert.equal(extractCommand({ cmd: "ls" }), "ls");
    assert.equal(extractCommand({ script: "echo hi" }), "echo hi");
    assert.equal(extractCommand({ file_path: "a.ts" }), null);
    assert.equal(extractCommand({ command: "" }), "");
    assert.equal(extractCommand(null), null);
    assert.equal(extractCommand("npm test"), null);
  });

  it("applyCommand writes back to the same key and preserves siblings", () => {
    assert.deepEqual(
      applyCommand({ command: "old", timeout: 30 }, "new"),
      { command: "new", timeout: 30 },
    );
    assert.deepEqual(applyCommand({ cmd: "ls" }, "pwd"), { cmd: "pwd" });
    assert.deepEqual(
      applyCommand({ file_path: "a.ts" }, "rm -rf /"),
      { file_path: "a.ts" },
    );
  });

  it("resolveEditedCommand treats trim-equal as not edited", () => {
    const raw = { command: "npm test", timeout: 10 };
    const same = resolveEditedCommand(raw, "npm test  ");
    assert.equal(same.edited, false);
    assert.equal(same.input, raw);

    const changed = resolveEditedCommand(raw, " npm build ");
    assert.equal(changed.edited, true);
    assert.equal(changed.original, "npm test");
    assert.equal(changed.next, "npm build");
    assert.deepEqual(changed.input, { command: "npm build", timeout: 10 });
  });

  it("resolveEditedCommand ignores updatedCommand on non-command tools", () => {
    const raw = { file_path: "a.ts", old_string: "x" };
    const out = resolveEditedCommand(raw, "rm -rf /");
    assert.equal(out.edited, false);
    assert.equal(out.input, raw);
  });

  it("commandPrefix keys on the verb, not flags or env", () => {
    assert.equal(commandPrefix("npm test -- --grep foo"), "npm test:*");
    assert.equal(commandPrefix("git commit -m msg"), "git commit:*");
    assert.equal(commandPrefix("cargo test --offline"), "cargo test:*");
    assert.equal(commandPrefix("ls -la"), "ls:*");
    assert.equal(commandPrefix("FOO=1 npm test"), "npm test:*");
    assert.equal(
      commandPrefix("/usr/bin/git status"),
      "/usr/bin/git status:*",
    );
    assert.equal(commandPrefix("npm build"), "npm build:*");
    assert.equal(commandPrefix("  "), null);
  });

  it("sessionAllowRule keys edited allow-always on the edited prefix", () => {
    assert.deepEqual(sessionAllowRule("Bash", "npm test", { edited: false }), {
      type: "addRules",
      rules: [{ toolName: "Bash" }],
      behavior: "allow",
      destination: "session",
    });
    assert.deepEqual(
      sessionAllowRule("Bash", "npm build", { edited: true }),
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "npm build:*" }],
        behavior: "allow",
        destination: "session",
      },
    );
  });
});
