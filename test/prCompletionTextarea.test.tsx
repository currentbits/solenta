import assert from "node:assert/strict";
import { it } from "node:test";
import * as React from "react";
import { act } from "react";
import { mount } from "./support/dom";
import { PrCompletionTextarea, prCompletionToken } from "../src/components/PrCompletionTextarea";

it("recognizes only caret-local references outside literal markdown, email and URLs", () => {
  for (const value of ["a@bob", "https://host/#12", "`@bob", "```js\n@bob", "~~~\n#12"]) assert.equal(prCompletionToken(value, value.length, value.length), null);
  for (const kind of ["@", "#", "!"]) assert.equal(prCompletionToken(`before ${kind}abc`, 11, 11)?.kind, kind);
  assert.equal(prCompletionToken("@bob", 1, 3), null);
});

it("inserts at the caret and consumes Enter without submitting", async () => {
  let submitted = 0;
  function Editor() {
    const [value, setValue] = React.useState("hello @bo tail");
    return <form onSubmit={e => { e.preventDefault(); submitted++; }}><PrCompletionTextarea
      value={value} onChange={e => setValue(e.target.value)} projectPath="/repo" scope="1"
      lookup={async () => ({ ok: true, items: [{ value: "@bob", label: "Bob" }], hasMore: false })} /></form>;
  }
  const m = await mount(<Editor />);
  const input = m.query("textarea") as HTMLTextAreaElement;
  await act(async () => { input.setSelectionRange(9, 9); input.focus(); });
  await act(async () => { await new Promise(r => setTimeout(r, 300)); });
  assert.ok(m.query('[role="option"]'));
  await m.press(input, "Enter");
  assert.equal(input.value, "hello @bob tail");
  assert.equal(submitted, 0);
});

it("ignores a lookup resolving after repository selection changes", async () => {
  let resolve!: (v: any) => void;
  const lookup = () => new Promise<any>(r => { resolve = r; });
  const props = { value: "#1", onChange: () => {}, projectPath: "/repo", scope: "1", lookup };
  const m = await mount(<PrCompletionTextarea {...props} />);
  const input = m.query("textarea") as HTMLTextAreaElement;
  await act(async () => { input.setSelectionRange(2, 2); input.focus(); });
  await act(async () => { await new Promise(r => setTimeout(r, 300)); });
  await m.rerender(<PrCompletionTextarea {...props} repo="other/repo" scope="2" />);
  await act(async () => { resolve({ ok: true, items: [{ value: "#1", label: "private old repo" }], hasMore: false }); });
  assert.equal(m.query('[role="option"]'), null);
});

it("completes GitLab MR notation with Tab and Escape preserves literal input", async () => {
  const calls: string[] = [];
  function Editor() {
    const [value, setValue] = React.useState("!7");
    return <PrCompletionTextarea value={value} onChange={e => setValue(e.target.value)} projectPath="/gitlab" scope="7"
      lookup={async input => { calls.push(input.kind); return { ok: true, items: [{ value: "!72", label: "Merge request" }], hasMore: false }; }} />;
  }
  const m = await mount(<Editor />);
  const input = m.query("textarea") as HTMLTextAreaElement;
  await act(async () => { input.setSelectionRange(2, 2); input.focus(); });
  await act(async () => { await new Promise(r => setTimeout(r, 300)); });
  await m.press(input, "Escape");
  assert.equal(input.value, "!7");
  assert.equal(m.query('[role="listbox"]'), null);
  await m.type(input, "!72");
  await act(async () => { await new Promise(r => setTimeout(r, 300)); });
  await m.press(input, "Tab");
  assert.equal(input.value, "!72 ");
  assert.deepEqual(calls, ["!", "!"]);
});

it("offers GitLab completions in the actual description and comment editors without posting", async () => {
  const { PrWorkspacePanel } = await import("../src/components/PrWorkspacePanel");
  const shell = await mount(<div />);
  const previous = window.coder;
  const lookups: string[] = [];
  window.coder = { git: { prCompletions: async input => {
    lookups.push(input.kind);
    return { ok: true, items: [{ value: "!72", label: "MR" }], hasMore: false };
  } } } as any;
  shell.unmount();
  try {
    const pr = { forge: "gitlab" as const, number: 7, title: "MR", body: "", url: "https://gitlab.example/team/repo/-/merge_requests/7", state: "OPEN" as const, isDraft: false, headRefName: "feature", comments: [] };
    const detail = async () => ({ ok: true as const, pr });
    let posted = 0;
    const m = await mount(<PrWorkspacePanel projectPath="/gitlab" prNumber={7} matchedThread={null}
      prDetail={detail} prEdit={detail} prClose={detail} prReady={detail} prMergeAt={detail}
      prComment={async () => { posted++; return { ok: true }; }} onClose={() => {}} onSelectThread={() => {}} />);
    for (const selector of ["[data-pr-edit-body]", "[data-pr-comment]"]) {
      const input = m.query(selector) as HTMLTextAreaElement;
      await act(async () => input.focus());
      await m.type(input, "!7");
      await act(async () => { await new Promise(r => setTimeout(r, 300)); });
      await m.press(input, "Enter");
      assert.equal(input.value, "!72 ");
    }
    assert.equal(posted, 0);
    assert.deepEqual(lookups, ["!", "!"]);
    assert.equal((m.query('[data-pr-merge]') as HTMLButtonElement).disabled, true);
    assert.equal(m.query('[data-pr-draft]'), null);
  } finally { window.coder = previous; }
});

