/**
 * Isolated plugin-activation planning and execution. Never talks to a real CLI.
 * Run: node --test electron/test/skill-plugin-adapters.test.js
 */
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { detectPluginExtras } = require("../skillImports.js");
const {
  planPluginActions,
  executePluginActions,
  createSafeCommandRunner,
} = require("../skillPluginAdapters.js");

const PONYTAIL_URL = "https://github.com/DietrichGebert/ponytail";
const OWNER_REPO = "DietrichGebert/ponytail";

let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-plugin-adapt-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writePonytailManifests(root) {
  writeFile(
    path.join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "ponytail", description: "Claude plugin" }),
  );
  writeFile(
    path.join(root, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "ponytail" }),
  );
  writeFile(
    path.join(root, ".grok-plugin", "marketplace.json"),
    JSON.stringify({ name: "ponytail" }),
  );
  writeFile(path.join(root, "plugin.json"), JSON.stringify({ name: "ponytail" }));
  writeFile(path.join(root, "hooks", "ponytail-statusline.sh"), "#!/bin/sh\necho ok\n");
  writeFile(path.join(root, "commands", "ponytail.md"), "# ponytail\n");
}

function recordingRunner(handler) {
  const calls = [];
  const runFile = async (binary, args, opts) => {
    calls.push({ binary, args, opts });
    if (handler) return handler(binary, args, opts, calls);
    return { stdout: "", stderr: "" };
  };
  return { calls, runFile };
}

describe("planPluginActions Ponytail source", () => {
  it("dedupes Grok/generic manifests and produces Codex/Grok argv plus Claude instructions", () => {
    writePonytailManifests(tmp);
    const extras = detectPluginExtras(tmp);
    const kinds = extras.map((e) => e.activation.kind);
    assert.ok(kinds.includes("grok-plugin"));
    assert.ok(kinds.includes("plugin"));

    const plan = planPluginActions({
      kind: "catalog",
      sourceUrl: PONYTAIL_URL,
      plugins: extras,
    });

    const byKind = Object.fromEntries(plan.map((row) => [row.kind, row]));
    assert.deepEqual(byKind["codex-plugin"].commands, [
      {
        binary: "codex",
        args: ["plugin", "marketplace", "add", OWNER_REPO],
      },
      {
        binary: "codex",
        args: ["plugin", "add", "ponytail@ponytail"],
      },
    ]);
    assert.deepEqual(byKind["grok-plugin"].commands, [
      {
        binary: "grok",
        args: ["plugin", "install", OWNER_REPO, "--trust"],
      },
    ]);
    assert.equal(byKind["claude-plugin"].status, "manual");
    assert.deepEqual(byKind["claude-plugin"].instructions, [
      `/plugin marketplace add ${OWNER_REPO}`,
      "/plugin install ponytail@ponytail",
    ]);
    assert.notEqual(byKind.plugin.status, "covered");
    assert.notEqual(byKind.hooks.status, "covered");
    assert.notEqual(byKind.commands.status, "covered");
    assert.equal(byKind.plugin.commands, undefined);
    assert.equal(byKind.hooks.commands, undefined);
    assert.equal(byKind.commands.commands, undefined);

    const grokCommands = plan.flatMap((row) => row.commands || []).filter(
      (cmd) => cmd.binary === "grok",
    );
    assert.equal(grokCommands.length, 1, "root plugin.json must not add a second Grok install");
  });

  it("refuses tree/blob/raw/codeload/tag/SHA previews with no commands or default-branch fallback", () => {
    const extras = [
      {
        provider: "codex",
        label: "ponytail",
        pluginName: "ponytail",
        activation: { kind: "codex-plugin", status: "pending" },
      },
      {
        provider: "grok",
        label: "ponytail",
        pluginName: "ponytail",
        activation: { kind: "grok-plugin", status: "pending" },
      },
      {
        provider: "claude",
        label: "ponytail",
        pluginName: "ponytail",
        activation: { kind: "claude-plugin", status: "pending" },
      },
    ];
    const pinned = [
      "https://github.com/DietrichGebert/ponytail/tree/main",
      "https://github.com/DietrichGebert/ponytail/blob/main/skills/ponytail-help/SKILL.md",
      "https://raw.githubusercontent.com/DietrichGebert/ponytail/main/skills/ponytail-help/SKILL.md",
      "https://codeload.github.com/DietrichGebert/ponytail/zip/main",
      "https://github.com/DietrichGebert/ponytail/tree/v1.2.3",
      "https://github.com/DietrichGebert/ponytail/tree/0123456789abcdef0123456789abcdef01234567",
    ];
    for (const sourceUrl of pinned) {
      const plan = planPluginActions({
        kind: "github",
        sourceUrl,
        plugins: extras,
      });
      assert.ok(
        plan.every((row) => row.status === "unsupported"),
        sourceUrl,
      );
      assert.ok(
        plan.every((row) => !row.commands && !row.instructions),
        sourceUrl,
      );
      assert.ok(
        plan.every(
          (row) =>
            row.error ===
            "Provider plugin activation cannot safely pin the previewed ref.",
        ),
        sourceUrl,
      );
    }
  });

  it("marks local ZIP/Markdown and invalid names unsupported with no commands", () => {
    const extras = [
      {
        provider: "codex",
        label: "ponytail",
        pluginName: "ponytail",
        activation: { kind: "codex-plugin", status: "pending" },
      },
    ];
    const local = planPluginActions({
      kind: "local",
      sourceUrl: PONYTAIL_URL,
      plugins: extras,
    });
    assert.equal(local[0].status, "unsupported");
    assert.equal(local[0].commands, undefined);

    const badName = planPluginActions({
      kind: "github",
      sourceUrl: PONYTAIL_URL,
      plugins: [
        {
          provider: "codex",
          label: "Not A Name",
          pluginName: "Not A Name",
          activation: { kind: "codex-plugin", status: "pending" },
        },
      ],
    });
    assert.equal(badName[0].status, "unsupported");
    assert.equal(badName[0].commands, undefined);

    const unrecognized = planPluginActions({
      kind: "github",
      sourceUrl: PONYTAIL_URL,
      plugins: [
        {
          provider: "hooks",
          label: "Hooks",
          activation: { kind: "hooks", status: "pending" },
        },
      ],
    });
    assert.equal(unrecognized[0].status, "unsupported");
  });
});

