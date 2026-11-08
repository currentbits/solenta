import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { mount } from "./support/dom.ts";
import { PrWorkspacePanel } from "../src/components/PrWorkspacePanel";
import { MarkdownBody } from "../src/components/Markdown";
import type { PrDetail, PrDetailResult } from "../src/shared/ipc";
const pr = { number: 11, title: "Feature", body: "- [ ] task\n", url: "https://github.com/acme/repo/pull/11", state: "OPEN", isDraft: false, comments: [] } as unknown as PrDetail;
const ok = (p: PrDetail): PrDetailResult => ({ ok: true, pr: p });
const defaults = {
  projectPath: "/tmp/repo", prNumber: 11, matchedThread: null,
  prDetail: async () => ok(pr), prEdit: async () => ok(pr),
  prComment: async () => ({ ok: true as const, url: pr.url }),
  prClose: async () => ok(pr), prReady: async () => ok(pr), prMergeAt: async () => ok(pr),
  onSelectThread: () => {}, onClose: () => {},
};
const checkbox = 'input[type="checkbox"]';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }

describe("rendered PR description checklists", () => {
  it("loads and toggles in the application's StrictMode", async () => {
    let server = pr;
    const m = await mount(<React.StrictMode><PrWorkspacePanel {...defaults} prDetail={async () => ok(server)}
      prEdit={async (input) => { server = { ...server, body: input.body! }; return ok(server); }} /></React.StrictMode>);
    await m.click(m.query('[data-pr-preview]'));
    await m.click(m.query(checkbox));
    assert.equal(server.body, "- [x] task\n");
    m.unmount();
  });
  it("keeps ordinary markdown and code fences inert", async () => {
    const m = await mount(<MarkdownBody text={'- [ ] task\n\n```\n- [ ] fake\n```'} />);
    assert.equal(m.queryAll(checkbox).length, 1);
    assert.equal((m.query(checkbox) as HTMLInputElement).disabled, true);
    m.unmount();
  });
  it("patches the latest body without sending a stale title and prevents overlapping clicks", async () => {
    const read = deferred<PrDetailResult>();
    let reads = 0;
    let server = pr;
    const writes: unknown[] = [];
    const m = await mount(<PrWorkspacePanel {...defaults}
      prDetail={async () => ++reads === 1 ? ok(pr) : reads === 2 ? read.promise : ok(server)}
      prEdit={async (input) => { writes.push(input); server = { ...pr, title: "Remote title", body: input.body! }; return ok(server); }} />);
    await m.click(m.query('[data-pr-preview]'));
    await m.click(m.query(checkbox));
    await m.click(m.query(checkbox));
    assert.equal(reads, 2);
    assert.equal((m.query(checkbox) as HTMLInputElement).disabled, true);
    read.resolve(ok({ ...pr, body: "Remote intro\n\n" + pr.body, title: "Remote title" }));
    await m.flush();
    assert.deepEqual(writes, [{ projectPath: "/tmp/repo", prNumber: 11, body: "Remote intro\n\n- [x] task\n" }]);
    assert.equal((m.query(checkbox) as HTMLInputElement).checked, true);
    await m.click(m.query(checkbox));
    await m.flush();
    assert.equal(writes.length, 2, "a later click can start after completion");
    m.unmount();
  });
  it("maps loose task paragraphs and nested duplicate labels to their own markers", async () => {
    let server = { ...pr, body: "- [ ] same\n\n  Paragraph two.\n\n  - [ ] same\n\n- [X] final\n" };
    const m = await mount(<PrWorkspacePanel {...defaults} prDetail={async () => ok(server)}
      prEdit={async (input) => { server = { ...server, body: input.body! }; return ok(server); }} />);
    await m.click(m.query('[data-pr-preview]'));
    assert.equal(m.queryAll(checkbox).length, 3);
    assert.equal((m.queryAll(checkbox)[0] as HTMLInputElement).disabled, false);
    assert.match(m.queryAll(checkbox)[0].getAttribute("aria-label")!, /same/);
    await m.click(m.queryAll(checkbox)[1]);
    assert.equal(server.body, "- [ ] same\n\n  Paragraph two.\n\n  - [x] same\n\n- [X] final\n");
    await m.click(m.queryAll(checkbox)[0]);
    assert.equal(server.body, "- [x] same\n\n  Paragraph two.\n\n  - [x] same\n\n- [X] final\n");
    m.unmount();
  });
  it("keeps closed and merged descriptions read-only like the existing description editor", async () => {
    for (const state of ["CLOSED", "MERGED"] as const) {
      let writes = 0;
      const m = await mount(<PrWorkspacePanel {...defaults} prDetail={async () => ok({ ...pr, state })}
        prEdit={async () => { writes++; return ok(pr); }} />);
      await m.click(m.query('[data-pr-preview]'));
      assert.equal((m.query(checkbox) as HTMLInputElement).disabled, true);
      await m.click(m.query(checkbox));
      assert.equal(writes, 0);
      m.unmount();
    }
  });
  it("surfaces forbidden writes without changing the body", async () => {
    const m = await mount(<PrWorkspacePanel {...defaults} prEdit={async () => ({ ok: false, reason: "Forbidden" })} />);
    await m.click(m.query('[data-pr-preview]'));
    await m.click(m.query(checkbox));
    assert.match(m.text(), /Forbidden/);
    assert.equal((m.query(checkbox) as HTMLInputElement).checked, false);
    assert.equal((m.query(checkbox) as HTMLInputElement).disabled, false);
    m.unmount();
  });
  it("preserves unsaved description and title drafts by disabling toggles", async () => {
    let writes = 0;
    const m = await mount(<PrWorkspacePanel {...defaults} prEdit={async () => { writes++; return ok(pr); }} />);
    await m.type(m.query('[data-pr-edit-body]'), "- [ ] unsaved\n");
    await m.type(m.query('[data-pr-edit-title]'), "Draft title");
    await m.click(m.query('[data-pr-preview]'));
    assert.equal((m.query(checkbox) as HTMLInputElement).disabled, true);
    await m.click(m.query(checkbox));
    assert.equal(writes, 0);
    await m.click(m.query('[data-pr-preview]'));
    assert.equal((m.query('[data-pr-edit-body]') as HTMLTextAreaElement).value, "- [ ] unsaved\n");
    assert.equal((m.query('[data-pr-edit-title]') as HTMLInputElement).value, "Draft title");
    m.unmount();
  });
  it("requires reload on a conflicting server edit", async () => {
    let reads = 0, writes = 0;
    const m = await mount(<PrWorkspacePanel {...defaults}
      prDetail={async () => ok(++reads === 1 ? pr : { ...pr, body: "- [ ] different\n" })}
      prEdit={async () => { writes++; return ok(pr); }} />);
    await m.click(m.query('[data-pr-preview]'));
    await m.click(m.query(checkbox));
    assert.equal(writes, 0);
    assert.match(m.text(), /Reload the pull request/);
    assert.equal((m.query(checkbox) as HTMLInputElement).checked, false);
    await m.click(m.query("[data-pr-checklist-reload]"));
    assert.match(m.text(), /different/);
    assert.equal(m.query("[data-pr-workspace-error]"), null);
    m.unmount();
  });
  it("ignores a stale fetch after switching project and PR", async () => {
    let reads = 0, writes = 0;
    const read = deferred<PrDetailResult>();
    const props = { ...defaults, prDetail: async () => ++reads === 1 ? ok(pr) : read.promise, prEdit: async () => { writes++; return ok(pr); } };
    const m = await mount(<PrWorkspacePanel {...props} />);
    await m.click(m.query('[data-pr-preview]'));
    await m.click(m.query(checkbox));
    const next = { ...pr, number: 22, url: "https://github.com/other/repo/pull/22", body: "- [ ] next\n" };
    await m.rerender(<PrWorkspacePanel {...props} projectPath="/tmp/other" prNumber={22} prDetail={async () => ok(next)} />);
    read.resolve(ok(pr)); await m.flush();
    assert.equal(writes, 0);
    assert.match(m.text(), /next/);
    assert.equal((m.query(checkbox) as HTMLInputElement).checked, false);
    m.unmount();
  });
  it("ignores a stale save response after a PR switch", async () => {
    const save = deferred<PrDetailResult>();
    const m = await mount(<PrWorkspacePanel {...defaults} prEdit={async () => save.promise} />);
    await m.click(m.query('[data-pr-preview]'));
    await m.click(m.query(checkbox));
    const next = { ...pr, number: 22, url: "https://github.com/acme/repo/pull/22", body: "- [ ] next\n" };
    await m.rerender(<PrWorkspacePanel {...defaults} prNumber={22} prDetail={async () => ok(next)} />);
    save.resolve(ok({ ...pr, body: "- [x] task\n" })); await m.flush();
    assert.match(m.text(), /next/);
    assert.equal((m.query(checkbox) as HTMLInputElement).checked, false);
    m.unmount();
  });
});
