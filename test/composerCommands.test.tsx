/**
 * Composer `/` command popup (issue #472): a lone `/` lists CLI verbs and
 * the orchestration trio. Insert verbs stay in the draft; run verbs fire
 * and clear the token.
 *
 * Run: node --import=./test/support/render.mjs --test test/composerCommands.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inAct, mount, type Mounted } from "./support/dom.ts";
import { Composer } from "../src/components/Composer";
import type { ProviderInfo } from "../src/shared/ipc";
import type { SlashAction } from "../src/slashCommands";

const PROVIDERS: ProviderInfo[] = [
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

function mountComposer(
  onSend: (prompt: string) => void = () => {},
  over: {
    onSlashAction?: (action: SlashAction) => void;
    busy?: boolean;
  } = {},
) {
  return mount(
    <Composer
      threadId="t1"
      branch="agentmux/abc"
      permissionMode="default"
      onPermissionModeChange={() => {}}
      provider="claude"
      model={null}
      reasoningEffort={null}
      providers={PROVIDERS}
      workflows={[]}
      onSetProvider={() => {}}
      onSetReasoningEffort={() => {}}
      onSaveWorkflow={async (t) => ({
        id: "saved",
        name: t.name,
        builtin: false,
        phases: t.phases,
      })}
      onRemoveWorkflow={async () => {}}
      sessionId={null}
      hasWorktree={true}
      busy={over.busy}
      onSend={onSend}
      onBuild={() => {}}
      onSlashAction={over.onSlashAction}
    />,
  );
}

function textarea(m: Mounted): HTMLTextAreaElement {
  const el = m.container.querySelector("textarea");
  assert.ok(el, "textarea present");
  return el as HTMLTextAreaElement;
}

/** Put the caret at the end and tell React the selection changed. */
async function caretToEnd(m: Mounted): Promise<void> {
  const el = textarea(m);
  await inAct(() => {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    el.dispatchEvent(new Event("select", { bubbles: true }));
  });
}

function commandList(m: Mounted): Element | null {
  return m.container.querySelector('[role="listbox"][aria-label="Commands"]');
}

