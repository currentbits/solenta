"use strict";

/**
 * Cursor plugin that strips foreign Task/Agent models so inherit applies
 * (#686). Drive the materialized hook via stdin, not the exported helper,
 * so the script Cursor actually execs is what we assert.
 *
 * Run: node --test electron/test/cursor-pin-task-parent.test.js
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const {
  PLUGIN_NAME,
  USER_DATA_DIR,
  TMP_DIR_NAME,
  cursorPinPluginDir,
  materializeCursorPinPlugin,
} = require("../cursorPinTaskParent.js");

function runHook(scriptPath, payload) {
  const input = typeof payload === "string" ? payload : JSON.stringify(payload);
  const stdout = execFileSync(process.execPath, [scriptPath], {
    input,
    encoding: "utf8",
  });
  return JSON.parse(stdout);
}

function taskPayload(overrides = {}) {
  const {
    tool_name = "Task",
    model = "gpt-5.6-sol-high-fast",
    model_id = "gpt-5.6-sol",
    tool_input = {
      description: "Implement the change",
      prompt: "Do the work.",
      model: "composer-2.5",
      subagent_type: "generalPurpose",
    },
    ...rest
  } = overrides;
  return {
    hook_event_name: "preToolUse",
    tool_name,
    model,
    model_id,
    tool_input,
    ...rest,
  };
}

describe("cursorPinPluginDir", () => {
  it("uses userDataPath/cursor-pin-parent when set", () => {
    assert.equal(
      cursorPinPluginDir("/tmp/ud"),
      path.resolve("/tmp/ud", USER_DATA_DIR),
    );
  });

  it("falls back to tmpdir when userDataPath is empty", () => {
    assert.equal(
      cursorPinPluginDir(""),
      path.resolve(os.tmpdir(), TMP_DIR_NAME),
    );
    assert.equal(
      cursorPinPluginDir(),
      path.resolve(os.tmpdir(), TMP_DIR_NAME),
    );
  });
});

describe("materializeCursorPinPlugin", () => {
  let dest;

  beforeEach(() => {
    dest = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-pin-"));
  });

  afterEach(() => {
    fs.rmSync(dest, { recursive: true, force: true });
  });

  it("writes plugin.json, hooks.json, and the hook script", () => {
    const out = materializeCursorPinPlugin(dest);
    assert.equal(out, path.resolve(dest));

    const plugin = JSON.parse(
      fs.readFileSync(path.join(dest, ".cursor-plugin", "plugin.json"), "utf8"),
    );
    assert.equal(plugin.name, PLUGIN_NAME);
    assert.equal(plugin.hooks, "./hooks/hooks.json");

    const hooks = JSON.parse(
      fs.readFileSync(path.join(dest, "hooks", "hooks.json"), "utf8"),
    );
    const pre = hooks.hooks.preToolUse;
    assert.equal(pre.length, 1);
    assert.equal(pre[0].matcher, "Task|Agent");
    const scriptPath = path.join(dest, "scripts", "pin-task-parent.js");
    assert.ok(
      pre[0].command.includes(scriptPath),
      `command should exec ${scriptPath}: ${pre[0].command}`,
    );
    assert.ok(pre[0].command.startsWith("node "));
    assert.ok(fs.existsSync(scriptPath));
    assert.match(
      fs.readFileSync(scriptPath, "utf8"),
      /^#!\/usr\/bin\/env node/,
    );
  });
});

describe("pin-task-parent hook (stdin)", () => {
  let dest;
  let scriptPath;

  beforeEach(() => {
    dest = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-pin-hook-"));
    materializeCursorPinPlugin(dest);
    scriptPath = path.join(dest, "scripts", "pin-task-parent.js");
  });

  afterEach(() => {
    fs.rmSync(dest, { recursive: true, force: true });
  });

  it("strips a foreign composer-2.5 model so inherit applies", () => {
    const out = runHook(scriptPath, taskPayload());
    assert.equal(out.permission, "allow");
    assert.ok(out.updated_input);
    assert.equal(out.updated_input.model, undefined);
    assert.equal(out.updated_input.description, "Implement the change");
    assert.equal(out.updated_input.prompt, "Do the work.");
    assert.equal(out.updated_input.subagent_type, "generalPurpose");
  });

  it("leaves a model matching the parent slug alone", () => {
    const out = runHook(
      scriptPath,
      taskPayload({
        tool_input: {
          description: "Stay on Sol",
          prompt: "Do the work.",
          model: "gpt-5.6-sol-high-fast",
          subagent_type: "generalPurpose",
        },
      }),
    );
    assert.deepEqual(out, { permission: "allow" });
  });

  it("treats gpt-5.6-sol as matching parent gpt-5.6-sol-high-fast", () => {
    const out = runHook(
      scriptPath,
      taskPayload({
        model: "gpt-5.6-sol-high-fast",
        model_id: "gpt-5.6-sol",
        tool_input: {
          description: "Stay on Sol",
          prompt: "Do the work.",
          model: "gpt-5.6-sol",
        },
      }),
    );
    assert.deepEqual(out, { permission: "allow" });
  });

  it("leaves inherit alone", () => {
    const out = runHook(
      scriptPath,
      taskPayload({
        tool_input: {
          description: "Inherit",
          prompt: "Do the work.",
          model: "inherit",
        },
      }),
    );
    assert.deepEqual(out, { permission: "allow" });
  });

  it("leaves a missing model alone", () => {
    const out = runHook(
      scriptPath,
      taskPayload({
        tool_input: {
          description: "No model",
          prompt: "Do the work.",
          subagent_type: "generalPurpose",
        },
      }),
    );
    assert.deepEqual(out, { permission: "allow" });
  });

  it("leaves explore with a composer model alone", () => {
    const out = runHook(
      scriptPath,
      taskPayload({
        tool_input: {
          description: "Search",
          prompt: "Find it.",
          model: "composer-2.5",
          subagent_type: "explore",
        },
      }),
    );
    assert.deepEqual(out, { permission: "allow" });
  });

  it("leaves bash/browser/shell subagents alone", () => {
    for (const kind of ["bash", "browser", "shell"]) {
      const out = runHook(
        scriptPath,
        taskPayload({
          tool_input: {
            description: kind,
            prompt: "go",
            model: "composer-2.5",
            subagent_type: kind,
          },
        }),
      );
      assert.deepEqual(out, { permission: "allow" }, kind);
    }
  });

  it("reads camelCase subagentType on the payload", () => {
    const out = runHook(
      scriptPath,
      taskPayload({
        subagentType: "explore",
        tool_input: {
          description: "Search",
          prompt: "Find it.",
          model: "composer-2.5",
        },
      }),
    );
    assert.deepEqual(out, { permission: "allow" });
  });

  it("strips Sol's unspecified subagentType object with a foreign model", () => {
    const out = runHook(
      scriptPath,
      taskPayload({
        tool_input: {
          description: "Re-review operations docs",
          prompt: "Re-review Task 6 after fixes.",
          model: "claude-sonnet-5-thinking-high",
          subagentType: { unspecified: {} },
        },
      }),
    );
    assert.equal(out.permission, "allow");
    assert.equal(out.updated_input.model, undefined);
    assert.deepEqual(out.updated_input.subagentType, { unspecified: {} });
  });

  it("strips Agent the same way as Task", () => {
    const out = runHook(
      scriptPath,
      taskPayload({
        tool_name: "Agent",
        tool_input: {
          description: "Review",
          prompt: "Review it.",
          model: "claude-sonnet-5-thinking-high",
        },
      }),
    );
    assert.equal(out.permission, "allow");
    assert.equal(out.updated_input.model, undefined);
    assert.equal(out.updated_input.description, "Review");
  });

  it("fail-opens on junk stdin", () => {
    const out = runHook(scriptPath, "this is not json {");
    assert.deepEqual(out, { permission: "allow" });
  });

  it("fail-opens on empty stdin", () => {
    const out = runHook(scriptPath, "");
    assert.deepEqual(out, { permission: "allow" });
  });
});