describe("executePluginActions", () => {
  it("skips every extra and calls no runner when trustPluginCode is false", async () => {
    writePonytailManifests(tmp);
    const plan = planPluginActions({
      kind: "catalog",
      sourceUrl: PONYTAIL_URL,
      plugins: detectPluginExtras(tmp),
    });
    const { calls, runFile } = recordingRunner(() => {
      throw new Error("runner must not be called");
    });
    const result = await executePluginActions(plan, {
      trustPluginCode: false,
      runFile,
    });
    assert.equal(calls.length, 0);
    assert.ok(result.length > 0);
    assert.ok(result.every((row) => row.status === "skipped"));
  });

  it("does not treat a coerced truthy trustPluginCode as trust", async () => {
    const plan = planPluginActions({
      kind: "github",
      sourceUrl: PONYTAIL_URL,
      plugins: [
        {
          provider: "grok",
          label: "ponytail",
          pluginName: "ponytail",
          activation: { kind: "grok-plugin", status: "pending" },
        },
      ],
    });
    const { calls, runFile } = recordingRunner();
    const result = await executePluginActions(plan, {
      trustPluginCode: 1,
      runFile,
    });
    assert.equal(calls.length, 0);
    assert.ok(result.every((row) => row.status === "skipped"));
  });

  it("covers extras only after a provider actually activates", async () => {
    writePonytailManifests(tmp);
    const plan = planPluginActions({
      kind: "catalog",
      sourceUrl: PONYTAIL_URL,
      plugins: detectPluginExtras(tmp),
    });
    const { runFile } = recordingRunner();
    const result = await executePluginActions(plan, {
      trustPluginCode: true,
      runFile,
    });
    const byKind = Object.fromEntries(result.map((row) => [row.kind || row.provider, row]));
    const plugin = result.find((row) => row.provider === "plugin");
    const hooks = result.find((row) => row.provider === "hooks");
    const commands = result.find((row) => row.provider === "commands");
    assert.equal(result.find((row) => row.provider === "grok")?.status, "activated");
    assert.equal(plugin.status, "covered");
    assert.equal(hooks.status, "covered");
    assert.equal(commands.status, "covered");
    assert.equal(byKind.claude?.status || result.find((r) => r.provider === "claude")?.status, "manual");
  });

  it("mirrors Claude instructions onto extras when no provider activated", async () => {
    writePonytailManifests(tmp);
    const plan = planPluginActions({
      kind: "catalog",
      sourceUrl: PONYTAIL_URL,
      plugins: detectPluginExtras(tmp),
    });
    const { runFile } = recordingRunner(() => {
      const err = new Error("CLI exited 1");
      err.stderr = "denied";
      throw err;
    });
    const result = await executePluginActions(plan, {
      trustPluginCode: true,
      runFile,
    });
    const instructions = [
      `/plugin marketplace add ${OWNER_REPO}`,
      "/plugin install ponytail@ponytail",
    ];
    assert.equal(result.find((row) => row.provider === "claude")?.status, "manual");
    for (const extra of ["plugin", "hooks", "commands"]) {
      const row = result.find((r) => r.provider === extra);
      assert.equal(row.status, "manual");
      assert.deepEqual(row.instructions, instructions);
    }
  });

  it("fails extras with a bounded error when automatic actions fail and there is no manual path", async () => {
    const plan = planPluginActions({
      kind: "github",
      sourceUrl: PONYTAIL_URL,
      plugins: [
        {
          provider: "codex",
          label: "ponytail",
          pluginName: "ponytail",
          activation: { kind: "codex-plugin", status: "pending" },
        },
        {
          provider: "hooks",
          label: "Hooks",
          activation: { kind: "hooks", status: "pending" },
        },
      ],
    });
    const leak = `${"nope ".repeat(80)} ${path.join(tmp, "stage")} ghs_leaktoken`;
    const { runFile } = recordingRunner(() => {
      const err = new Error("Command failed");
      err.stderr = leak;
      throw err;
    });
    const result = await executePluginActions(plan, {
      trustPluginCode: true,
      runFile,
    });
    const hooks = result.find((row) => row.provider === "hooks");
    assert.equal(result.find((row) => row.provider === "codex")?.status, "failed");
    assert.equal(hooks.status, "failed");
    assert.equal(typeof hooks.error, "string");
    assert.ok(hooks.error.length <= 200);
    assert.equal(hooks.error.includes("ghs_leaktoken"), false);
    assert.equal(hooks.error.includes(path.join(tmp, "stage")), false);
  });

  it("stops the Codex follow-up after the first command fails and bounds the error", async () => {
    const plan = planPluginActions({
      kind: "github",
      sourceUrl: PONYTAIL_URL,
      plugins: [
        {
          provider: "codex",
          label: "ponytail",
          pluginName: "ponytail",
          activation: { kind: "codex-plugin", status: "pending" },
        },
        {
          provider: "grok",
          label: "ponytail",
          pluginName: "ponytail",
          activation: { kind: "grok-plugin", status: "pending" },
        },
      ],
    });
    const leak = `${"x".repeat(4000)} ${path.join(tmp, "stage", "secret")} ghs_leaktoken`;
    const { calls, runFile } = recordingRunner(async (binary, args) => {
      if (binary === "codex" && args[1] === "marketplace") {
        const err = new Error("Command failed");
        err.stderr = leak;
        throw err;
      }
      return { stdout: "ok", stderr: "" };
    });
    const result = await executePluginActions(plan, {
      trustPluginCode: true,
      runFile,
    });
    assert.deepEqual(
      calls.map((c) => [c.binary, c.args[1]]),
      [
        ["codex", "marketplace"],
        ["grok", "install"],
      ],
    );
    assert.ok(calls.every((c) => !c.opts || c.opts.shell !== true));
    const codex = result.find((row) => row.provider === "codex");
    const grok = result.find((row) => row.provider === "grok");
    assert.equal(codex.status, "failed");
    assert.equal(grok.status, "activated");
    assert.equal(typeof codex.error, "string");
    assert.ok(codex.error.length <= 200);
    assert.equal(codex.error.includes(path.join(tmp, "stage")), false);
    assert.equal(codex.error.includes("ghs_leaktoken"), false);
    assert.equal(JSON.stringify(result).includes("PATH="), false);
    assert.equal(JSON.stringify(result).includes(tmp), false);
  });
});