it("drops rapid typing responses and supports arrow selection at a mid-token caret", async () => {
  const pending: Array<(result: any) => void> = [];
  const lookup = () => new Promise<any>(resolve => pending.push(resolve));
  function Editor() {
    const [value, setValue] = React.useState("@a");
    return <PrCompletionTextarea value={value} onChange={e => setValue(e.target.value)} projectPath="/repo" scope="1" lookup={lookup} />;
  }
  const m = await mount(<Editor />);
  const input = m.query("textarea") as HTMLTextAreaElement;
  await act(async () => { input.setSelectionRange(2, 2); input.focus(); });
  await act(async () => { await new Promise(r => setTimeout(r, 300)); });
  await m.type(input, "@ab");
  await act(async () => { await new Promise(r => setTimeout(r, 300)); });
  await act(async () => pending[0]({ ok: true, items: [{ value: "@ancient", label: "Old" }], hasMore: false }));
  assert.equal(m.query('[role="option"]'), null);
  await act(async () => pending[1]({ ok: true, items: [{ value: "@abel", label: "First" }, { value: "@abby", label: "Second" }], hasMore: false }));
  await m.press(input, "ArrowDown");
  await m.press(input, "Tab");
  assert.equal(input.value, "@abby ");
  assert.equal(prCompletionToken("@abby tail", 2, 2)?.end, 5);
});

it("keeps native editing keys available while suggestions are pending, empty or failed", async () => {
  for (const state of ["pending", "empty", "error"] as const) {
    let submitted = 0;
    const lookup = async () => state === "pending" ? new Promise<any>(() => {})
      : state === "empty" ? { ok: true as const, items: [], hasMore: false }
      : { ok: false as const, reason: "Search denied" };
    const m = await mount(<form onSubmit={e => { e.preventDefault(); submitted++; }}>
      <PrCompletionTextarea value="@missing" onChange={() => {}} projectPath="/repo" scope={state} lookup={lookup} />
      <button type="submit">Post</button>
    </form>);
    const input = m.query("textarea") as HTMLTextAreaElement;
    await act(async () => { input.setSelectionRange(8, 8); input.focus(); });
    await act(async () => { await new Promise(r => setTimeout(r, 300)); });
    assert.ok(m.query('[role="listbox"]'));
    assert.equal(m.query('[role="option"]'), null);
    for (const key of ["Enter", "ArrowUp", "ArrowDown", "Tab"]) {
      const event = new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      await act(async () => { input.dispatchEvent(event); });
      assert.equal(event.defaultPrevented, false, `${state}: ${key} retains native editing intent`);
    }
    assert.equal(submitted, 0);
    await m.press(input, "Escape");
    assert.equal(m.query('[role="listbox"]'), null);
    m.unmount();
  }
});

it("preserves modified editing shortcuts even with selectable suggestions", async () => {
  let submitted = 0;
  const m = await mount(<form onSubmit={e => { e.preventDefault(); submitted++; }}>
    <PrCompletionTextarea value="@bo" onChange={() => assert.fail("shortcut must not insert a completion")}
      projectPath="/repo" scope="1" lookup={async () => ({ ok: true, items: [{ value: "@bob", label: "Bob" }], hasMore: false })} />
  </form>);
  const input = m.query("textarea") as HTMLTextAreaElement;
  await act(async () => { input.setSelectionRange(3, 3); input.focus(); });
  await act(async () => { await new Promise(r => setTimeout(r, 300)); });
  assert.ok(m.query('[role="option"]'));
  for (const modifier of ["shiftKey", "ctrlKey", "altKey", "metaKey"]) {
    for (const key of ["Enter", "ArrowUp", "ArrowDown", "Tab", "PageDown"]) {
      const event = new window.KeyboardEvent("keydown", { key, [modifier]: true, bubbles: true, cancelable: true });
      await act(async () => { input.dispatchEvent(event); });
      assert.equal(event.defaultPrevented, false, `${modifier}+${key} remains native`);
    }
  }
  assert.equal(submitted, 0);
  assert.equal(input.value, "@bo");
});
