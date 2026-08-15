/**
 * Composer attachments: pick/drop add chips, chips clear on send, and the
 * send path hands the AttachmentInfo list to onSend.
 *
 * Run: node --import=./test/support/render.mjs --test test/composerAttachments.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { mount, unmountAll } from "./support/dom.ts";
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

interface Harness {
  sends: { prompt: string; attachments?: AttachmentInfo[] }[];
}

function composer(
  harness: Harness,
  over: {
    picks?: AttachmentInfo[];
    withPicker?: boolean;
    savedImage?: AttachmentInfo | null;
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
    />
  );
}

afterEach(unmountAll);

describe("Composer attachments", () => {
  it("hides the attach button when no picker is provided (web mode)", async () => {
    const h: Harness = { sends: [] };
    const m = await mount(composer(h, { withPicker: false }));
    assert.equal(
      m.query('button[aria-label="Attach image or folder"]'),
      null,
      "attach button must not render without onPickAttachments",
    );
    m.unmount();
  });

  it("adds picked items as chips and sends them with the prompt", async () => {
    const h: Harness = { sends: [] };
    const m = await mount(composer(h, { picks: [IMAGE, FOLDER] }));

    await m.click(m.query('button[aria-label="Attach image or folder"]'));
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
    await m.click(m.query('button[aria-label="Attach image or folder"]'));

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
    const attach = () => m.query('button[aria-label="Attach image or folder"]');
    await m.click(attach());
    await m.click(attach());
    assert.equal(
      m.queryAll('[data-attachment-kind="image"]').length,
      1,
      "re-picking the same path must not duplicate the chip",
    );
    m.unmount();
  });
});