describe("createSafeCommandRunner", () => {
  it("forces execFile argv, 30s timeout, bounded output, ignored stdin, and no shell", async () => {
    const calls = [];
    const runner = createSafeCommandRunner({
      execFile(bin, args, opts, cb) {
        calls.push({ bin, args, opts });
        cb(null, "ok", "");
      },
    });
    await runner("codex", ["plugin", "add", "ponytail@ponytail"], {
      shell: true,
      stdio: "inherit",
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bin, "codex");
    assert.deepEqual(calls[0].args, ["plugin", "add", "ponytail@ponytail"]);
    assert.equal(calls[0].opts.shell, false);
    assert.equal(calls[0].opts.timeout, 30_000);
    assert.ok(calls[0].opts.maxBuffer > 0);
    assert.ok(calls[0].opts.maxBuffer <= 64 * 1024);
    assert.equal(calls[0].opts.stdio[0], "ignore");
    assert.equal(calls[0].opts.stdio.includes("inherit"), false);
  });

  it("allowlists only codex and grok and never enables a shell", async () => {
    const calls = [];
    const runner = createSafeCommandRunner({
      execFile(bin, args, opts, cb) {
        calls.push({ bin, args, opts });
        cb(null, "ok", "");
      },
    });
    await assert.rejects(() => runner("bash", ["-c", "echo hi"]), /unavailable/i);
    await assert.rejects(() => runner("claude", ["plugin", "install", "x"]), /unavailable/i);
    assert.equal(calls.length, 0);
    await runner("grok", ["plugin", "install", OWNER_REPO, "--trust"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bin, "grok");
    assert.equal(calls[0].opts.shell, false);
  });
});
