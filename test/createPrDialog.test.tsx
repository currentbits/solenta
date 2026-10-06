/**
 * Create-PR composer: draft, template seed, preview.
 * Run: npm run test:renderer -- --test-name-pattern createPrDialog
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { mount } from "./support/dom.ts";
import { CreatePrDialog } from "../src/components/CreatePrDialog";
import type { PrTemplateResult } from "../src/shared/ipc";

function q(m: { container: HTMLElement }, sel: string): Element | null {
  return (
    m.container.querySelector(sel) ??
    m.container.ownerDocument.body.querySelector(sel)
  );
}

describe("CreatePrDialog", () => {
  it("submits title, body, and draft", async () => {
    const submitted: Array<{ title: string; body: string; draft: boolean }> = [];
    const m = await mount(
      <CreatePrDialog
        initialTitle="Ship feature"
        pending={false}
        onSubmit={(input) => submitted.push(input)}
        onClose={() => {}}
      />,
    );
    const title = q(m,"[data-create-pr-title]") as HTMLInputElement;
    const body = q(m,"[data-create-pr-body]") as HTMLTextAreaElement;
    assert.equal(title.value, "Ship feature");
    await m.type(body, "## What\n\nChanged the thing.");
    await m.click(q(m,"[data-create-pr-draft]"));
    await m.click(q(m,"[data-create-pr-submit]"));
    assert.deepEqual(submitted, [
      {
        title: "Ship feature",
        body: "## What\n\nChanged the thing.",
        draft: true,
      },
    ]);
    m.unmount();
  });

  it("seeds the body from the repo template", async () => {
    const loadTemplate = async (): Promise<PrTemplateResult> => ({
      ok: true,
      body: "## Summary\n",
      path: "/tmp/.github/PULL_REQUEST_TEMPLATE.md",
      templates: [
        {
          name: "Default",
          path: "/tmp/.github/PULL_REQUEST_TEMPLATE.md",
          body: "## Summary\n",
        },
      ],
    });
    const m = await mount(
      <CreatePrDialog
        initialTitle="x"
        loadTemplate={loadTemplate}
        pending={false}
        onSubmit={() => {}}
        onClose={() => {}}
      />,
    );
    await m.flush();
    const body = q(m,"[data-create-pr-body]") as HTMLTextAreaElement;
    assert.equal(body.value, "## Summary\n");
    m.unmount();
  });

  it("switches among multiple templates", async () => {
    const loadTemplate = async (): Promise<PrTemplateResult> => ({
      ok: true,
      body: "default body",
      path: "/tmp/default.md",
      templates: [
        { name: "Default", path: "/tmp/default.md", body: "default body" },
        { name: "bug", path: "/tmp/bug.md", body: "bug body" },
      ],
    });
    const m = await mount(
      <CreatePrDialog
        initialTitle="x"
        loadTemplate={loadTemplate}
        pending={false}
        onSubmit={() => {}}
        onClose={() => {}}
      />,
    );
    await m.flush();
    const select = q(m,"[data-create-pr-template]") as HTMLSelectElement;
    assert.ok(select, "template picker");
    await m.change(select, "/tmp/bug.md");
    const body = q(m,"[data-create-pr-body]") as HTMLTextAreaElement;
    assert.equal(body.value, "bug body");
    m.unmount();
  });

  it("toggles markdown preview", async () => {
    const m = await mount(
      <CreatePrDialog
        initialTitle="x"
        pending={false}
        onSubmit={() => {}}
        onClose={() => {}}
      />,
    );
    const body = q(m,"[data-create-pr-body]") as HTMLTextAreaElement;
    await m.type(body, "hello **world**");
    await m.click(q(m,"[data-create-pr-preview]"));
    assert.ok(q(m,"[data-create-pr-preview-body]"));
    assert.equal(q(m,"[data-create-pr-body]"), null);
    m.unmount();
  });

  it("refuses a blank title", async () => {
    const submitted: unknown[] = [];
    const m = await mount(
      <CreatePrDialog
        initialTitle="   "
        pending={false}
        onSubmit={(input) => submitted.push(input)}
        onClose={() => {}}
      />,
    );
    const submit = q(m,"[data-create-pr-submit]") as HTMLButtonElement;
    assert.equal(submit.disabled, true);
    await m.click(submit);
    assert.deepEqual(submitted, []);
    m.unmount();
  });
});

describe("CreatePrDialog Generate", () => {
  it("fills title and body from the generator and submits them", async () => {
    const submitted: Array<{ title: string; body: string; draft: boolean }> = [];
    const m = await mount(
      <CreatePrDialog
        initialTitle="Thread title"
        pending={false}
        onGenerate={async () => ({ title: "feat: generated", body: "## Why\n\nBecause." })}
        onSubmit={(input) => submitted.push(input)}
        onClose={() => {}}
      />,
    );
    await m.click(q(m, "[data-create-pr-generate]"));
    await m.flush();
    assert.equal((q(m, "[data-create-pr-title]") as HTMLInputElement).value, "feat: generated");
    assert.equal((q(m, "[data-create-pr-body]") as HTMLTextAreaElement).value, "## Why\n\nBecause.");
    await m.click(q(m, "[data-create-pr-submit]"));
    assert.deepEqual(submitted, [
      { title: "feat: generated", body: "## Why\n\nBecause.", draft: false },
    ]);
    m.unmount();
  });

  it("shows a refused generation (e.g. the secret scan) and keeps the draft", async () => {
    const m = await mount(
      <CreatePrDialog
        initialTitle="Keep me"
        pending={false}
        onGenerate={async () => {
          throw new Error("Refusing to send PR: secret.aws-key");
        }}
        onSubmit={() => {}}
        onClose={() => {}}
      />,
    );
    await m.click(q(m, "[data-create-pr-generate]"));
    await m.flush();
    assert.match(q(m, "[data-create-pr-error]")?.textContent ?? "", /secret\.aws-key/);
    assert.equal((q(m, "[data-create-pr-title]") as HTMLInputElement).value, "Keep me");
    m.unmount();
  });

  it("hides Generate when no generator is wired", async () => {
    const m = await mount(
      <CreatePrDialog initialTitle="x" pending={false} onSubmit={() => {}} onClose={() => {}} />,
    );
    assert.equal(q(m, "[data-create-pr-generate]"), null);
    m.unmount();
  });
});
