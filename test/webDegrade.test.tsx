/**
 * Round 51 Worker D: web degradation + narrow layout.
 * Updated for the create-project flow: the Add project modal now opens in
 * BOTH modes. Native gets a Browse button wired to projects.pickDirectory;
 * on the web, isWebMode() is true (no window.coder) and the modal falls back
 * to a plain path input that calls projects.add(path). The three-pane shell
 * must expose drawer/stack hooks so a ~900px container is usable.
 *
 * Run: node --import=./test/support/render.mjs --test test/webDegrade.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inAct, mount } from "./support/dom.ts";
import {
  createFakeCoder,
  installFakeCoder,
  thread,
  type FakeCoder,
} from "./support/fakeCoder.ts";
import App from "../src/App";
import { isWebMode } from "../src/shared/wire";
import type { AttachmentInfo } from "../src/shared/ipc";

async function boot(fake: FakeCoder) {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  return mount(<App />);
}

function dropCoder(): void {
  delete (window as unknown as { coder?: unknown }).coder;
}

describe("Add project: native vs web", () => {
  it("isWebMode() false: Add project opens the modal with Browse wired to pickDirectory", async () => {
    const fake = createFakeCoder({ projects: [], threads: [] });
    const m = await boot(fake);
    assert.equal(isWebMode(), false, "window.coder must keep isWebMode() false");

    const add = m.byText("Add project");
    assert.ok(add, "empty-state Add project must be on screen");
    await m.click(add);

    assert.equal(
      fake.of("projects.addViaDialog").length,
      0,
      "native Add project must open the modal, not the bare picker",
    );
    const modal = m.query("[data-add-project-path]");
    assert.ok(modal, "native Add project must open the add-project modal");

    const browse = m.query("[data-add-project-browse-path]");
    assert.ok(browse, "native modal must expose a Browse button");
    await m.click(browse);
    assert.ok(
      fake.of("projects.pickDirectory").length > 0,
      "Browse must call projects.pickDirectory",
    );

    const input = m.query("[data-add-project-path-input]");
    assert.ok(input, "path modal must expose a text input");
    assert.ok(
      m.query("[data-add-project-git-init-note]"),
      "existing-folder mode must say we git-init if needed",
    );
    await m.type(input, "/Users/demo/native-added-repo");
    const submit = m.query("[data-add-project-path-submit]");
    assert.ok(submit, "path modal must expose a submit control");
    await m.click(submit);

    const adds = fake.of("projects.add");
    assert.ok(adds.length > 0, "modal submit must call projects.add");
    assert.equal(
      adds[adds.length - 1].args[0],
      "/Users/demo/native-added-repo",
      "projects.add must receive the typed path",
    );
    m.unmount();
  });

  it("isWebMode() true: Add project opens the modal without Browse and never calls addViaDialog", async () => {
    const fake = createFakeCoder({ projects: [], threads: [] });
    const m = await boot(fake);
    // useCoder already closed over the fake. Dropping window.coder flips the
    // contract flag without swapping the recording API.
    dropCoder();
    assert.equal(isWebMode(), true, "deleting window.coder must flip isWebMode()");

    const add = m.byText("Add project");
    assert.ok(add, "empty-state Add project must be on screen");
    await m.click(add);

    assert.equal(
      fake.of("projects.addViaDialog").length,
      0,
      "web Add project must not call addViaDialog",
    );
    const modal = m.query("[data-add-project-path]");
    assert.ok(modal, "web Add project must open the path-input modal");
    assert.equal(
      m.query("[data-add-project-browse-path]"),
      null,
      "web modal must not expose the native Browse button",
    );

    const input = m.query("[data-add-project-path-input]");
    assert.ok(input, "path modal must expose a text input");
    await m.type(input, "/Users/demo/web-added-repo");
    const submit = m.query("[data-add-project-path-submit]");
    assert.ok(submit, "path modal must expose a submit control");
    await m.click(submit);

    assert.equal(
      fake.of("projects.addViaDialog").length,
      0,
      "submitting the path modal must still skip addViaDialog",
    );
    const adds = fake.of("projects.add");
    assert.ok(adds.length > 0, "path modal submit must call projects.add");
    assert.equal(
      adds[adds.length - 1].args[0],
      "/Users/demo/web-added-repo",
      "projects.add must receive the typed path",
    );
    m.unmount();
  });
});

describe("narrow three-pane layout hooks", () => {
  it("exposes drawer/stack markup at a narrow container width", async () => {
    const fake = createFakeCoder({
      threads: [
        thread({
          id: "t-narrow-layout",
          title: "narrow layout thread",
        }),
      ],
    });
    const m = await boot(fake);
    m.container.style.width = "800px";
    m.container.style.maxWidth = "800px";

    assert.ok(m.query('[data-layout="app"]'), "app shell hook missing");
    assert.ok(m.query('[data-pane="sidebar"]'), "sidebar pane hook missing");
    assert.ok(m.query('[data-pane="thread"]'), "thread pane hook missing");
    assert.ok(m.query('[data-pane="agents"]'), "agents pane hook missing");
    // data-drawer now lives on the app root (open state), not hidden checkboxes.
    const threadsOpen = m.query('[data-drawer-open="sidebar"]');
    const agentsOpen = m.query('[data-drawer-open="agents"]');
    assert.ok(threadsOpen, "sidebar open control hook missing");
    assert.ok(agentsOpen, "agents open control hook missing");
    assert.equal(threadsOpen.tagName, "BUTTON");
    assert.equal(agentsOpen.tagName, "BUTTON");
    assert.ok(m.query("[data-narrow-chrome]"), "narrow chrome bar hook missing");

    const card = m.query(
      'button[aria-label="Select thread: narrow layout thread"]',
    );
    assert.ok(card, "narrow-layout fixture thread must render");
    await m.click(card);
    const threadPane = m.query('[data-pane="thread"]');
    assert.ok(
      threadPane?.querySelector("textarea"),
      "composer must stay inside the thread pane so it stays reachable when side panes collapse",
    );
    m.unmount();
  });
});

// Node's global has File but not FileReader; useCoder reads drops via FileReader.
if (typeof FileReader === "undefined") {
  (globalThis as unknown as { FileReader: typeof FileReader }).FileReader = class {
    result: string | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsDataURL(blob: Blob) {
      this.result = `data:${blob.type || "application/octet-stream"};base64,`;
      this.onload?.();
    }
  } as unknown as typeof FileReader;
}

describe("web mode attachments", () => {
  it("drop on composer saves the image over the bridge and shows a chip", async () => {
    const saved: AttachmentInfo = {
      kind: "image",
      path: "/tmp/attachments/t-web-drop/shot.png",
      name: "shot.png",
    };
    const fake = createFakeCoder({
      threads: [thread({ id: "t-web-drop", title: "web drop thread" })],
      saveImage: () => ({ attachment: saved }),
    });
    const m = await boot(fake);
    dropCoder();
    assert.equal(isWebMode(), true, "deleting window.coder must flip isWebMode()");

    const textarea = m.query("textarea");
    assert.ok(textarea, "selected thread must expose the composer");

    const file = new File([Uint8Array.from([137, 80, 78, 71])], "shot.png", {
      type: "image/png",
    });
    await inAct(() => {
      const ev = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "dataTransfer", { value: { files: [file] } });
      textarea.dispatchEvent(ev);
    });
    await m.flush();

    const calls = fake.of("attachments.saveImage");
    assert.ok(calls.length > 0, "drop must call attachments.saveImage");
    const input = calls[calls.length - 1].args[0] as {
      threadId: string;
      dataUrl: string;
    };
    assert.equal(input.threadId, "t-web-drop");
    assert.ok(
      input.dataUrl.startsWith("data:"),
      "saveImage must receive a data: URL",
    );
    assert.ok(
      m.query('[data-attachment-kind="image"]'),
      "returned attachment must surface as a composer chip",
    );
    assert.ok(m.text().includes("shot.png"));
    m.unmount();
  });
});

describe("native drop path resolution (issue #469)", () => {
  it("resolves a dropped folder via droppedFilePath and fromPaths", async () => {
    const folder: AttachmentInfo = {
      kind: "folder",
      path: "/tmp/repo/fixtures",
      name: "fixtures",
    };
    const fake = createFakeCoder({
      threads: [thread({ id: "t-native-drop", title: "native drop" })],
      droppedFilePath: (file) => `/tmp/repo/${file.name}`,
      fromPaths: (input) => {
        const paths = (input as { paths?: string[] }).paths ?? [];
        return {
          attachments: paths.map((p) => ({
            kind: "folder" as const,
            path: p,
            name: p.split("/").pop() ?? p,
          })),
        };
      },
    });
    const m = await boot(fake);
    const host = m.query("[data-thread-drop]");
    assert.ok(host, "open thread must be the drop target");

    const dir = new File([], "fixtures", { type: "" });
    await inAct(() => {
      const ev = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "dataTransfer", {
        value: {
          files: [],
          items: [
            {
              kind: "file",
              type: "",
              getAsFile: () => dir,
              webkitGetAsEntry: () => ({
                isDirectory: true,
                isFile: false,
                name: "fixtures",
              }),
            },
          ],
          types: ["Files"],
        },
      });
      host.dispatchEvent(ev);
    });
    await m.flush();

    const calls = fake.of("attachments.fromPaths");
    assert.ok(calls.length > 0, "native drop must call attachments.fromPaths");
    const input = calls[calls.length - 1].args[0] as { paths: string[] };
    assert.deepEqual(input.paths, ["/tmp/repo/fixtures"]);
    assert.ok(
      m.query('[data-attachment-kind="folder"]'),
      "classified folder must surface as a chip",
    );
    assert.ok(m.text().includes(folder.name));
    m.unmount();
  });
});
