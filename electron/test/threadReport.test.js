"use strict";

/**
 * Issue #394: the exported bug report is shared outside the machine, so no
 * secret shape, secret-card value or home path may survive into the HTML.
 */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const threadSecrets = require("../threadSecrets.js");
const {
  buildThreadReport,
  exportThreadReport,
  buildThreadReportMarkdown,
  exportThreadReportMarkdown,
} = require("../threadReport.js");

const GH = "ghp_" + "a".repeat(36);
const CARD = "hunter2-very-secret";

function detail(messages) {
  return {
    thread: {
      id: "t-report",
      title: "Fix <login> bug",
      projectId: "p1",
      provider: "claude",
      model: "claude-opus-5-5",
      branch: "coder/fix",
      status: "idle",
      permissionMode: "auto",
    },
    messages,
    workLog: [],
    workflow: null,
    usage: { model: "claude-opus-5-5", inputTokens: 10, outputTokens: 20, costUsd: 0.5, turns: 2 },
  };
}

afterEach(() => threadSecrets.clear("t-report"));

describe("buildThreadReport", () => {
  it("redacts secrets everywhere, escapes HTML and counts what it removed", () => {
    threadSecrets.set("t-report", "DB_PASSWORD", CARD);
    const { html, counts } = buildThreadReport({
      detail: detail([
        { id: "1", role: "user", text: `use ${GH} and ${CARD}`, createdAt: 1 },
        {
          id: "2",
          role: "tool",
          text: "Bash: curl",
          createdAt: 2,
          tool: {
            id: "x",
            name: "Bash",
            input: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz" /Users/alice/proj',
            output: "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\nok",
            isError: false,
            done: true,
          },
        },
        { id: "3", role: "assistant", text: '<script>alert(1)</script> api_key = "your-key-goes-here-please"', createdAt: 3 },
      ]),
      projectName: "proj",
      env: { appVersion: "0.25.0", os: "Darwin", agentVersion: "2.1.0 (Claude Code)" },
      diffs: [{ label: "Uncommitted", patch: `+TOKEN=${GH}\n` }],
      exportedAt: Date.UTC(2026, 9, 18),
      home: "/Users/alice",
    });
    assert.ok(!html.includes(GH), "github token");
    assert.ok(!html.includes(CARD), "secret-card value");
    assert.ok(!html.includes("abcdefghijklmnopqrstuvwxyz"), "bearer token");
    assert.ok(!html.includes("MIIEpAIBAAKCAQEA"), "whole PEM body, not just its header");
    assert.ok(!html.includes("/Users/alice"), "home path");
    assert.ok(html.includes("~/proj"));
    assert.ok(!html.includes("<script>"), "transcript text is escaped");
    assert.ok(html.includes("&#60;login&#62;"), "title is escaped");
    assert.ok(html.includes("your-key-goes-here-please"), "placeholders are left alone");
    assert.ok(html.includes("2.1.0 (Claude Code)") && html.includes("0.25.0"));
    assert.deepEqual(counts, {
      "secret.request-card": 1,
      "secret.private-key": 1,
      "secret.bearer": 1,
      "secret.github-token": 2,
    });
    assert.match(html, /Redacted 5 secret\(s\)/);
  });
});

