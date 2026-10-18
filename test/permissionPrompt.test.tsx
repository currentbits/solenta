/**
 * Tool permission card (#509): the proposed command is an editable field;
 * Accept / Always allow send the edited command, not the original. Non-command
 * tools keep the JSON preview. y / n / a answer from the keyboard, even from
 * a focused composer (#477).
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
    alwaysRule?: string | null;
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
      onRespondPermission={(
        requestId,
        decision,
        answers,
        updatedCommand,
        _inputValues,
        _feedback,
        alwaysRule,
      ) => {
        spy.calls.push({
          requestId,
          decision,
          answers,
          updatedCommand,
          ...(alwaysRule !== undefined ? { alwaysRule } : {}),
        });
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
    assert.ok(view.byText("Always allow"));
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

  it("Always allow after an edit sends allowAlways with the edited command and its prefix", async () => {
    const { m, spy } = mountView(bashPending);
    const view = await m;
    const ta = view.query(
      "[data-permission-command]",
    ) as HTMLTextAreaElement | null;
    assert.ok(ta);
    await view.type(ta, "npm build");
    assert.match(view.byText("Always allow")!.textContent!, /npm build:\*/);
    await view.click(view.byText("Always allow"));
    assert.equal(spy.calls[0].decision, "allowAlways");
    assert.equal(spy.calls[0].updatedCommand, "npm build");
    assert.equal(spy.calls[0].alwaysRule, "npm build:*");
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

  it("empty command disables Accept / Always allow; Deny still works", async () => {
    const { m, spy } = mountView(bashPending);
    const view = await m;
    const ta = view.query(
      "[data-permission-command]",
    ) as HTMLTextAreaElement | null;
    assert.ok(ta);
    await view.type(ta, "   ");
    const accept = view.byText("Accept") as HTMLButtonElement;
    const always = view.byText("Always allow") as HTMLButtonElement;
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

  it("hides allow-always when acceptAlways is false (#1171)", async () => {
    const { m } = mountView({
      ...bashPending,
      acceptAlways: false,
    });
    const view = await m;
    assert.ok(view.byText("Accept"));
    assert.equal(view.query("[data-permission-always]"), null);
    assert.equal(view.query("[data-permission-rule]"), null);
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
    await view.click(view.query("[data-permission-always]"));
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

  it("Codex and non-command tools keep a plain session accept, no rule (#477)", async () => {
    for (const pending of [
      { ...bashPending, commandEditable: false },
      editPending,
    ]) {
      const { m, spy } = mountView(pending);
      const view = await m;
      assert.equal(view.query("[data-permission-rule]"), null);
      await view.click(view.byText("Accept for session"));
      assert.equal(spy.calls[0].decision, "allowAlways");
      assert.equal("alwaysRule" in spy.calls[0], false);
      view.unmount();
    }
  });
});

/** Press a key; true when the card took it (the field never saw the keydown). */
async function key(view: Mounted, el: Element, k: string): Promise<boolean> {
  let reached = false;
  const seen = () => {
    reached = true;
  };
  el.addEventListener("keydown", seen);
  await view.press(el, k);
  el.removeEventListener("keydown", seen);
  return !reached;
}

describe("PermissionPrompt keyboard (#477)", () => {
  const npmPending: PendingPermissionInfo = {
    ...bashPending,
    summary: "Bash: npm test -- foo",
    command: "npm test -- foo",
  };

  for (const [k, decision] of [
    ["y", "allow"],
    ["n", "deny"],
    ["a", "allowAlways"],
  ] as const) {
    it(`${k} answers ${decision} from a focused composer and is not typed`, async () => {
      const { m, spy } = mountView(npmPending);
      const view = await m;
      const composer = view.query(
        "[data-composer-input]",
      ) as HTMLTextAreaElement;
      assert.ok(composer, "composer textarea");
      composer.focus();
      assert.equal(await key(view, composer, k), true);
      assert.equal(composer.value, "");
      assert.equal(spy.calls.length, 1);
      assert.equal(spy.calls[0].decision, decision);
      if (k === "a") assert.equal(spy.calls[0].alwaysRule, "npm test:*");
    });
  }

  it("the card's own fields keep their keys; answered cards release them", async () => {
    const { m, spy } = mountView(npmPending);
    const view = await m;
    const ta = view.query("[data-permission-command]")!;
    const rule = view.query("[data-permission-rule]")!;
    assert.equal(await key(view, ta, "y"), false);
    assert.equal(await key(view, rule, "a"), false);
    assert.equal(spy.calls.length, 0);
    const composer = view.query("[data-composer-input]")!;
    assert.equal(await key(view, composer, "n"), true);
    assert.equal(await key(view, composer, "y"), false);
    assert.equal(spy.calls.length, 1);
  });

  it("a guardrail-flagged call never takes keys from the composer", async () => {
    const { m, spy } = mountView({
      ...npmPending,
      guardrail: { rule: "RISKY", reason: "touches prod" },
    });
    const view = await m;
    assert.equal(await key(view, view.query("[data-composer-input]")!, "y"), false);
    assert.equal(spy.calls.length, 0);
    // Outside any text field the keys still answer.
    assert.equal(await key(view, view.query("[data-permission-card]")!, "y"), true);
    assert.equal(spy.calls[0].decision, "allow");
  });

  it("modifiers pass through (Cmd+A still selects all)", async () => {
    const { m, spy } = mountView(npmPending);
    const view = await m;
    await view.press(view.query("[data-composer-input]"), "a", { metaKey: true });
    assert.equal(spy.calls.length, 0);
  });

  it("an edited rule is sent; any-tool sends null (#479)", async () => {
    const { m, spy } = mountView(npmPending);
    const view = await m;
    const rule = view.query("[data-permission-rule]") as HTMLInputElement;
    assert.equal(rule.value, "npm test:*");
    await view.type(rule, "npm *");
    assert.match(view.byText("Always allow")!.textContent!, /npm \*/);
    await view.click(view.byText("Always allow"));
    assert.equal(spy.calls[0].alwaysRule, "npm *");

    const second = mountView(npmPending);
    const v2 = await second.m;
    await v2.click(v2.query("[data-permission-any-tool]"));
    assert.equal(second.spy.calls[0].decision, "allowAlways");
    assert.equal(second.spy.calls[0].alwaysRule, null);
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
    assert.ok(view.query("[data-permission-always]"));
  });

  it("shows reason (layer / rule) and keeps allow-always for builtin", async () => {
    const view = await mountView({
      ...bashPending,
      guardrail: { ...risky, layer: "builtin" },
    }).m;
    assert.equal(
      view.query("[data-permission-guardrail]")?.textContent,
      "⚠ Deletes files recursively (builtin / rm-rf)",
    );
    assert.ok(view.query("[data-permission-always]"));
  });

  it("hides allow-always on profile.ask", async () => {
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
    assert.equal(view.query("[data-permission-always]"), null);
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
