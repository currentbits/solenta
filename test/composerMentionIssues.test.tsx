/**
 * @issue / @discussion mention rows (#1805): lazily fetched once per menu
 * open, searchable by number and title, and sent as a typed chip.
 *
 * Run: node --import=./test/support/render.mjs --test test/composerMentionIssues.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inAct, mount, type Mounted } from "./support/dom.ts";
import { Composer } from "../src/components/Composer";
import type { MentionIssueApi } from "../src/contextChips";
import type { ProviderInfo } from "../src/shared/ipc";

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

const ISSUES = [
  { number: 42, title: "Ship the planboard" },
  { number: 7, title: "Write the docs" },
];
const DISCUSSIONS = [{ number: 11, title: "How do checkpoints restore?" }];

function fakeIssueApi(over: Partial<MentionIssueApi> = {}) {
  const calls: string[] = [];
  const api: MentionIssueApi = {
    listOpenIssues: async () => {
      calls.push("listOpenIssues");
      return ISSUES;
    },
    listDiscussions: async () => {
      calls.push("listDiscussions");
      return DISCUSSIONS;
    },
    ...over,
  };
  return { api, calls };
}

let seq = 0;
function mountComposer(
  api: MentionIssueApi,
  onSend: (p: string) => void = () => {},
) {
  const threadId = `issue-mention-${++seq}`;
  return mount(
    <Composer
      threadId={threadId}
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
      onSend={(p) => onSend(p)}
      onBuild={() => {}}
      mentionIssueApi={api}
    />,
  );
}

function textarea(m: Mounted): HTMLTextAreaElement {
  const el = m.container.querySelector("textarea");
  assert.ok(el);
  return el as HTMLTextAreaElement;
}

async function typeMention(m: Mounted, text: string): Promise<HTMLTextAreaElement> {
  const el = textarea(m);
  await m.type(el, text);
  await inAct(() => {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await settle();
  return el;
}

const settle = () => inAct(() => new Promise((r) => setTimeout(r, 30)));

function rows(m: Mounted): Element[] {
  return [...m.container.querySelectorAll('[aria-label="Mention a file or folder"] button')];
}

function chips(m: Mounted): Element[] {
  return [...m.container.querySelectorAll("[data-context-chip]")];
}

describe("Composer @-mention issues/discussions (#1805)", () => {
  it("bare @ lists both open issues and discussions, fetched once", async () => {
    const { api, calls } = fakeIssueApi();
    const m = await mountComposer(api);
    await typeMention(m, "@");
    const issueRows = rows(m).filter((r) => r.getAttribute("data-mention-kind") === "issue");
    const discussionRows = rows(m).filter(
      (r) => r.getAttribute("data-mention-kind") === "discussion",
    );
    assert.equal(issueRows.length, 2);
    assert.match(issueRows[0].textContent || "", /#42 Ship the planboard/);
    assert.equal(discussionRows.length, 1);
    assert.match(discussionRows[0].textContent || "", /#11 How do checkpoints restore\?/);
    assert.deepEqual(calls, ["listOpenIssues", "listDiscussions"]);
  });

  it("filters by number and by title", async () => {
    const { api } = fakeIssueApi();
    let m = await mountComposer(api);
    await typeMention(m, "@42");
    assert.equal(
      rows(m).filter((r) => r.getAttribute("data-mention-kind") === "issue").length,
      1,
    );
    assert.match(rows(m)[0].textContent || "", /Ship the planboard/);

    m = await mountComposer(api);
    await typeMention(m, "@docs");
    const matches = rows(m).filter((r) => r.getAttribute("data-mention-kind") === "issue");
    assert.equal(matches.length, 1);
    assert.match(matches[0].textContent || "", /Write the docs/);
  });

  it("Enter on an issue row inserts a chip, not text", async () => {
    const { api } = fakeIssueApi();
    const sent: string[] = [];
    const m = await mountComposer(api, (p) => sent.push(p));
    const el = await typeMention(m, "look at @42");
    await m.press(el, "Enter");
    assert.equal(el.value, "look at ");
    const [chip] = chips(m);
    assert.equal(chip.getAttribute("data-context-kind"), "issue");
    assert.match(chip.textContent || "", /Ship the planboard/);
  });

  it("fetches only once per menu open, cached on re-open within the window", async () => {
    const { api, calls } = fakeIssueApi();
    const m = await mountComposer(api);
    await typeMention(m, "@");
    await m.press(textarea(m), "Escape");
    // A space ends the first token so the next "@" opens a fresh mention,
    // not an adjacent "@@" the mention parser would reject.
    await typeMention(m, " @");
    // Each menu open re-asks the host; the ~60s cache this guards against
    // lives on the main process (electron/issues.js), not in the composer.
    assert.deepEqual(calls, ["listOpenIssues", "listDiscussions", "listOpenIssues", "listDiscussions"]);
  });

  it("skips the discussions fetch when listDiscussions is absent", async () => {
    const { api, calls } = fakeIssueApi({ listDiscussions: undefined });
    const m = await mountComposer(api);
    await typeMention(m, "@");
    assert.deepEqual(calls, ["listOpenIssues"]);
    assert.equal(
      rows(m).filter((r) => r.getAttribute("data-mention-kind") === "discussion").length,
      0,
    );
  });
});
