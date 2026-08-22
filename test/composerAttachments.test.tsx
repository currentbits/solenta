/**
 * Composer attachments: pick/drop add chips, chips clear on send, and the
 * send path hands the AttachmentInfo list to onSend.
 *
 * Run: node --import=./test/support/render.mjs --test test/composerAttachments.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { inAct, mount, unmountAll } from "./support/dom.ts";
import { Composer } from "../src/components/Composer";
import type {
  AttachmentInfo,
  ProviderInfo,
  WorkflowTemplateInfo,
} from "../src/shared/ipc";

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

const WORKFLOWS: WorkflowTemplateInfo[] = [
  {
    id: "standard",
    name: "Standard",
    builtin: true,
    phases: [
      { name: "seed", agentCount: 1, provider: "claude", model: null },
    ],
  },
];

const IMAGE: AttachmentInfo = {
  kind: "image",
  path: "/tmp/pic.png",
  name: "pic.png",
};
const FOLDER: AttachmentInfo = {
  kind: "folder",
  path: "/tmp/specs",
  name: "specs",
};
const FILE: AttachmentInfo = {
  kind: "file",
  path: "/tmp/notes.md",
  name: "notes.md",
};

interface Harness {
  sends: { prompt: string; attachments?: AttachmentInfo[] }[];
}

function fileItem(file: File, directory = false) {
  return {
    kind: "file" as const,
    type: file.type,
    getAsFile: () => file,
    webkitGetAsEntry: () => ({
      isDirectory: directory,
      isFile: !directory,
      name: file.name,
    }),
  };
}

async function dispatchDrop(
  el: Element | null,
  files: File[],
  opts: { itemsOnly?: boolean; directories?: string[] } = {},
) {
  assert.ok(el, "drop target must exist");
  const dirs = new Set(opts.directories ?? []);
  const items = files.map((f) => fileItem(f, dirs.has(f.name)));
  const ev = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", {
    value: {
      files: opts.itemsOnly ? [] : files,
      items,
      types: ["Files"],
      dropEffect: "none",
    },
  });
  await inAct(() => {
    el.dispatchEvent(ev);
  });
}

function composer(
  harness: Harness,
  over: {
    picks?: AttachmentInfo[];
    withPicker?: boolean;
    savedImage?: AttachmentInfo | null;
    onDrop?: (files: File[]) => Promise<AttachmentInfo[]>;
  } = {},
) {
  const picks = over.picks ?? [];
  return (
    <Composer
      threadId="t1"
      branch={null}
      permissionMode="default"
      onPermissionModeChange={() => {}}
      provider="claude"
      model={null}
      reasoningEffort={null}
      providers={PROVIDERS}
      workflows={WORKFLOWS}
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
      hasWorktree={false}
      onSend={(prompt, attachments) => {
        harness.sends.push({ prompt, attachments });
      }}
      onBuild={() => {}}
      onPickAttachments={
        over.withPicker === false ? undefined : async () => picks
      }
      onSaveAttachmentImage={async () =>
        over.savedImage === undefined ? null : over.savedImage
      }
      onLoadAttachmentImage={async () => null}
      onDropAttachmentFiles={over.onDrop}
    />
  );
}

afterEach(unmountAll);

describe("Composer attachments", () => {
  it("hides the attach button when no picker is provided (web mode)", async () => {
    const h: Harness = { sends: [] };
    const m = await mount(composer(h, { withPicker: false }));
    assert.equal(
      m.query('button[aria-label="Attach files or folders"]'),
      null,
      "attach button must not render without onPickAttachments",
    );
    m.unmount();
  });

  it("adds picked items as chips and sends them with the prompt", async () => {
    const h: Harness = { sends: [] };
    const m = await mount(composer(h, { picks: [IMAGE, FOLDER] }));

    await m.click(m.query('button[aria-label="Attach files or folders"]'));
    assert.ok(
      m.query('[data-attachment-kind="image"]'),
      "image chip must render after pick",
    );
    assert.ok(
      m.query('[data-attachment-kind="folder"]'),
      "folder chip must render after pick",
    );
    assert.ok(m.text().includes("pic.png"));
    assert.ok(m.text().includes("specs"));

    await m.type(m.query("textarea"), "what is in here");
    await m.click(m.query('button[aria-label="Send"]'));

    assert.deepEqual(
      h.sends,
      [{ prompt: "what is in here", attachments: [IMAGE, FOLDER] }],
      "onSend must receive the prompt and the attachments",
    );
    assert.equal(
      m.query('[data-attachment-kind="image"]'),
      null,
      "chips must clear after a successful send",
    );
    assert.equal(
      (m.query("textarea") as HTMLTextAreaElement).value,
      "",
      "draft must clear after a successful send",
    );
    m.unmount();
  });

  it("sends without attachments when none were added", async () => {
    const h: Harness = { sends: [] };
    const m = await mount(composer(h));
    await m.type(m.query("textarea"), "plain prompt");
    await m.click(m.query('button[aria-label="Send"]'));
    assert.deepEqual(
      h.sends,
      [{ prompt: "plain prompt", attachments: undefined }],
      "onSend must get no attachments argument when nothing is attached",
    );
    m.unmount();
  });

  it("removes a chip via its remove button", async () => {
    const h: Harness = { sends: [] };
    const m = await mount(composer(h, { picks: [IMAGE, FOLDER] }));
    await m.click(m.query('button[aria-label="Attach files or folders"]'));

    await m.click(m.query('button[aria-label="Remove pic.png"]'));
    assert.equal(
      m.query('[data-attachment-kind="image"]'),
      null,
      "removed chip must disappear",
    );
    assert.ok(
      m.query('[data-attachment-kind="folder"]'),
      "the other chip must survive",
    );

    await m.type(m.query("textarea"), "go");
    await m.click(m.query('button[aria-label="Send"]'));
    assert.deepEqual(
      h.sends,
      [{ prompt: "go", attachments: [FOLDER] }],
      "only the remaining attachment may be sent",
    );
    m.unmount();
  });

  it("does not add duplicate chips for the same path", async () => {
    const h: Harness = { sends: [] };
    const m = await mount(composer(h, { picks: [IMAGE] }));
    const attach = () => m.query('button[aria-label="Attach files or folders"]');
    await m.click(attach());
    await m.click(attach());
    assert.equal(
      m.queryAll('[data-attachment-kind="image"]').length,
      1,
      "re-picking the same path must not duplicate the chip",
    );
    m.unmount();
  });

  it("adds a dropped image file as a chip", async () => {
    const h: Harness = { sends: [] };
    const seen: File[] = [];
    const m = await mount(
      composer(h, {
        onDrop: async (files) => {
          seen.push(...files);
          return [IMAGE];
        },
      }),
    );
    const file = new File([Uint8Array.from([137, 80, 78, 71])], "pic.png", {
      type: "image/png",
    });
    await dispatchDrop(m.query("textarea"), [file]);
    await m.flush();
    assert.equal(seen.length, 1, "drop must hand the File to the classifier");
    assert.equal(seen[0].name, "pic.png");
    assert.ok(
      m.query('[data-attachment-kind="image"]'),
      "dropped image must surface as a chip",
    );
    m.unmount();
  });

  it("adds a dropped directory that only appears on dataTransfer.items", async () => {
    const h: Harness = { sends: [] };
    const seen: File[] = [];
    const m = await mount(
      composer(h, {
        onDrop: async (files) => {
          seen.push(...files);
          return [FOLDER];
        },
      }),
    );
    const folder = new File([], "specs", { type: "" });
    await dispatchDrop(m.query("textarea"), [folder], {
      itemsOnly: true,
      directories: ["specs"],
    });
    await m.flush();
    assert.equal(
      seen.length,
      1,
      "Finder folders live on items, not FileList",
    );
    assert.equal(seen[0].name, "specs");
    assert.ok(
      m.query('[data-attachment-kind="folder"]'),
      "dropped folder must surface as a chip",
    );
    m.unmount();
  });

  it("adds mixed image + folder chips from one drop", async () => {
    const h: Harness = { sends: [] };
    const m = await mount(
      composer(h, {
        onDrop: async () => [IMAGE, FOLDER],
      }),
    );
    const image = new File([Uint8Array.from([1])], "pic.png", {
      type: "image/png",
    });
    const folder = new File([], "specs", { type: "" });
    await dispatchDrop(m.query("textarea"), [image, folder], {
      directories: ["specs"],
    });
    await m.flush();
    assert.ok(m.query('[data-attachment-kind="image"]'), "image chip");
    assert.ok(m.query('[data-attachment-kind="folder"]'), "folder chip");
    m.unmount();
  });

  it("adds a dropped markdown file as a chip (issue #653)", async () => {
    const h: Harness = { sends: [] };
    const seen: File[] = [];
    const m = await mount(
      composer(h, {
        onDrop: async (files) => {
          seen.push(...files);
          return [FILE];
        },
      }),
    );
    const file = new File(["# notes"], "notes.md", { type: "text/markdown" });
    await dispatchDrop(m.query("textarea"), [file]);
    await m.flush();
    assert.equal(seen.length, 1, "drop must hand the File to the classifier");
    assert.equal(seen[0].name, "notes.md");
    assert.ok(
      m.query('[data-attachment-kind="file"]'),
      "dropped markdown must surface as a file chip",
    );
    assert.ok(m.text().includes("notes.md"));
    m.unmount();
  });

  it("shows a one-line error when the drop yields no attachments", async () => {
    const h: Harness = { sends: [] };
    const m = await mount(
      composer(h, {
        onDrop: async () => [],
      }),
    );
    const empty = new File([], "missing.bin", { type: "application/octet-stream" });
    await dispatchDrop(m.query("textarea"), [empty]);
    await m.flush();
    const alert = m.query('[role="alert"]');
    assert.ok(alert, "empty drop must show the error banner");
    assert.match(
      alert.textContent ?? "",
      /Couldn't attach that\. Drop files or folders/,
    );
    assert.equal(
      m.query("[data-attachment-kind]"),
      null,
      "no chip when every file is skipped",
    );
    m.unmount();
  });
});
