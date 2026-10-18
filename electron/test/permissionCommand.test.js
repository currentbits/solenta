/**
 * Edit-before-approve helpers (#509): command field extract/apply, prefix
 * glob for allow-always (#479), session addRules shape.
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
  WHOLE_TOOL_RULE,
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

  const addRules = (rule) => ({
    type: "addRules",
    rules: [rule],
    behavior: "allow",
    destination: "session",
  });

  it("sessionAllowRule keys allow-always on the command prefix, never whole-tool (#479)", () => {
    // Accept all on `npm test -- foo` must not become a blank cheque for `rm`.
    const rule = sessionAllowRule("Bash", "npm test -- foo");
    assert.deepEqual(rule, addRules({ toolName: "Bash", ruleContent: "npm test:*" }));
    assert.deepEqual(
      sessionAllowRule("Bash", "npm build"),
      addRules({ toolName: "Bash", ruleContent: "npm build:*" }),
    );
  });

  it("sessionAllowRule honours a typed rule; '*' is the explicit whole tool", () => {
    assert.deepEqual(
      sessionAllowRule("Bash", "npm test -- foo", "  npm run test:*  "),
      addRules({ toolName: "Bash", ruleContent: "npm run test:*" }),
    );
    // Blank typed rule falls back to the derived prefix, not whole-tool.
    assert.deepEqual(
      sessionAllowRule("Bash", "git status", "   "),
      addRules({ toolName: "Bash", ruleContent: "git status:*" }),
    );
    assert.deepEqual(
      sessionAllowRule("Bash", "npm test", WHOLE_TOOL_RULE),
      addRules({ toolName: "Bash" }),
    );
  });

  it("sessionAllowRule stays whole-tool for tools without a command", () => {
    assert.deepEqual(sessionAllowRule("Edit", null), addRules({ toolName: "Edit" }));
    assert.deepEqual(sessionAllowRule("Edit", null, "src/*"), addRules({ toolName: "Edit" }));
  });
});
