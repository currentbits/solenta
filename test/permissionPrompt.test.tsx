/**
 * Tool permission card (#509): the proposed command is an editable field;
 * Accept / Accept all send the edited command, not the original. Non-command
 * tools keep the JSON preview.
 *
 * Run: node --import=./test/support/render.mjs --test test/permissionPrompt.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount, type Mounted } from "./support/dom.ts";
import { ThreadView } from "../src/components/ThreadView";
import type {
  PendingPermissionInfo,
  PermissionDecision,
  ProjectInfo,
  ProviderInfo,
  ThreadDetail,
  ThreadInfo,
} from "../src/shared/ipc";

const project: ProjectInfo = {
  id: "p1",
  slug: "owner/repo",
  name: "repo",
  path: "/tmp/repo",
};

const providers: ProviderInfo[] = [
  {
    id: "claude",
    name: "Claude Code",
    available: true,
    supportsResume: true,
    models: [],
    modelInfo: [],
    efforts: [],
  },
];

function thread(): ThreadInfo {
  return {
    id: "t1",
    projectId: "p1",
    title: "permission edit",
    branch: "coder/permission-edit",
    prNumber: null,
    prUrl: null,
    status: "working",
    createdAt: 1,
    updatedAt: 1,
    runStartedAt: 1,
    archived: false,
    settledOverride: null,
    settledAt: null,
    pinnedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: null,
    prState: null,
    provider: "claude",
    model: null,
    sessionId: null,
    permissionMode: "default",
    reasoningEffort: null,
    worktreePath: "/tmp/wt",
  };
}

function detail(pending: PendingPermissionInfo): ThreadDetail {
  return {
    thread: thread(),
    messages: [],
    workLog: [],
    workflow: null,
    usage: null,
    pendingPermission: pending,
  };
}

const bashPending: PendingPermissionInfo = {
  requestId: "req-bash-1",
  toolName: "Bash",
  summary: "Bash: rm -rf dist && npm build",
  input: '{\n  "command": "rm -rf dist && npm build"\n}',
  command: "rm -rf dist && npm build",
};

const editPending: PendingPermissionInfo = {
  requestId: "req-edit-1",
  toolName: "Edit",
  summary: "Edit: src/foo.ts",
  input: '{\n  "file_path": "src/foo.ts"\n}',
  command: null,
};

interface Spy {
  calls: Array<{
    requestId: string;
    decision: PermissionDecision;
    answers?: Record<string, string>;
    updatedCommand?: string;
  }>;
}

function mountView(pending: PendingPermissionInfo): {
  m: Promise<Mounted>;
  spy: Spy;
} {
  const spy: Spy = { calls: [] };
  const m = mount(
    <ThreadView
      detail={detail(pending)}
      project={project}
      providers={providers}
      workflows={[]}
      hasProjects={true}
      onAddProject={() => {}}
      onStartRun={() => {}}
      onStartWorkflow={() => {}}
      onSaveWorkflow={async () => ({ id: "w", name: "s", phases: [] })}
      onRemoveWorkflow={async () => {}}
      onStopRun={() => {}}
      onSetPermissionMode={() => {}}
      onRespondPermission={(requestId, decision, answers, updatedCommand) => {
        spy.calls.push({ requestId, decision, answers, updatedCommand });
      }}
      onSetProvider={() => {}}
      onSetReasoningEffort={() => {}}
      onSetArchived={() => {}}
      onDeleteThread={() => {}}
    />,
  );
  return { m, spy };
}

describe("PermissionPrompt (#509)", () => {
  it("renders the proposed command in an editable field, not only JSON", async () => {
    const { m } = mountView(bashPending);
    const view = await m;
    const ta = view.query(
      "[data-permission-command]",
    ) as HTMLTextAreaElement | null;
    assert.ok(ta, "command textarea");
    assert.equal(ta.value, "rm -rf dist && npm build");
    assert.ok(view.byText("Accept"));
    assert.ok(view.byText("Accept all"));
    assert.ok(view.byText("Deny"));
    assert.equal(view.query("[data-edited]"), null);
  });

  it("Accept without edits still sends the command in the field", async () => {
    const { m, spy } = mountView(bashPending);
    const view = await m;
    await view.click(view.byText("Accept"));
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].requestId, "req-bash-1");
    assert.equal(spy.calls[0].decision, "allow");
    assert.equal(spy.calls[0].updatedCommand, "rm -rf dist && npm build");
  });

  it("editing then Accept sends the edited command", async () => {
    const { m, spy } = mountView(bashPending);
    const view = await m;
    const ta = view.query(
      "[data-permission-command]",
    ) as HTMLTextAreaElement | null;
    assert.ok(ta);
    await view.type(ta, "npm build");
    assert.ok(view.query("[data-permission-card][data-edited]"));
    assert.ok(view.query("[data-permission-edited]"));
    assert.match(view.text(), /was: rm -rf dist && npm build/);
    await view.click(view.byText("Accept"));
    assert.deepEqual(spy.calls, [
      {
        requestId: "req-bash-1",
        decision: "allow",
        answers: undefined,
        updatedCommand: "npm build",
      },
    ]);
  });

  it("Accept all after an edit sends allowAlways with the edited command", async () => {
    const { m, spy } = mountView(bashPending);
    const view = await m;
    const ta = view.query(
      "[data-permission-command]",
    ) as HTMLTextAreaElement | null;
    assert.ok(ta);
    await view.type(ta, "npm build");
    await view.click(view.byText("Accept all"));
    assert.equal(spy.calls[0].decision, "allowAlways");
    assert.equal(spy.calls[0].updatedCommand, "npm build");
  });

  it("Reset restores the original command", async () => {
    const { m } = mountView(bashPending);
    const view = await m;
    const ta = view.query(
      "[data-permission-command]",
    ) as HTMLTextAreaElement | null;
    assert.ok(ta);
    await view.type(ta, "npm build");
    await view.click(view.query("[data-permission-reset]"));
    assert.equal(ta.value, "rm -rf dist && npm build");
    assert.equal(view.query("[data-edited]"), null);
  });

  it("empty command disables Accept / Accept all; Deny still works", async () => {
    const { m, spy } = mountView(bashPending);
    const view = await m;
    const ta = view.query(
      "[data-permission-command]",
    ) as HTMLTextAreaElement | null;
    assert.ok(ta);
    await view.type(ta, "   ");
    const accept = view.byText("Accept") as HTMLButtonElement;
    const always = view.byText("Accept all") as HTMLButtonElement;
    assert.equal(accept.disabled, true);
    assert.equal(always.disabled, true);
    await view.click(view.byText("Deny"));
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].decision, "deny");
  });

  it("read-only command (Codex) keeps the textarea and does not send updatedCommand (#1171)", async () => {
    const { m, spy } = mountView({
      ...bashPending,
      requestId: "req-codex-1",
      toolName: "command",
      commandEditable: false,
    });
    const view = await m;
    const ta = view.query(
      "[data-permission-command]",
    ) as HTMLTextAreaElement | null;
    assert.ok(ta);
    assert.equal(ta.readOnly, true);
    await view.click(view.byText("Accept"));
    assert.equal(spy.calls[0].decision, "allow");
    assert.equal(spy.calls[0].updatedCommand, undefined);
  });

  it("hides Accept all when acceptAlways is false (#1171)", async () => {
    const { m } = mountView({
      ...bashPending,
      acceptAlways: false,
    });
    const view = await m;
    assert.ok(view.byText("Accept"));
    assert.ok(!view.text().includes("Accept all"));
  });

  it("Codex fileChange shows the diff, reason and grantRoot instead of JSON (#1189)", async () => {
    const { m, spy } = mountView({
      ...editPending,
      requestId: "req-fc-1",
      input: '{\n  "changes": []\n}',
      fileChange: {
        diff:
          "diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n",
        reason: "needs write access",
        grantRoot: "/tmp/other",
      },
    });
    const view = await m;
    const diff = view.query("[data-permission-diff]");
    assert.ok(diff, "diff surface");
    assert.match(diff.textContent || "", /src\/foo\.ts/);
    assert.match(diff.textContent || "", /const a = 2;/);
    assert.ok(diff.querySelector('[data-kind="add"]'));
    assert.ok(diff.querySelector('[data-kind="del"]'));
    assert.ok(!view.text().includes('"changes"'));
    assert.match(view.query("[data-permission-reason]")?.textContent || "", /needs write access/);
    assert.match(view.query("[data-permission-grant-root]")?.textContent || "", /\/tmp\/other/);
    await view.click(view.byText("Accept all"));
    assert.equal(spy.calls[0].decision, "allowAlways");
    assert.equal(spy.calls[0].updatedCommand, undefined);
  });

  it("non-command tools keep the JSON preview and do not send updatedCommand", async () => {
    const { m, spy } = mountView(editPending);
    const view = await m;
    assert.equal(view.query("[data-permission-command]"), null);
    assert.match(view.text(), /file_path/);
    await view.click(view.byText("Accept"));
    assert.equal(spy.calls[0].decision, "allow");
    assert.equal(spy.calls[0].updatedCommand, undefined);
  });
});

describe("PermissionPrompt governance strip (#262)", () => {
  const risky = { rule: "rm-rf", reason: "Deletes files recursively" };

  it("keeps reason (rule) when no layer is sent", async () => {
    const view = await mountView({ ...bashPending, guardrail: risky }).m;
    assert.equal(
      view.query("[data-permission-guardrail]")?.textContent,
      "⚠ Deletes files recursively (rm-rf)",
    );
    assert.ok(view.text().includes("Accept all"));
  });

  it("shows reason (layer / rule) and keeps Accept all for builtin", async () => {
    const view = await mountView({
      ...bashPending,
      guardrail: { ...risky, layer: "builtin" },
    }).m;
    assert.equal(
      view.query("[data-permission-guardrail]")?.textContent,
      "⚠ Deletes files recursively (builtin / rm-rf)",
    );
    assert.ok(view.text().includes("Accept all"));
  });

  it("hides Accept all on profile.ask", async () => {
    const view = await mountView({
      ...bashPending,
      guardrail: {
        rule: "bash:git push*",
        reason: "Profile always asks",
        layer: "profile.ask",
      },
    }).m;
    assert.match(
      view.query("[data-permission-guardrail]")?.textContent || "",
      /\(profile\.ask \/ bash:git push\*\)/,
    );
    assert.ok(view.byText("Accept"));
    assert.ok(!view.text().includes("Accept all"));
  });
});

describe("PermissionPrompt folder grant (#514)", () => {
  it("offers Allow writes to <folder> and sends allowFolder", async () => {
    const { m, spy } = mountView({
      ...editPending,
      summary: "Write: /tmp/shared-lib/x.ts",
      folderGrant: "/tmp/shared-lib",
    });
    const view = await m;
    assert.ok(view.query("[data-permission-folder]"));
    await view.click(view.byText("Allow writes to shared-lib"));
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].decision, "allowFolder");
  });

  it("has no folder button on an ordinary edit", async () => {
    const { m } = mountView(editPending);
    const view = await m;
    assert.equal(view.query("[data-permission-allow-folder]"), null);
  });
});
