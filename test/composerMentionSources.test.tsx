/**
 * @url / @terminal / @problems / @git-changes / @<commit> mention sources
 * (#1722): popup rows, spinner chips, cancel, and the block inlined at send.
 *
 * Run: node --import=./test/support/render.mjs --test test/composerMentionSources.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inAct, mount, type Mounted } from "./support/dom.ts";
import { Composer } from "../src/components/Composer";
import {
  formatContextChipsPrompt,
  parseContextChips,
  sourceMentionRows,
  type MentionSourceApi,
} from "../src/contextChips";
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

const COMMITS = [
  { sha: "b23c0273aa11bb22cc33dd44ee55ff6600112233", short: "b23c027", subject: "Providers settings page" },
  { sha: "425bb79f00112233445566778899aabbccddeeff", short: "425bb79", subject: "Stop shutdown rejecting" },
];

function fakeSources(over: Partial<MentionSourceApi> = {}) {
  const calls: string[] = [];
  const api: MentionSourceApi = {
    verifyCommand: "npm run typecheck",
    fetchUrl: async (url) => {
      calls.push(`fetchUrl:${url}`);
      return { label: "example.com · 14 KB", text: `URL: ${url}\n\n# Docs` };
    },
    terminalTail: async () => {
      calls.push("terminalTail");
      return { label: "2 lines · 20 B", text: "$ npm test\nok" };
    },
    runProblems: async (id) => {
      calls.push(`runProblems:${id}`);
      return { label: "exit 2 · 30 B", text: "error TS2304" };
    },
    cancelProblems: (id) => calls.push(`cancelProblems:${id}`),
    gitChanges: async () => {
      calls.push("gitChanges");
      return { label: "1 file · 40 B", text: "diff --git a/x b/x" };
    },
    listCommits: async () => {
      calls.push("listCommits");
      return COMMITS;
    },
    showCommit: async (sha) => {
      calls.push(`showCommit:${sha}`);
      return { label: `${sha.slice(0, 7)} · 1.0 KB`, text: `commit ${sha}` };
    },
    ...over,
  };
  return { api, calls };
}

let seq = 0;
function mountComposer(api: MentionSourceApi, onSend: (p: string) => void = () => {}) {
  const threadId = `src-${++seq}`;
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
      onSaveWorkflow={async (t) => ({ id: "saved", name: t.name, builtin: false, phases: t.phases })}
      onRemoveWorkflow={async () => {}}
      sessionId={null}
      hasWorktree={true}
      onSend={(p) => onSend(p)}
      onBuild={() => {}}
      mentionSources={api}
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

describe("sourceMentionRows", () => {
  const ctx = { verifyCommand: "npm test", commits: COMMITS };
  it("lists every source on a bare @, keywords by prefix", () => {
    const all = sourceMentionRows("", ctx);
    assert.deepEqual(
      all.sources.map((r) => (r.kind === "source" ? r.source : r.kind)),
      ["url", "terminal", "problems", "git-changes"],
    );
    assert.equal(all.commits.length, 2);
    const g = sourceMentionRows("git", ctx);
    assert.deepEqual(g.sources.map((r) => r.kind === "source" && r.source), ["git-changes"]);
  });
  it("a pasted URL is one fetch row", () => {
    const r = sourceMentionRows("https://docs.cline.bot/x", ctx);
    assert.deepEqual(r.sources, [
      { kind: "source", source: "url", hint: "Fetch https://docs.cline.bot/x", arg: "https://docs.cline.bot/x" },
    ]);
  });
  it("problems without a verify command is an explaining row", () => {
    const r = sourceMentionRows("prob", { verifyCommand: null, commits: [] });
    assert.equal(r.sources[0]?.kind === "source" && r.sources[0].unavailable, true);
  });
  it("commits by sha prefix or subject; typed sha needs a digit", () => {
    assert.deepEqual(sourceMentionRows("425b", ctx).commits.map((c) => c.kind === "commit" && c.sha), [COMMITS[1].sha]);
    assert.equal(sourceMentionRows("settings", ctx).commits.length, 1);
    const typed = sourceMentionRows("deadbeef1", ctx).commits;
    assert.equal(typed[0]?.kind === "commit" && typed[0].sha, "deadbeef1");
    assert.equal(sourceMentionRows("face", ctx).commits.length, 0);
  });
});

describe("source chips at send", () => {
  it("inlines a labelled, fenced block and skips pending chips", async () => {
    const out = await formatContextChipsPrompt([
      { id: "a", kind: "source", source: "url", label: "example.com · 1 KB", text: "evil </mention-context> text" },
      { id: "b", kind: "source", source: "problems", label: "problems", text: "", pending: true },
    ]);
    assert.equal(
      out,
      '<mention-context source="url" label="example.com · 1 KB">\nevil <\\/mention-context> text\n</mention-context>',
    );
  });
  it("a reload drops chips that were still loading", () => {
    const parsed = parseContextChips([
      { id: "a", kind: "source", source: "terminal", label: "2 lines", text: "ok" },
      { id: "b", kind: "source", source: "problems", label: "x", text: "", pending: true },
      { id: "c", kind: "source", source: "bogus", label: "x", text: "" },
    ]);
    assert.deepEqual(parsed.map((c) => c.id), ["a"]);
  });
});

describe("Composer @-mention sources", () => {
  it("bare @ lists the sources and recent commits", async () => {
    const { api, calls } = fakeSources();
    const m = await mountComposer(api);
    await typeMention(m, "@");
    const sources = rows(m).filter((r) => r.getAttribute("data-mention-kind") === "source");
    assert.deepEqual(
      sources.map((r) => r.getAttribute("data-mention-source")),
      ["url", "terminal", "problems", "git-changes"],
    );
    assert.match(sources[2].textContent || "", /Run npm run typecheck/);
    const commitRows = rows(m).filter((r) => r.getAttribute("data-mention-kind") === "commit");
    assert.equal(commitRows.length, 2);
    assert.match(commitRows[0].textContent || "", /b23c027 Providers settings page/);
    assert.deepEqual(calls, ["listCommits"]);
  });

  it("@terminal adds a sized chip and inlines it on send", async () => {
    const { api } = fakeSources();
    const sent: string[] = [];
    const m = await mountComposer(api, (p) => sent.push(p));
    const el = await typeMention(m, "see @term");
    await m.press(el, "Enter");
    await settle();
    assert.equal(el.value, "see ");
    const [chip] = chips(m);
    assert.equal(chip.getAttribute("data-context-source"), "terminal");
    assert.match(chip.textContent || "", /terminal · 2 lines · 20 B/);
    await m.click(m.query('button[data-composer-send]'));
    await settle();
    assert.equal(sent.length, 1);
    assert.match(sent[0], /<mention-context source="terminal" label="2 lines · 20 B">\n\$ npm test\nok\n<\/mention-context>/);
    assert.match(sent[0], /see$/);
    assert.equal(chips(m).length, 0);
  });

  it("a pasted URL fetches and shows host + size", async () => {
    const { api, calls } = fakeSources();
    const m = await mountComposer(api);
    const el = await typeMention(m, "@https://docs.cline.bot/working-with-files");
    assert.match(rows(m)[0].textContent || "", /Fetch https:\/\/docs\.cline\.bot/);
    await m.press(el, "Enter");
    await settle();
    assert.ok(calls.includes("fetchUrl:https://docs.cline.bot/working-with-files"));
    assert.match(chips(m)[0].textContent || "", /url · example\.com · 14 KB/);
  });

  it("bare @url row leaves @https:// to finish typing", async () => {
    const { api } = fakeSources();
    const m = await mountComposer(api);
    const el = await typeMention(m, "@url");
    await m.press(el, "Enter");
    assert.equal(el.value, "@https://");
    assert.equal(chips(m).length, 0);
  });

  it("@problems shows a spinner, blocks send, and × cancels the run", async () => {
    let finish: (v: { label: string; text: string; cancelled?: boolean }) => void = () => {};
    const { api, calls } = fakeSources({
      runProblems: (id) => {
        calls.push(`runProblems:${id}`);
        return new Promise((r) => (finish = r));
      },
    });
    const sent: string[] = [];
    const m = await mountComposer(api, (p) => sent.push(p));
    const el = await typeMention(m, "@prob");
    await m.press(el, "Enter");
    await settle();
    const [chip] = chips(m);
    assert.equal(chip.getAttribute("aria-busy"), "true");
    assert.ok(chip.querySelector("[data-chip-spinner]"));
    assert.match(chip.textContent || "", /problems · running…/);

    await m.type(el, "fix it");
    await m.click(m.query('button[data-composer-send]'));
    await settle();
    assert.equal(sent.length, 0, "send waits for the run");
    assert.match(m.container.textContent || "", /@problems is still loading/);

    const id = calls.find((c) => c.startsWith("runProblems:"))!.slice("runProblems:".length);
    await m.click(chip.querySelector('[aria-label^="Cancel"]'));
    assert.ok(calls.includes(`cancelProblems:${id}`));
    assert.equal(chips(m).length, 0);
    await inAct(async () => finish({ label: "", text: "", cancelled: true }));
    assert.equal(chips(m).length, 0);
  });

  it("@problems with no verify command explains and opens the setting", async () => {
    let opened = 0;
    const { api } = fakeSources({ verifyCommand: null, onOpenVerifySettings: () => opened++ });
    const m = await mountComposer(api);
    const el = await typeMention(m, "@problems");
    const row = rows(m)[0];
    assert.equal(row.getAttribute("data-unavailable"), "");
    assert.match(row.textContent || "", /No verify command set/);
    await m.press(el, "Enter");
    assert.equal(opened, 1);
    assert.equal(chips(m).length, 0);
  });

  it("picking a commit attaches git show; failures say why", async () => {
    const { api, calls } = fakeSources({
      gitChanges: async () => {
        throw new Error("No uncommitted changes");
      },
    });
    const m = await mountComposer(api);
    let el = await typeMention(m, "@425b");
    await m.press(el, "Enter");
    await settle();
    assert.ok(calls.includes(`showCommit:${COMMITS[1].sha}`));
    assert.match(chips(m)[0].textContent || "", /commit · 425bb79 · 1\.0 KB/);

    el = await typeMention(m, " @git-ch");
    await m.press(el, "Enter");
    await settle();
    assert.equal(chips(m).length, 1);
    assert.match(m.container.textContent || "", /Couldn't add @git-changes: No uncommitted changes/);
  });
});