describe("exportThreadReport", () => {
  it("writes the picked path and does nothing on cancel", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-report-"));
    const store = {
      getThread: (id) => (id === "t-report" ? { ...detail([]).thread, archived: false } : null),
      getProject: () => ({ id: "p1", name: "proj", path: dir }),
      getMessages: () => [{ id: "1", role: "user", text: `hi ${GH}`, createdAt: 1 }],
      getWorkLog: () => [],
      getUsage: () => null,
      getRunArtifacts: () => [],
      getThreads: () => [],
      listThreads: () => [],
    };
    const file = path.join(dir, "out.html");
    let opts = null;
    const dialog = {
      showSaveDialog: async (o) => {
        opts = o;
        return { canceled: false, filePath: file };
      },
    };
    const written = await exportThreadReport({ store, dialog }, "t-report");
    assert.equal(written, file);
    assert.equal(opts.defaultPath, "fix-login-bug-report.html");
    const html = fs.readFileSync(file, "utf8");
    assert.ok(html.includes("[redacted:github-token]") && !html.includes(GH));

    fs.rmSync(file);
    const cancelled = await exportThreadReport(
      { store, dialog: { showSaveDialog: async () => ({ canceled: true }) } },
      "t-report",
    );
    assert.equal(cancelled, null);
    assert.equal(fs.existsSync(file), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("buildThreadReportMarkdown", () => {
  it("redacts secrets, collapses tool calls to one line, lists attachments and keeps code fences verbatim", () => {
    threadSecrets.set("t-report", "DB_PASSWORD", CARD);
    const { markdown, counts } = buildThreadReportMarkdown({
      detail: detail([
        {
          id: "1",
          role: "user",
          text: `use ${GH} and ${CARD}`,
          createdAt: 1,
          attachments: [{ kind: "image", path: "/x/screenshot.png", name: "screenshot.png" }],
        },
        {
          id: "2",
          role: "tool",
          text: `Bash: curl ${GH}`,
          createdAt: 2,
          tool: {
            id: "x",
            name: "Bash",
            input: "curl /some/long/command --with --many --flags",
            output: "200 OK",
            isError: true,
            done: true,
          },
        },
        {
          id: "3",
          role: "assistant",
          text: "Here is the fix:\n```js\nconsole.log(1)\n```",
          createdAt: 3,
        },
      ]),
      projectName: "proj",
      exportedAt: Date.UTC(2026, 9, 18),
      home: "/Users/alice",
    });
    assert.ok(!markdown.includes(GH), "github token redacted everywhere it is printed");
    assert.ok(!markdown.includes(CARD), "secret-card value redacted");
    assert.ok(markdown.startsWith("# Fix <login> bug"), "title is plain text, not HTML-escaped");
    assert.ok(markdown.includes("## You"), "user section heading");
    assert.ok(markdown.includes("## Agent"), "assistant section heading");
    assert.ok(
      markdown.includes("```js\nconsole.log(1)\n```"),
      "the assistant's own code fence survives untouched",
    );
    assert.match(markdown, /> tool: Bash - Bash: curl \[redacted:github-token\]\s*\(error\)/);
    assert.ok(
      !markdown.includes("curl /some/long/command"),
      "full tool input is not dumped, only the one-line summary",
    );
    assert.ok(markdown.includes("Attachments: screenshot.png"), "attachment listed by name");
    assert.deepEqual(counts, {
      "secret.request-card": 1,
      "secret.github-token": 2,
    });
    assert.match(markdown, /Redacted 3 secret\(s\)/);
  });

  it("renders a clean transcript with no secrets found", () => {
    const { markdown, counts } = buildThreadReportMarkdown({
      detail: detail([{ id: "1", role: "user", text: "hello", createdAt: 1 }]),
      projectName: "proj",
      exportedAt: Date.UTC(2026, 9, 18),
    });
    assert.deepEqual(counts, {});
    assert.match(markdown, /No secrets matched the redaction rules\./);
    assert.ok(markdown.includes("- **Project:** proj"));
    assert.ok(markdown.includes("- **Provider:** claude"));
    assert.ok(markdown.includes("- **Model:** claude-opus-5-5"));
  });
});

describe("exportThreadReportMarkdown", () => {
  it("writes the picked .md path and does nothing on cancel", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-report-md-"));
    const store = {
      getThread: (id) => (id === "t-report" ? { ...detail([]).thread, archived: false } : null),
      getProject: () => ({ id: "p1", name: "proj", path: dir }),
      getMessages: () => [{ id: "1", role: "user", text: `hi ${GH}`, createdAt: 1 }],
      getWorkLog: () => [],
      getUsage: () => null,
      getRunArtifacts: () => [],
      getThreads: () => [],
      listThreads: () => [],
    };
    const file = path.join(dir, "out.md");
    let opts = null;
    const dialog = {
      showSaveDialog: async (o) => {
        opts = o;
        return { canceled: false, filePath: file };
      },
    };
    const written = await exportThreadReportMarkdown({ store, dialog }, "t-report");
    assert.equal(written, file);
    assert.equal(opts.defaultPath, "fix-login-bug-report.md");
    const markdown = fs.readFileSync(file, "utf8");
    assert.ok(markdown.includes("[redacted:github-token]") && !markdown.includes(GH));

    fs.rmSync(file);
    const cancelled = await exportThreadReportMarkdown(
      { store, dialog: { showSaveDialog: async () => ({ canceled: true }) } },
      "t-report",
    );
    assert.equal(cancelled, null);
    assert.equal(fs.existsSync(file), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
