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

/** Codex catalog snapshot for issue #1167: Spark is text-only, Astra is vision. */
const CODEX: ProviderInfo = {
  id: "codex",
  name: "Codex",
  available: true,
  supportsResume: true,
  models: ["gpt-6-astra", "gpt-5.3-codex-spark"],
  modelInfo: [
    {
      id: "gpt-6-astra",
      label: "GPT-6-Astra",
      description: "flagship",
      vendor: "OpenAI",
      inputModalities: ["text", "image"],
    },
    {
      id: "gpt-5.3-codex-spark",
      label: "GPT-5.3-Codex-Spark",
      description: "ultra-fast",
      vendor: "OpenAI",
      inputModalities: ["text"],
    },
  ],
  efforts: [],
};

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
    incoming?: AttachmentInfo[];
    onIncomingConsumed?: () => void;
    onSaveImage?: (dataUrl: string) => Promise<AttachmentInfo | null>;
    provider?: string;
    model?: string | null;
    providers?: ProviderInfo[];
  } = {},
) {
  const picks = over.picks ?? [];
  return (
    <Composer
      threadId="t1"
      branch={null}
      permissionMode="default"
      onPermissionModeChange={() => {}}
      provider={over.provider ?? "claude"}
      model={over.model === undefined ? null : over.model}
      reasoningEffort={null}
      providers={over.providers ?? PROVIDERS}
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
      onSaveAttachmentImage={
        over.onSaveImage ??
        (async () => (over.savedImage === undefined ? null : over.savedImage))
      }
      onLoadAttachmentImage={async () => null}
      onDropAttachmentFiles={over.onDrop}
      incomingAttachments={over.incoming}
      onIncomingAttachmentsConsumed={over.onIncomingConsumed}
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

  it("pins incoming attachments (browser screenshot) as chips", async () => {
    const h: Harness = { sends: [] };
    const consumed: number[] = [];
    const m = await mount(
      composer(h, {
        incoming: [IMAGE],
        onIncomingConsumed: () => consumed.push(1),
      }),
    );
    await m.flush();
    assert.ok(
      m.query('[data-attachment-kind="image"]'),
      "incoming screenshot must become a chip",
    );
    assert.ok(m.text().includes("pic.png"));
    assert.equal(consumed.length, 1);
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

describe("Composer image attach gated by Codex inputModalities (#1167)", () => {
  const spark = {
    provider: "codex",
    model: "gpt-5.3-codex-spark",
    providers: [CODEX],
  };
  const astra = {
    provider: "codex",
    model: "gpt-6-astra",
    providers: [CODEX],
  };

  it("keeps the attach button on Spark so files and folders still pick", async () => {
    const h: Harness = { sends: [] };
    const m = await mount(composer(h, { ...spark, picks: [FOLDER] }));
    const btn = m.query('button[aria-label="Attach files or folders"]');
    assert.ok(btn, "Spark must keep the paperclip for file/folder attach");
    await m.click(btn);
    await m.flush();
    assert.ok(
      m.query('[data-attachment-kind="folder"]'),
      "Spark must still attach a folder",
    );
    m.unmount();
  });

  it("does not pin an incoming screenshot on Spark", async () => {
    const h: Harness = { sends: [] };
    const consumed: number[] = [];
    const m = await mount(
      composer(h, {
        ...spark,
        incoming: [IMAGE],
        onIncomingConsumed: () => consumed.push(1),
      }),
    );
    await m.flush();
    assert.equal(
      m.query('[data-attachment-kind="image"]'),
      null,
      "incoming screenshot must not become a chip on Spark",
    );
    assert.equal(consumed.length, 1, "incoming payload is still consumed");
    m.unmount();
  });

  it("does not pin a picked image on Spark but keeps a folder from the same pick", async () => {
    const h: Harness = { sends: [] };
    const m = await mount(
      composer(h, { ...spark, picks: [IMAGE, FOLDER] }),
    );
    await m.click(m.query('button[aria-label="Attach files or folders"]'));
    await m.flush();
    assert.equal(
      m.query('[data-attachment-kind="image"]'),
      null,
      "picked images must not pin on Spark",
    );
    assert.ok(
      m.query('[data-attachment-kind="folder"]'),
      "mixed pick must keep the folder on Spark",
    );
    m.unmount();
  });

  it("does not pin a pasted image on Spark", async () => {
    const h: Harness = { sends: [] };
    let saved = 0;
    const m = await mount(
      composer(h, {
        ...spark,
        onSaveImage: async () => {
          saved += 1;
          return IMAGE;
        },
      }),
    );
    const ta = m.query("textarea");
    assert.ok(ta);
    const file = new File([Uint8Array.from([1])], "pic.png", {
      type: "image/png",
    });
    await inAct(() => {
      const ev = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "clipboardData", {
        value: {
          items: [
            {
              kind: "file",
              type: "image/png",
              getAsFile: () => file,
            },
          ],
          getData: () => "",
        },
      });
      ta.dispatchEvent(ev);
    });
    await m.flush();
    assert.equal(saved, 0);
    assert.equal(
      m.query('[data-attachment-kind="image"]'),
      null,
      "pasted images must not pin on Spark",
    );
    m.unmount();
  });

  it("drops image files from a mixed drop on Spark and still accepts a file", async () => {
    const h: Harness = { sends: [] };
    const m = await mount(
      composer(h, {
        ...spark,
        onDrop: async () => [IMAGE, FILE],
      }),
    );
    const image = new File([Uint8Array.from([1])], "pic.png", {
      type: "image/png",
    });
    const notes = new File(["# notes"], "notes.md", { type: "text/markdown" });
    await dispatchDrop(m.query("textarea"), [image, notes]);
    await m.flush();
    assert.equal(
      m.query('[data-attachment-kind="image"]'),
      null,
      "Spark must not keep the dropped image",
    );
    assert.ok(
      m.query('[data-attachment-kind="file"]'),
      "Spark must still keep the dropped file",
    );
    m.unmount();
  });

  it("still pins an image chip on Astra from pick and incoming", async () => {
    const h: Harness = { sends: [] };
    const m = await mount(
      composer(h, {
        ...astra,
        picks: [IMAGE],
        incoming: [IMAGE],
      }),
    );
    await m.flush();
    assert.ok(
      m.query('[data-attachment-kind="image"]'),
      "Astra must still pin an incoming screenshot",
    );
    m.unmount();

    const h2: Harness = { sends: [] };
    const m2 = await mount(composer(h2, { ...astra, picks: [IMAGE] }));
    await m2.click(m2.query('button[aria-label="Attach files or folders"]'));
    await m2.flush();
    assert.ok(
      m2.query('[data-attachment-kind="image"]'),
      "Astra must still pin a picked image",
    );
    m2.unmount();
  });
});