describe("Composer / command popup", () => {
  it("opens on / with CLI verbs and the orchestration trio", async () => {
    const m = await mountComposer();
    const el = textarea(m);
    await m.type(el, "/");
    await caretToEnd(m);

    assert.ok(commandList(m), "popup open after /");
    for (const name of [
      "/compact",
      "/rewind",
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
      assert.ok(m.byText(name), `${name} listed`);
    }
    assert.ok(
      m.byText("Plan here, implement on a fresh model"),
      "handoff hint shown",
    );
    assert.ok(
      m.byText("One second opinion on a contrasting model"),
      "advisor hint shown",
    );
    assert.ok(
      m.byText("Two contrasting models converge on a root cause"),
      "committee hint shown",
    );
  });

  it("filters /co to compact, context, and committee", async () => {
    const m = await mountComposer();
    const el = textarea(m);
    await m.type(el, "/co");
    await caretToEnd(m);

    assert.ok(commandList(m), "popup open after /co");
    assert.ok(m.byText("/compact"), "compact matches /co");
    assert.ok(m.byText("/context"), "context matches /co");
    assert.ok(m.byText("/committee"), "committee matches /co");
    assert.equal(m.byText("/handoff"), null, "handoff filtered out");
    assert.equal(m.byText("/advisor"), null, "advisor filtered out");
    assert.equal(m.byText("/clear"), null, "clear does not match /co");
  });

  it("Enter inserts an orchestration command and does not send", async () => {
    const sends: string[] = [];
    const m = await mountComposer((prompt) => {
      sends.push(prompt);
    });
    const el = textarea(m);
    await m.type(el, "/comm");
    await caretToEnd(m);
    assert.ok(commandList(m), "popup open before Enter");

    await m.press(el, "Enter");
    assert.equal(textarea(m).value, "/committee ");
    assert.ok(!commandList(m), "popup closed after accept");
    assert.deepEqual(sends, [], "Enter did not send while the popup was open");
  });

  it("Enter on a run verb fires the action and clears the token", async () => {
    const actions: SlashAction[] = [];
    const sends: string[] = [];
    const m = await mountComposer((prompt) => sends.push(prompt), {
      onSlashAction: (action) => actions.push(action),
    });
    const el = textarea(m);
    await m.type(el, "/rewind");
    await caretToEnd(m);
    assert.ok(commandList(m), "popup open before Enter");

    await m.press(el, "Enter");
    assert.equal(textarea(m).value, "", "run verb does not stay in the draft");
    assert.ok(!commandList(m), "popup closed after accept");
    assert.deepEqual(actions, ["rewind"]);
    assert.deepEqual(sends, [], "Enter did not send the run verb");
  });

  it("Enter on /model opens the model picker and does not send", async () => {
    const sends: string[] = [];
    const m = await mountComposer((prompt) => sends.push(prompt));
    const el = textarea(m);
    await m.type(el, "/model");
    await caretToEnd(m);
    await m.press(el, "Enter");
    assert.equal(textarea(m).value, "");
    assert.ok(m.query('[aria-label="Model picker"]'), "model picker opened");
    assert.deepEqual(sends, []);
  });

  it("Enter on /permissions opens the permission menu", async () => {
    const m = await mountComposer();
    const el = textarea(m);
    await m.type(el, "/permissions");
    await caretToEnd(m);
    await m.press(el, "Enter");
    assert.equal(textarea(m).value, "");
    assert.ok(
      m.query('[aria-label="Permission mode"]'),
      "permission menu opened",
    );
  });

  it("lists CLI skill extras after the built-in verbs", async () => {
    const m = await mount(
      <Composer
        threadId="t1"
        branch="agentmux/abc"
        permissionMode="default"
        onPermissionModeChange={() => {}}
        provider="claude"
        model={null}
        reasoningEffort={null}
        providers={PROVIDERS}
        workflows={[]}
        onSetProvider={() => {}}
        onSetReasoningEffort={() => {}}
        onSaveWorkflow={async (t) => ({
          id: "saved",
          name: t.name,
          builtin: false,
          phases: t.phases,
        })}
        onRemoveWorkflow={async () => {}}
        sessionId={null}
        hasWorktree={true}
        onSend={() => {}}
        onBuild={() => {}}
        cliCommands={[
          {
            name: "/imagine",
            hint: "Generate an image",
            kind: "insert",
          },
        ]}
      />,
    );
    const el = textarea(m);
    await m.type(el, "/im");
    await caretToEnd(m);
    assert.ok(commandList(m), "popup open after /im");
    assert.ok(m.byText("/imagine"), "skill extra listed");
    assert.equal(m.byText("/compact"), null, "compact filtered out");
  });

  it("unknown /foo never opens the popup so a send still goes to the model", async () => {
    const sends: string[] = [];
    const m = await mountComposer((prompt) => sends.push(prompt));
    const el = textarea(m);
    await m.type(el, "/foo");
    await caretToEnd(m);
    assert.equal(commandList(m), null);
    await m.press(el, "Enter", { metaKey: true });
    assert.deepEqual(sends, ["/foo"]);
  });

  it("Escape closes the popup and keeps the text", async () => {
    const m = await mountComposer();
    const el = textarea(m);
    await m.type(el, "/co");
    await caretToEnd(m);
    assert.ok(commandList(m));
    await m.press(el, "Escape");
    assert.ok(!commandList(m), "popup closed after Escape");
    assert.equal(textarea(m).value, "/co");
  });

  it("does not open when / is not at the start of the text", async () => {
    const m = await mountComposer();
    const el = textarea(m);
    await m.type(el, "see src/foo");
    await caretToEnd(m);
    assert.equal(commandList(m), null);
    assert.equal(m.byText("/handoff"), null);
  });

  it("scrolls the command list without moving ancestor scrollports (#762)", async () => {
    // 16 rows in a 240px box. scrollIntoView would walk up to .chatSlot
    // and lift the composer.
    const m = await mountComposer();
    const el = textarea(m);
    await m.type(el, "/");
    await caretToEnd(m);
    const list = commandList(m) as HTMLElement | null;
    assert.ok(list, "popup open after /");

    Object.defineProperty(list, "clientHeight", {
      configurable: true,
      value: 240,
    });
    list.querySelectorAll<HTMLElement>("button").forEach((row, i) => {
      Object.defineProperty(row, "offsetTop", {
        configurable: true,
        value: i * 40,
      });
      Object.defineProperty(row, "offsetHeight", {
        configurable: true,
        value: 40,
      });
    });

    let intoView = 0;
    const proto = (m.query('[data-highlighted="true"]') as HTMLElement)
      .constructor.prototype as { scrollIntoView: () => void };
    const original = proto.scrollIntoView;
    proto.scrollIntoView = function patched() {
      intoView += 1;
    };
    try {
      for (let i = 0; i < 8; i++) await m.press(el, "ArrowDown");
    } finally {
      proto.scrollIntoView = original;
    }
    assert.equal(intoView, 0, "scrollIntoView scrolls chatSlot");
    assert.ok(list.scrollTop > 0, "the command list itself must scroll");
  });
});
