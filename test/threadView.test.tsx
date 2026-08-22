/**
 * ThreadView, the centre pane: messages, work-log cards, empty states.
 *
 * This file exists because ThreadView had ZERO render coverage. timeline.ts is
 * pure and well tested, but nothing proved the component calls buildTimeline or
 * paints what it returns. A reviewer twice deleted user-visible wiring at a
 * call site while the suite, tsc and vite build stayed green.
 *
 * Run: node --import=./test/support/render.mjs --test test/threadView.test.tsx
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it, afterEach, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { inAct, mount, unmountAll } from "./support/dom.ts";
import { ThreadView } from "../src/components/ThreadView";
import styles from "../src/components/ThreadView.module.css";
import { TRANSCRIPT_WINDOW } from "../src/transcriptWindow";
import type {
  AttachmentInfo,
  ChatMessage,
  DiffResult,
  PendingPermissionInfo,
  ProjectInfo,
  ProviderInfo,
  RunStatInfo,
  ThreadDetail,
  ThreadInfo,
  WorkLogItem,
  WorkSuggestion,
  WorkflowTemplateInfo,
} from "../src/shared/ipc";

const project: ProjectInfo = {
  id: "p1",
  slug: "owner/repo",
  name: "repo",
  path: "/tmp/repo",
};

const providers: ProviderInfo[] = [
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

const workflows: WorkflowTemplateInfo[] = [];

const FRESH = Date.now();

function thread(over: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id: "t1",
    projectId: "p1",
    title: "fix the centre pane",
    branch: "coder/fix-centre-pane-abc123",
    prNumber: null,
    prUrl: null,
    status: "idle",
    createdAt: FRESH,
    updatedAt: FRESH,
    runStartedAt: null,
    archived: false,
    settledOverride: null,
    settledAt: null,
    pinnedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: null,
    prState: null,
    provider: "claude",
    model: null,
    sessionId: null,
    permissionMode: "default",
    reasoningEffort: null,
    worktreePath: "/tmp/wt",
    ...over,
  };
}

function msg(over: Partial<ChatMessage> & Pick<ChatMessage, "role" | "text">): ChatMessage {
  return {
    id: over.id ?? `m-${over.role}-${over.createdAt ?? 1}`,
    role: over.role,
    text: over.text,
    createdAt: over.createdAt ?? 1,
    runId: over.runId ?? null,
    tool: over.tool,
    fromThread: over.fromThread,
    attachments: over.attachments,
  };
}

function work(over: Partial<WorkLogItem> & Pick<WorkLogItem, "label">): WorkLogItem {
  return {
    id: over.id ?? `w-${over.label}`,
    runId: over.runId ?? "run-1",
    label: over.label,
    done: over.done ?? false,
    timestamp: over.timestamp ?? 50,
  };
}

function detail(over: Partial<ThreadDetail> = {}): ThreadDetail {
  return {
    thread: over.thread ?? thread(),
    messages: over.messages ?? [],
    workLog: over.workLog ?? [],
    workflow: over.workflow ?? null,
    usage: over.usage ?? null,
    pendingPermission: over.pendingPermission,
  };
}

function suggestion(
  over: Partial<WorkSuggestion> & Pick<WorkSuggestion, "id" | "title">,
): WorkSuggestion {
  return {
    prompt: over.prompt ?? "Do the thing in its own thread.",
    status: over.status ?? "open",
    at: over.at ?? FRESH,
    ...over,
  };
}

const noopAsync = async () => {};
const noopSave = async () =>
  ({ id: "wf", name: "standard", phases: [] }) as WorkflowTemplateInfo;

function view(props: {
  detail?: ThreadDetail | null;
  detailError?: string | null;
  onRetryDetail?: () => void;
  hasProjects?: boolean;
  project?: ProjectInfo | null;
  changesOpen?: boolean;
  onViewChanges?: () => void;
  runStats?: (threadId: string) => Promise<RunStatInfo[]>;
  restoreCheckpoint?: (threadId: string, sha: string) => Promise<void>;
  onLoadImage?: (name: string) => Promise<string | null>;
  onDropAttachmentFiles?: (files: File[]) => Promise<AttachmentInfo[]>;
  onResolvePaths?: (
    paths: string[],
  ) => Promise<Array<{ path: string; abs: string | null }>>;
  onOpenWorkspacePath?: (
    abs: string,
    opts?: { reveal?: boolean },
  ) => void | Promise<void>;
  onFetchDiff?: () => Promise<DiffResult>;
  onFetchReviewContext?: () => Promise<{
    annotation: unknown;
    symbols: Array<{ name: string; path: string }>;
    acceptedHunks: string[];
  }>;
  onStartSuggestion?: (s: WorkSuggestion) => void | Promise<void>;
  onFileSuggestion?: (s: WorkSuggestion) => void | Promise<void>;
  onDismissSuggestion?: (s: WorkSuggestion) => void | Promise<void>;
  revealMessageId?: string | null;
  onSelectThread?: (id: string) => void;
}) {
  return (
    <ThreadView
      detail={props.detail === undefined ? detail() : props.detail}
      detailError={props.detailError}
      onRetryDetail={props.onRetryDetail}
      project={props.project === undefined ? project : props.project}
      providers={providers}
      workflows={workflows}
      hasProjects={props.hasProjects ?? true}
      onAddProject={() => {}}
      onStartRun={() => {}}
      onStartWorkflow={() => {}}
      onSaveWorkflow={noopSave}
      onRemoveWorkflow={noopAsync}
      onStopRun={() => {}}
      onSetPermissionMode={() => {}}
      onRespondPermission={() => {}}
      onSetProvider={() => {}}
      onSetReasoningEffort={() => {}}
      onSetArchived={() => {}}
      onDeleteThread={() => {}}
      changesOpen={props.changesOpen ?? false}
      changesNonce={0}
      onCloseChanges={() => {}}
      onViewChanges={props.onViewChanges}
      runStats={props.runStats}
      restoreCheckpoint={props.restoreCheckpoint}
      onFetchDiff={
        props.onFetchDiff ??
        (async () => ({ files: [], patch: "", truncated: false }))
      }
      onFetchReviewContext={props.onFetchReviewContext}
      onCommitChanges={async () => ({ subject: "x" })}
      onRevertFile={async (path) => ({ path })}
      onSuggestCommitMessage={async () => ({ message: "feat: x" })}
      onPush={async () => ({ remote: "origin", branch: "main" })}
      onLoadImage={props.onLoadImage}
      onDropAttachmentFiles={props.onDropAttachmentFiles}
      onResolvePaths={props.onResolvePaths}
      onOpenWorkspacePath={props.onOpenWorkspacePath}
      onStartSuggestion={props.onStartSuggestion}
      onFileSuggestion={props.onFileSuggestion}
      onDismissSuggestion={props.onDismissSuggestion}
      revealMessageId={props.revealMessageId}
      onSelectThread={props.onSelectThread}
    />
  );
}

function render(props: Parameters<typeof view>[0] = {}): string {
  return renderToStaticMarkup(view(props));
}

/** Interactive open/close tags must never nest (button or anchor inside same). */
function assertNoNestedInteractive(html: string): void {
  const opens = [...html.matchAll(/<\/?button\b|<\/?a\b/g)];
  // Cardinality guard: with no interactive elements at all (a component that
  // rendered null) the loop body never runs and this asserts nothing.
  assert.ok(
    opens.length > 0,
    "expected interactive elements to check, found none",
  );
  let depth = 0;
  for (const m of opens) {
    const tag = m[0];
    if (tag.startsWith("</")) {
      // Floor at zero: a stray close tag earlier in the document would drive
      // depth negative and let a genuinely nested pair slip through later.
      depth = Math.max(0, depth - 1);
    } else {
      depth += 1;
      assert.ok(
        depth <= 1,
        `interactive element nested inside another at index ${m.index}`,
      );
    }
  }
}

afterEach(unmountAll);

describe("ThreadView empty states", () => {
  it("asks for a project when none are registered", () => {
    const html = render({ hasProjects: false, detail: null });
    assert.ok(
      html.includes("Add a project to get started"),
      `expected project empty state, got: ${html.slice(0, 200)}`,
    );
    assert.ok(html.includes("Add project"), "must offer an add-project action");
  });

  it("asks to select a thread when none is open", () => {
    const html = render({ detail: null });
    assert.ok(
      html.includes("Select a thread"),
      `expected no-thread state, got: ${html.slice(0, 200)}`,
    );
  });

  it("shows the load failure with a retry action instead of the neutral empty state (issue #82)", () => {
    const html = render({ detail: null, detailError: "disk on fire" });
    assert.ok(
      html.includes("Couldn’t load this thread"),
      `expected error state, got: ${html.slice(0, 200)}`,
    );
    assert.ok(html.includes("disk on fire"), "the failure message must render");
    assert.ok(
      !html.includes("Select a thread"),
      "a failed load must not masquerade as no selection",
    );
    // Retry only renders when the caller hands a retry callback.
    assert.ok(!html.includes("Retry"), "no retry button without onRetryDetail");
    const withRetry = render({
      detail: null,
      detailError: "disk on fire",
      onRetryDetail: () => {},
    });
    assert.ok(withRetry.includes("Retry"), "retry action must be offered");
  });

  it("shows the start prompt when the open thread has no messages", () => {
    const html = render({ detail: detail({ messages: [], workLog: [] }) });
    assert.ok(
      html.includes("Start by describing what to build"),
      `expected empty-thread prompt, got: ${html.slice(0, 240)}`,
    );
  });
});

describe("ThreadView sandbox badge", () => {
  it("hides the badge when the thread has no computed sandbox", () => {
    const html = render();
    assert.ok(
      !html.includes("data-sandbox-badge"),
      "absent sandbox must not invent a badge",
    );
  });

  it("renders yes/no with the reason on title", () => {
    const yes = render({
      detail: detail({
        thread: thread({
          sandbox: {
            sandboxed: true,
            reason: "Codex default sandbox; runs locally as your user",
          },
        }),
      }),
    });
    assert.ok(yes.includes("data-sandbox-badge"), "badge must render");
    assert.ok(yes.includes('data-sandboxed="yes"'));
    assert.ok(yes.includes("Sandboxed"));
    assert.ok(
      yes.includes('title="Codex default sandbox; runs locally as your user"'),
      "reason must be the hover title",
    );

    const no = render({
      detail: detail({
        thread: thread({
          sandbox: {
            sandboxed: false,
            reason: "Claude --permission-mode bypassPermissions (not gated); runs locally as your user",
          },
        }),
      }),
    });
    assert.ok(no.includes('data-sandboxed="no"'));
    assert.ok(no.includes("Not sandboxed"));
    assert.ok(no.includes("bypassPermissions"));
  });
});

describe("ThreadView message roles", () => {
  it("renders user and assistant messages with distinct structure", () => {
    const html = render({
      detail: detail({
        messages: [
          msg({ id: "u1", role: "user", text: "USER_ONLY_PROMPT", createdAt: 10 }),
          msg({
            id: "a1",
            role: "assistant",
            text: "ASSISTANT_ONLY_REPLY",
            createdAt: 20,
          }),
        ],
      }),
    });
    assert.ok(html.includes("USER_ONLY_PROMPT"), "user text must appear");
    assert.ok(html.includes("ASSISTANT_ONLY_REPLY"), "assistant text must appear");
    // User messages use the userBubble; assistant uses plain <p> paragraphs.
    assert.ok(
      html.includes("userBubble"),
      "user role must render through the user bubble path",
    );
    const userIdx = html.indexOf("USER_ONLY_PROMPT");
    const asstIdx = html.indexOf("ASSISTANT_ONLY_REPLY");
    assert.ok(userIdx >= 0 && asstIdx >= 0 && userIdx < asstIdx, "order must be chronological");
    // Assistant text lives in a <p>, not the user bubble.
    const asstSlice = html.slice(asstIdx - 40, asstIdx + 40);
    assert.ok(
      asstSlice.includes("<p>") || asstSlice.includes("<p "),
      `assistant text must be in a paragraph, got near: ${asstSlice}`,
    );
    assert.ok(
      !asstSlice.includes("userBubble"),
      "assistant text must not share the user bubble class",
    );
  });

  it("renders event messages as event cards, not as user bubbles", () => {
    const html = render({
      detail: detail({
        messages: [
          msg({ id: "e1", role: "event", text: "EVENT_STATUS_LINE", createdAt: 5 }),
        ],
      }),
    });
    assert.ok(html.includes("EVENT_STATUS_LINE"));
    assert.ok(html.includes("eventTitle"), "events use the event title class");
    const near = html.slice(
      html.indexOf("EVENT_STATUS_LINE") - 60,
      html.indexOf("EVENT_STATUS_LINE") + 20,
    );
    assert.ok(!near.includes("userBubble"), "events must not look like user messages");
  });

  it("renders tool messages as tool cards with the tool name", () => {
    const html = render({
      detail: detail({
        messages: [
          msg({
            id: "t1",
            role: "tool",
            text: "Bash: npm test",
            createdAt: 15,
            runId: "run-1",
            tool: {
              id: "tc1",
              name: "Bash",
              input: "npm test",
              output: "ok",
              done: true,
              isError: false,
            },
          }),
        ],
      }),
    });
    assert.ok(html.includes("Bash"), "tool name must show");
    assert.ok(html.includes("Bash: npm test"), "tool summary must show");
    assert.ok(html.includes("toolCard") || html.includes("toolHeader"), "tool card chrome");
  });

  it("renders a cross-thread inbound as a from-thread card, not a user bubble (issue #551)", () => {
    const html = render({
      onSelectThread: () => {},
      detail: detail({
        messages: [
          msg({
            id: "in1",
            role: "user",
            text: "the schema landed",
            createdAt: 10,
            fromThread: { id: "lead-1", title: "Lead" },
          }),
        ],
      }),
    });
    assert.ok(html.includes("data-inbound-card"), "inbound card attr");
    assert.ok(html.includes("data-inbound-from=\"lead-1\""), "sender id");
    assert.ok(html.includes("the schema landed"), "body");
    assert.ok(html.includes("Lead"), "sender title");
    assert.ok(!html.includes("userBubble"), "must not look like a typed user turn");
  });

  it("opens a worktree path from a Read tool-card header", async () => {
    const opened: string[] = [];
    const m = await mount(
      view({
        onResolvePaths: async (paths) =>
          paths.map((p) => ({
            path: p,
            abs: p === "src/foo.ts" ? "/tmp/wt/src/foo.ts" : null,
          })),
        onOpenWorkspacePath: (abs) => {
          opened.push(abs);
        },
        detail: detail({
          messages: [
            msg({
              id: "t-read",
              role: "tool",
              text: "Read: src/foo.ts",
              createdAt: 15,
              runId: "run-1",
              tool: {
                id: "tc-read",
                name: "Read",
                input: '{"file_path":"src/foo.ts"}',
                output: "ok",
                done: true,
                isError: false,
              },
            }),
          ],
        }),
      }),
    );
    await m.flush();
    const link = m.container.querySelector("[data-path-link=\"src/foo.ts\"]");
    assert.ok(link, "Read card path is clickable");
    await m.click(link);
    assert.deepEqual(opened, ["/tmp/wt/src/foo.ts"]);
  });
});

describe("ThreadView provenance tiers (issue #404)", () => {
  const LONG_CLAIM =
    "The billing service retries failed charges three times with exponential " +
    "backoff, then marks the subscription past_due and notifies the account " +
    "owner by email. Webhook deliveries are deduplicated by event id, so a " +
    "retried send is safe to acknowledge more than once in the receiver.";

  it("labels a grounded assistant message with its repo tier", () => {
    const html = render({
      detail: detail({
        messages: [
          msg({ id: "u1", role: "user", text: "where is billing?", createdAt: 10 }),
          msg({
            id: "t1",
            role: "tool",
            text: "Read: src/billing.ts",
            createdAt: 15,
            runId: "run-1",
            tool: {
              id: "tc1",
              name: "Read",
              input: '{"file_path":"src/billing.ts"}',
              output: "ok",
              done: true,
              isError: false,
            },
          }),
          msg({
            id: "a1",
            role: "assistant",
            text: "Billing lives in `src/billing.ts`.",
            createdAt: 20,
            runId: "run-1",
          }),
        ],
      }),
    });
    assert.ok(html.includes('data-provenance="grounded"'), "grounded strip");
    assert.ok(html.includes('data-tier="repo"'), "repo tier chip");
  });

  it("tags a substantive ungrounded answer as model prior knowledge", () => {
    const html = render({
      detail: detail({
        messages: [
          msg({ id: "u1", role: "user", text: "how does billing retry?", createdAt: 10 }),
          msg({ id: "a1", role: "assistant", text: LONG_CLAIM, createdAt: 20 }),
        ],
      }),
    });
    assert.ok(html.includes('data-provenance="prior"'), "prior strip");
    assert.ok(html.includes("model prior knowledge"), "prior tag text");
  });

  it("leaves short chatter untagged", () => {
    const html = render({
      detail: detail({
        messages: [
          msg({ id: "u1", role: "user", text: "fix it", createdAt: 10 }),
          msg({ id: "a1", role: "assistant", text: "On it — looking now.", createdAt: 20 }),
        ],
      }),
    });
    assert.ok(!html.includes("data-provenance"), "no strip on chatter");
  });
});

describe("ThreadView timeline wiring", () => {
  it("renders work-log steps from buildTimeline, not a raw dump of the array", () => {
    // Two work-log items same run, one user message earlier: user then Work Log card.
    const html = render({
      detail: detail({
        messages: [
          msg({ id: "u1", role: "user", text: "PROMPT_BEFORE_RUN", createdAt: 10 }),
        ],
        workLog: [
          work({ id: "w1", runId: "run-1", label: "STEP_READ_FILES", done: true, timestamp: 50 }),
          work({ id: "w2", runId: "run-1", label: "STEP_RUN_TESTS", done: false, timestamp: 60 }),
        ],
      }),
    });
    assert.ok(html.includes("PROMPT_BEFORE_RUN"), "user prompt stays");
    assert.ok(html.includes("Work Log"), "work log card title");
    assert.ok(html.includes("STEP_READ_FILES"), "first step label");
    assert.ok(html.includes("STEP_RUN_TESTS"), "second step label");
    // Chronology: prompt text before the work-log steps (timeline order).
    const p = html.indexOf("PROMPT_BEFORE_RUN");
    const s = html.indexOf("STEP_READ_FILES");
    assert.ok(p < s, "user prompt must precede its run's work log in markup");
  });

  it("keeps two runs as separate work-log cards", () => {
    const html = render({
      detail: detail({
        messages: [],
        workLog: [
          work({ id: "a", runId: "run-a", label: "RUN_A_ONLY_STEP", timestamp: 10 }),
          work({ id: "b", runId: "run-b", label: "RUN_B_ONLY_STEP", timestamp: 20 }),
        ],
      }),
    });
    // One "Work Log" header per group always (collapsed cards still title).
    const titles = html.match(/Work Log/g) ?? [];
    assert.equal(titles.length, 2, `expected 2 work-log cards, got ${titles.length}`);
    // Only the latest run's card is open by default, so its steps show.
    assert.ok(
      html.includes("RUN_B_ONLY_STEP"),
      "latest run's steps must render in the open card",
    );
  });
});

describe("ThreadView content structure", () => {
  it("splits assistant text on blank lines into separate paragraphs", () => {
    const html = render({
      detail: detail({
        messages: [
          msg({
            id: "a1",
            role: "assistant",
            text: "FIRST_PARA_ONLY\n\nSECOND_PARA_ONLY",
            createdAt: 1,
          }),
        ],
      }),
    });
    assert.ok(html.includes("FIRST_PARA_ONLY"));
    assert.ok(html.includes("SECOND_PARA_ONLY"));
    // Two distinct <p> blocks, not one blob with a literal blank line only.
    const first = html.indexOf("FIRST_PARA_ONLY");
    const second = html.indexOf("SECOND_PARA_ONLY");
    const between = html.slice(first, second);
    assert.ok(
      between.includes("</p>"),
      "paragraphs must be separate elements so structure survives",
    );
  });

  it("keeps long single-line assistant output intact", () => {
    const long = "LONG_LINE_" + "x".repeat(400);
    const html = render({
      detail: detail({
        messages: [msg({ id: "a1", role: "assistant", text: long, createdAt: 1 })],
      }),
    });
    assert.ok(html.includes(long), "long text must not be truncated in render");
  });

  it("renders empty assistant text without crashing the pane", () => {
    const html = render({
      detail: detail({
        messages: [
          msg({ id: "u1", role: "user", text: "hi", createdAt: 1 }),
          msg({ id: "a1", role: "assistant", text: "", createdAt: 2 }),
        ],
      }),
    });
    assert.ok(html.includes("hi"), "user message still present");
    assert.ok(html.includes("fix the centre pane"), "header title still present");
  });
});

describe("ThreadView interactive structure", () => {
  it("has no nested button or anchor elements", () => {
    const html = render({
      detail: detail({
        messages: [
          msg({ id: "u1", role: "user", text: "go", createdAt: 1 }),
          msg({
            id: "t1",
            role: "tool",
            text: "Read: foo.ts",
            createdAt: 2,
            runId: "run-1",
            tool: {
              id: "tc1",
              name: "Read",
              input: "foo.ts",
              output: "export {}",
              done: true,
              isError: false,
            },
          }),
        ],
        workLog: [work({ label: "Reading files", done: true, timestamp: 2 })],
        thread: thread({ status: "working", runStartedAt: 1 }),
      }),
    });
    assertNoNestedInteractive(html);
  });

  it("shows Stop while the thread is working", () => {
    const html = render({
      detail: detail({
        thread: thread({ status: "working", runStartedAt: Date.now() }),
        messages: [msg({ id: "u1", role: "user", text: "work", createdAt: 1 })],
      }),
    });
    assert.ok(html.includes("Stop"), "working strip must expose Stop");
    assert.ok(
      html.includes("working"),
      "status copy must indicate work in progress",
    );
  });
});

describe("ThreadView mounted interactions", () => {
  it("expands a tool card on click to show tool input", async () => {
    const m = await mount(
      view({
        detail: detail({
          messages: [
            msg({
              id: "t1",
              role: "tool",
              text: "Bash: echo hi",
              createdAt: 1,
              runId: "run-1",
              tool: {
                id: "tc1",
                name: "Bash",
                input: "TOOL_INPUT_SECRET_PAYLOAD",
                output: null,
                done: false,
                isError: false,
              },
            }),
          ],
          // No work log for this run, so autoExpand stays false (latestRunningToolId
          // requires a work-log group). Click must open it.
          workLog: [],
        }),
      }),
    );
    assert.ok(
      !m.text().includes("TOOL_INPUT_SECRET_PAYLOAD"),
      "collapsed tool body must hide input",
    );
    // Name/dot live on toolToggle so a path in the summary is not nested
    // inside the expand button.
    const header =
      m.query("button.toolToggle") ??
      m.byText("Bash");
    assert.ok(header, "tool toggle is a button");
    await m.click(header);
    assert.ok(
      m.text().includes("TOOL_INPUT_SECRET_PAYLOAD"),
      `expanded tool body must show input, got: ${m.text().slice(0, 200)}`,
    );
    m.unmount();
  });

  it("renders images a tool returned once the card is open", async () => {
    const dataUrl = "data:image/png;base64,AAAA";
    const asked: string[] = [];
    const m = await mount(
      view({
        onLoadImage: async (name) => {
          asked.push(name);
          return dataUrl;
        },
        detail: detail({
          messages: [
            msg({
              id: "t1",
              role: "tool",
              text: "Read: /tmp/shot-home.png",
              createdAt: 1,
              runId: "run-1",
              tool: {
                id: "tc1",
                name: "Read",
                input: "{}",
                output: "[image]",
                done: true,
                isError: false,
                images: ["shot.png"],
              },
            }),
          ],
          workLog: [],
        }),
      }),
    );
    assert.equal(m.queryAll("img").length, 0, "collapsed card shows no image");
    await m.click(m.query("button.toolToggle"));
    await m.flush();
    assert.deepEqual(asked, ["shot.png"]);
    const img = m.query("img");
    assert.ok(img, `expanded card must render the image, got: ${m.html().slice(0, 300)}`);
    assert.equal(img.getAttribute("src"), dataUrl);
    m.unmount();
  });

  it("opens a clicked image full size and closes it with Escape", async () => {
    const dataUrl = "data:image/png;base64,AAAA";
    const m = await mount(
      view({
        onLoadImage: async () => dataUrl,
        detail: detail({
          messages: [
            msg({
              id: "t1",
              role: "tool",
              text: "Read: /tmp/shot.png",
              createdAt: 1,
              runId: "run-1",
              tool: {
                id: "tc1",
                name: "Read",
                input: "{}",
                output: "[image]",
                done: true,
                isError: false,
                images: ["shot.png"],
              },
            }),
          ],
          workLog: [],
        }),
      }),
    );
    await m.click(m.query("button.toolToggle"));
    await m.flush();
    assert.equal(m.query("[data-image-lightbox]"), null, "closed by default");

    await m.click(m.query("img.toolImage"));
    const box = m.query("[data-image-lightbox]");
    assert.ok(box, `clicking the image must open the lightbox, got: ${m.html().slice(0, 400)}`);
    assert.equal(
      m.query("img.lightboxImg")?.getAttribute("src"),
      dataUrl,
      "lightbox shows the clicked image",
    );

    await m.press(box, "Escape");
    assert.equal(
      m.query("[data-image-lightbox]"),
      null,
      "Escape must dismiss the lightbox",
    );
    m.unmount();
  });
});

describe("ThreadView review bar", () => {
  const twoRunDetail = detail({
    thread: thread({ status: "idle", worktreePath: "/tmp/wt" }),
    messages: [
      msg({
        id: "u1",
        role: "user",
        text: "first prompt",
        runId: "run-1",
        createdAt: 10,
      }),
      msg({
        id: "a1",
        role: "assistant",
        text: "FIRST_ASSISTANT",
        runId: "run-1",
        createdAt: 20,
      }),
      msg({
        id: "u2",
        role: "user",
        text: "second prompt",
        runId: "run-2",
        createdAt: 30,
      }),
      msg({
        id: "a2",
        role: "assistant",
        text: "SECOND_ASSISTANT",
        runId: "run-2",
        createdAt: 40,
      }),
    ],
  });

  const twoStats: RunStatInfo[] = [
    { sha: "sha-turn-1-aaaaaaaa", turn: 1, files: 3, additions: 24, deletions: 9 },
    { sha: "sha-turn-2-bbbbbbbb", turn: 2, files: 1, additions: 2, deletions: 0 },
  ];

  it("renders stats under the last assistant of each completed run", async () => {
    const m = await mount(
      view({
        detail: twoRunDetail,
        runStats: async () => twoStats,
      }),
    );
    await m.flush();
    const bars = m.queryAll("[data-review-bar]");
    assert.equal(bars.length, 2, "one bar per completed run with a checkpoint");
    assert.ok(
      (m.query("[data-review-bar='run-1']")?.textContent || "").includes(
        "Edited 3 files · +24 -9",
      ),
      "first run stats",
    );
    assert.ok(
      (m.query("[data-review-bar='run-2']")?.textContent || "").includes(
        "Edited 1 file · +2 -0",
      ),
      "second run stats",
    );
    const html = m.html();
    assert.ok(
      html.indexOf("FIRST_ASSISTANT") < html.indexOf("Edited 3 files"),
      "bar sits under the first run's assistant",
    );
    assert.ok(
      html.indexOf("SECOND_ASSISTANT") < html.indexOf("Edited 1 file"),
      "bar sits under the second run's assistant",
    );
    m.unmount();
  });

  it("Review opens Changes via onViewChanges; Undo confirm restores the prior checkpoint", async () => {
    let reviews = 0;
    const restores: Array<{ threadId: string; sha: string }> = [];
    const m = await mount(
      view({
        detail: twoRunDetail,
        runStats: async () => twoStats,
        onViewChanges: () => {
          reviews += 1;
        },
        restoreCheckpoint: async (threadId, sha) => {
          restores.push({ threadId, sha });
        },
      }),
    );
    await m.flush();

    const reviewBtns = m.queryAll("[data-review-open]");
    assert.equal(reviewBtns.length, 2);
    await m.click(reviewBtns[1] as HTMLElement);
    assert.equal(reviews, 1, "Review calls onViewChanges");

    const firstUndo = m.query(
      "[data-review-bar='run-1'] [data-review-undo]",
    ) as HTMLButtonElement | null;
    assert.ok(firstUndo, "Undo on first run");
    assert.equal(firstUndo!.disabled, true, "first run has no prior checkpoint");

    const secondUndo = m.query(
      "[data-review-bar='run-2'] [data-review-undo]",
    ) as HTMLButtonElement | null;
    assert.ok(secondUndo, "Undo on second run");
    await m.click(secondUndo);
    await m.flush();

    const dialog = m.query("[data-review-undo-confirm]");
    assert.ok(dialog, "confirm dialog open");
    const copy = dialog!.textContent || "";
    assert.ok(copy.includes("turn 1") || copy.includes("Turn 1"));
    assert.ok(copy.includes("sha-tur"), "confirm names short sha");
    assert.ok(
      copy.includes("resets the worktree") &&
        copy.includes("main repository is not touched"),
    );

    await m.click(m.query("[data-review-undo-cancel]") as HTMLElement);
    await m.flush();
    assert.equal(restores.length, 0, "Cancel must not restore");

    await m.click(secondUndo);
    await m.flush();
    await m.click(m.query("[data-review-undo-submit]") as HTMLElement);
    await m.flush();
    assert.deepEqual(restores, [{ threadId: "t1", sha: "sha-turn-1-aaaaaaaa" }]);
    assert.equal(reviews, 2, "successful undo also opens Changes");
    m.unmount();
  });
});

const DROP_IMAGE: AttachmentInfo = {
  kind: "image",
  path: "/tmp/shot.png",
  name: "shot.png",
};

function dropTransfer(
  files: File[],
  opts: { itemsOnly?: boolean; directories?: string[] } = {},
) {
  const dirs = new Set(opts.directories ?? []);
  const items = files.map((file) => ({
    kind: "file",
    type: file.type,
    getAsFile: () => file,
    webkitGetAsEntry: () => ({
      isDirectory: dirs.has(file.name),
      isFile: !dirs.has(file.name),
      name: file.name,
    }),
  }));
  return {
    files: opts.itemsOnly ? [] : files,
    items,
    types: ["Files"],
    dropEffect: "none",
  };
}

async function dispatchOn(
  el: Element | null,
  type: string,
  dataTransfer: object,
) {
  assert.ok(el, `${type} target must exist`);
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: dataTransfer });
  await inAct(() => {
    el.dispatchEvent(ev);
  });
}

describe("ThreadView file attachments (issue #653)", () => {
  it("renders a file chip on a user transcript message", async () => {
    const m = await mount(
      view({
        detail: detail({
          messages: [
            msg({
              id: "u1",
              role: "user",
              text: "see notes",
              createdAt: 10,
              attachments: [
                {
                  kind: "file",
                  path: "/tmp/notes.md",
                  name: "notes.md",
                },
              ],
            }),
          ],
        }),
      }),
    );
    assert.ok(
      m.query('[data-attachment-kind="file"]'),
      "user message must show a file chip",
    );
    assert.ok(m.text().includes("notes.md"));
    m.unmount();
  });
});

describe("ThreadView file drop (issue #469)", () => {
  it("attaches a file dropped on the transcript, not only the composer", async () => {
    const seen: File[] = [];
    const m = await mount(
      view({
        onDropAttachmentFiles: async (files) => {
          seen.push(...files);
          return [DROP_IMAGE];
        },
        detail: detail({
          messages: [
            msg({
              id: "u1",
              role: "user",
              text: "TRANSCRIPT_DROP_TARGET",
              createdAt: 10,
            }),
          ],
        }),
      }),
    );
    assert.ok(
      m.text().includes("TRANSCRIPT_DROP_TARGET"),
      "user message must be on screen",
    );
    const transcript =
      m.query(".userBubble") ?? m.query("[class*='userBubble']");
    assert.ok(transcript, "user bubble must be the drop target");
    const file = new File([Uint8Array.from([1])], "shot.png", {
      type: "image/png",
    });
    await dispatchOn(transcript, "drop", dropTransfer([file]));
    await m.flush();
    assert.equal(seen.length, 1, "transcript drop must reach the classifier");
    assert.equal(seen[0].name, "shot.png");
    assert.ok(
      m.query('[data-attachment-kind="image"]'),
      "chip must appear on the composer after a transcript drop",
    );
    m.unmount();
  });

  it("shows a drop overlay while a file drag hovers the thread", async () => {
    const m = await mount(
      view({
        onDropAttachmentFiles: async () => [],
        detail: detail({
          messages: [
            msg({
              id: "u1",
              role: "user",
              text: "hover target",
              createdAt: 10,
            }),
          ],
        }),
      }),
    );
    const host = m.query("[data-thread-drop]");
    assert.ok(host, "open thread is the drop target");
    assert.equal(
      m.query("[data-drop-overlay]"),
      null,
      "overlay stays hidden until a file drag enters",
    );
    await dispatchOn(host, "dragenter", {
      types: ["Files"],
      items: [],
      files: [],
    });
    assert.ok(m.query("[data-drop-overlay]"), "overlay must paint");
    assert.ok(
      m.text().includes("Drop files or folders"),
      "overlay copy names files and folders",
    );
    m.unmount();
  });
});

/**
 * jsdom has no ResizeObserver and no layout. The pin-to-bottom effect in
 * ThreadView must still re-pin when a child's box grows after paint (images,
 * highlight, webfonts) with no React state change — issue #408.
 */
type FakeROCallback = (
  entries: ResizeObserverEntry[],
  observer: ResizeObserver,
) => void;

const fakeObservers: Array<{
  cb: FakeROCallback;
  targets: Set<Element>;
}> = [];

class FakeResizeObserver {
  private readonly targets = new Set<Element>();
  constructor(private readonly cb: FakeROCallback) {
    fakeObservers.push({ cb, targets: this.targets });
  }
  observe(el: Element) {
    this.targets.add(el);
  }
  unobserve(el: Element) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
  }
}

function installFakeResizeObserver() {
  fakeObservers.length = 0;
  (
    globalThis as unknown as { ResizeObserver: typeof ResizeObserver }
  ).ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
}

function fireObservedResizes() {
  for (const o of fakeObservers) {
    if (o.targets.size === 0) continue;
    o.cb(
      [...o.targets].map((target) => ({ target }) as ResizeObserverEntry),
      o as unknown as ResizeObserver,
    );
  }
}

function fakeScrollMetrics(
  el: HTMLElement,
  layout: { clientHeight: number; scrollHeight: number; scrollTop: number },
) {
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => layout.clientHeight,
  });
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => layout.scrollHeight,
  });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => layout.scrollTop,
    set: (value: number) => {
      layout.scrollTop = value;
    },
  });
}

describe("ThreadView stick-to-bottom on content resize (issue #408)", () => {
  const prevRO = (globalThis as { ResizeObserver?: typeof ResizeObserver })
    .ResizeObserver;

  beforeEach(() => {
    installFakeResizeObserver();
  });

  afterEach(() => {
    fakeObservers.length = 0;
    if (prevRO) {
      (
        globalThis as unknown as { ResizeObserver: typeof ResizeObserver }
      ).ResizeObserver = prevRO;
    } else {
      delete (globalThis as { ResizeObserver?: typeof ResizeObserver })
        .ResizeObserver;
    }
  });

  const sizedDetail = () =>
    detail({
      messages: [
        msg({
          id: "u1",
          role: "user",
          text: "PIN_TARGET_PROMPT",
          createdAt: 10,
        }),
        msg({
          id: "a1",
          role: "assistant",
          text: "PIN_TARGET_REPLY",
          createdAt: 20,
        }),
      ],
    });

  it("re-pins to the bottom when content grows while the user is stuck", async () => {
    const m = await mount(view({ detail: sizedDetail() }));
    const body = m.query(".body") as HTMLElement | null;
    assert.ok(body, "scroll body must render");
    assert.ok(
      fakeObservers.some((o) => o.targets.size > 0),
      "ResizeObserver must watch the scroll body (or its children)",
    );

    const layout = { clientHeight: 400, scrollHeight: 1000, scrollTop: 600 };
    fakeScrollMetrics(body, layout);
    layout.scrollHeight = 1400;
    fireObservedResizes();

    assert.equal(
      layout.scrollTop,
      1400,
      "pinned view must follow content that grew after paint",
    );
    m.unmount();
  });

  it("does not move the view when the user has scrolled up and content grows", async () => {
    const m = await mount(view({ detail: sizedDetail() }));
    const body = m.query(".body") as HTMLElement | null;
    assert.ok(body, "scroll body must render");

    const layout = { clientHeight: 400, scrollHeight: 1000, scrollTop: 80 };
    fakeScrollMetrics(body, layout);
    body.dispatchEvent(new Event("scroll"));
    layout.scrollHeight = 1400;
    fireObservedResizes();

    assert.equal(
      layout.scrollTop,
      80,
      "a user who scrolled up must not be yanked back to the bottom",
    );
    m.unmount();
  });

  /**
   * Issue #607: Chrome fires a delayed scroll when the transcript remounts
   * (thread switch) or a tall permission card lands. That event used to
   * clear stickToBottom, after which ResizeObserver refused to pin.
   */
  it("re-pins after a thread switch even if a late scroll reports not-at-bottom (issue #607)", async () => {
    const threadA = sizedDetail();
    const threadB = detail({
      thread: thread({ id: "t2", title: "other thread" }),
      messages: [
        msg({
          id: "u2",
          role: "user",
          text: "THREAD_B_PROMPT",
          createdAt: 10,
        }),
        msg({
          id: "a2",
          role: "assistant",
          text: "THREAD_B_REPLY",
          createdAt: 20,
        }),
      ],
    });

    function SwitchHarness() {
      const [open, setOpen] = useState<ThreadDetail | null>(threadA);
      return (
        <div>
          <button type="button" data-stick-null="" onClick={() => setOpen(null)}>
            gap
          </button>
          <button type="button" data-stick-b="" onClick={() => setOpen(threadB)}>
            b
          </button>
          {view({ detail: open })}
        </div>
      );
    }

    const m = await mount(<SwitchHarness />);
    const firstBody = m.query(".body") as HTMLElement | null;
    assert.ok(firstBody, "thread A scroll body");
    const firstLayout = { clientHeight: 400, scrollHeight: 1000, scrollTop: 80 };
    fakeScrollMetrics(firstBody, firstLayout);
    firstBody.dispatchEvent(new Event("scroll"));

    await inAct(async () => {
      (m.query("[data-stick-null]") as HTMLButtonElement).click();
    });
    assert.equal(m.query(".body"), null, "loading gap unmounts the body");

    await inAct(async () => {
      (m.query("[data-stick-b]") as HTMLButtonElement).click();
    });
    const body = m.query(".body") as HTMLElement | null;
    assert.ok(body, "thread B scroll body");
    assert.ok(m.text().includes("THREAD_B_REPLY"));

    const layout = { clientHeight: 400, scrollHeight: 2000, scrollTop: 0 };
    fakeScrollMetrics(body, layout);
    body.dispatchEvent(new Event("scroll"));
    fireObservedResizes();

    assert.equal(
      layout.scrollTop,
      2000,
      "switching threads must land on the latest messages even if a leftover scroll event reported we were away from the bottom",
    );
    m.unmount();
  });

  it("re-pins when a permission prompt appears even if a late scroll unsticks (issue #607)", async () => {
    const pending: PendingPermissionInfo = {
      requestId: "req-607",
      toolName: "Bash",
      summary: "Bash: npm test",
      input: '{"command":"npm test"}',
      command: "npm test",
    };

    function PermHarness() {
      const [open, setOpen] = useState(sizedDetail());
      return (
        <div>
          <button
            type="button"
            data-stick-perm=""
            onClick={() =>
              setOpen((prev) => ({ ...prev, pendingPermission: pending }))
            }
          >
            perm
          </button>
          {view({ detail: open })}
        </div>
      );
    }

    const m = await mount(<PermHarness />);
    const body = m.query(".body") as HTMLElement | null;
    assert.ok(body, "scroll body");

    const layout = { clientHeight: 400, scrollHeight: 1000, scrollTop: 600 };
    fakeScrollMetrics(body, layout);

    await inAct(async () => {
      (m.query("[data-stick-perm]") as HTMLButtonElement).click();
    });
    assert.ok(m.query("[data-permission-card]"), "permission card mounted");

    layout.scrollHeight = 1400;
    body.dispatchEvent(new Event("scroll"));
    fireObservedResizes();

    assert.equal(
      layout.scrollTop,
      1400,
      "a permission prompt must pull the view to the action even if a non-user scroll event reported we had left the bottom",
    );
    m.unmount();
  });
});

/**
 * Issue #555: a tall review itinerary used to consume the whole 520px
 * Changes panel, clip the commit box, and leave no scrollbar to reach it.
 * The commit box must stay a sibling of the itinerary scroller, not a child.
 */
describe("ThreadView Changes panel commit box (issue #555)", () => {
  it("keeps the commit box outside the itinerary scroller when the itinerary is tall", async () => {
    const m = await mount(
      view({
        changesOpen: true,
        detail: detail({
          thread: thread({
            title: "Review itinerary layout",
            plan: "GitHub issue #555: keep the commit box reachable under a tall itinerary",
          }),
          messages: [
            msg({
              id: "u1",
              role: "user",
              text: "GitHub issue #555: Changes panel: a tall review itinerary pushes the commit box out of the clipped panel",
              createdAt: 10,
            }),
          ],
        }),
        onFetchDiff: async () => ({
          files: [
            {
              path: ".github/workflows/ci.yml",
              status: "M",
              additions: 8,
              deletions: 2,
            },
            {
              path: "package.json",
              status: "M",
              additions: 3,
              deletions: 1,
            },
            {
              path: "src/App.tsx",
              status: "M",
              additions: 12,
              deletions: 4,
            },
            {
              path: "src/shared/ipc.ts",
              status: "M",
              additions: 6,
              deletions: 1,
            },
            {
              path: "src/reviewItinerary.ts",
              status: "A",
              additions: 40,
              deletions: 0,
            },
            {
              path: "electron/updater.js",
              status: "M",
              additions: 8,
              deletions: 2,
            },
            {
              path: "test/reviewItinerary.test.ts",
              status: "A",
              additions: 20,
              deletions: 0,
            },
            {
              path: "docs/ARCHITECTURE.md",
              status: "M",
              additions: 15,
              deletions: 0,
            },
          ],
          patch: [
            "diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml",
            "--- a/.github/workflows/ci.yml",
            "+++ b/.github/workflows/ci.yml",
            "@@ -1,1 +1,2 @@",
            " name: ci",
            "+  run: npm test",
            "diff --git a/src/reviewItinerary.ts b/src/reviewItinerary.ts",
            "--- /dev/null",
            "+++ b/src/reviewItinerary.ts",
            "@@ -0,0 +1,2 @@",
            "+export function formatUsd() {}",
            "+export function buildReviewItinerary() {}",
            "diff --git a/electron/updater.js b/electron/updater.js",
            "--- a/electron/updater.js",
            "+++ b/electron/updater.js",
            "@@ -1,1 +1,2 @@",
            " module.exports = {}",
            "+function extra() {}",
          ].join("\n"),
          truncated: false,
        }),
        onFetchReviewContext: async () => ({
          annotation: {
            version: 1,
            readOrder: ["ci-config", "critical", "tests", "impl"],
            chunks: [
              {
                area: "ci-config",
                rationale:
                  "Workflow files fail closed — a bad ci.yml ships to every run before anyone reads the rest.",
                risks: ["CI skip on forks"],
              },
              {
                area: "critical",
                rationale:
                  "App.tsx and ipc.ts are the contract; a miss here is a runtime miss on every thread.",
                risks: ["prop drift"],
              },
              {
                area: "tests",
                rationale:
                  "What this claims to prove about the commit box surviving a tall itinerary.",
                risks: ["fixture too short"],
              },
              {
                area: "impl",
                rationale:
                  "The itinerary builder plus updater path that does not match the issue title.",
                risks: ["hash drift"],
              },
            ],
            risks: [
              "tall itinerary eats the commit box",
              "nested scroller hides Generate/Commit",
            ],
          },
          symbols: [{ name: "formatUsd", path: "src/format.ts" }],
          acceptedHunks: [],
        }),
      }),
    );

    const panel = m.query('[aria-label="Git"]');
    assert.ok(panel, "Git pane must render");
    assert.ok(
      panel.querySelector("[data-review-hard-stop]"),
      "fixture must produce a hard-stop banner",
    );
    assert.ok(
      panel.querySelector("[data-review-annotation]"),
      "fixture must produce author notes",
    );
    assert.ok(
      panel.querySelectorAll("[data-review-step]").length >= 4,
      "fixture must produce at least four numbered steps",
    );

    const textarea = panel.querySelector('textarea[aria-label="Commit message"]');
    assert.ok(textarea, "commit message box must be in the DOM");
    const commitBtn = [...panel.querySelectorAll("button")].find((b) => {
      const text = (b.textContent || "").trim();
      return text === "Commit" || text === "Committing…";
    });
    assert.ok(commitBtn, "Commit button must be in the Changes panel");

    // The two-column split is what actually protects #555: the itinerary
    // scrolls inside .changesFiles, and .commitBox is a flex-shrink: 0
    // sibling of .changesSplit. jsdom has no layout, so clipping is
    // invisible: assert the structure instead of a class nobody uses.
    const split = panel.querySelector(`.${styles.changesSplit}`);
    assert.ok(split, "file/diff split must render");
    assert.ok(
      !split.contains(textarea),
      "commit textarea must sit outside .changesSplit, not inside a scrolling column",
    );

    const commitBox = textarea.closest(`.${styles.commitBox}`);
    assert.ok(commitBox, "textarea must live in .commitBox");
    assert.equal(
      commitBox.parentElement,
      split.parentElement,
      ".commitBox must be a sibling of .changesSplit so a tall itinerary cannot push it out of the pane",
    );
    assert.equal(
      split.nextElementSibling,
      commitBox,
      ".commitBox must follow .changesSplit as the next sibling",
    );

    const filesCol = panel.querySelector(`.${styles.changesFiles}`);
    assert.ok(filesCol, "files column must render");
    assert.ok(
      filesCol.contains(panel.querySelector("[data-review-hard-stop]")!),
      "tall itinerary must live inside the scrolling files column",
    );

    // Any ancestor of the textarea that carries overflow-y: auto would
    // hide the box once the itinerary grew past the pane. Parse the
    // module CSS so a new scroller class still fails this test.
    const cssPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../src/components/ThreadView.module.css",
    );
    const css = fs.readFileSync(cssPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const overflowClasses = new Set<string>();
    const ruleRe = /\.([A-Za-z][\w-]*)\s*\{([^}]*)\}/g;
    let match: RegExpExecArray | null;
    while ((match = ruleRe.exec(css))) {
      if (
        /overflow-y\s*:\s*auto/.test(match[2]) ||
        /overflow\s*:\s*auto/.test(match[2])
      ) {
        overflowClasses.add(match[1]);
      }
    }
    let node: Element | null = textarea.parentElement;
    while (node && node !== panel) {
      for (const cls of node.classList) {
        assert.ok(
          !overflowClasses.has(cls),
          `commit box must not sit inside .${cls} (overflow-y: auto)`,
        );
      }
      node = node.parentElement;
    }
    m.unmount();
  });

  it("pins the commit box in CSS so a tall itinerary cannot clip it", () => {
    const cssPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../src/components/ThreadView.module.css",
    );
    const css = fs.readFileSync(cssPath, "utf8");
    // Strip comments first so a commented-out rule cannot satisfy or
    // defeat an assertion. Slice each selector to its closing brace so
    // a match in some other rule does not count.
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const ruleBody = (className: string): string => {
      const re = new RegExp(`\\.${className}(?![\\w-])\\s*\\{`);
      const match = re.exec(clean);
      if (!match) return "";
      const brace = match.index + match[0].length - 1;
      const end = clean.indexOf("}", brace);
      if (end < 0) return "";
      return clean.slice(brace + 1, end);
    };

    const commitBox = ruleBody("commitBox");
    assert.ok(commitBox, ".commitBox rule must exist");
    assert.match(
      commitBox,
      /flex-shrink\s*:\s*0/,
      ".commitBox must not shrink below the file/diff split",
    );

    const changesHead = ruleBody("changesHead");
    assert.ok(changesHead, ".changesHead rule must exist");
    assert.match(
      changesHead,
      /flex-shrink\s*:\s*0/,
      ".changesHead must not shrink when the itinerary is tall",
    );

    const changesPane = ruleBody("changesPane");
    assert.ok(changesPane, ".changesPane rule must exist");
    assert.match(
      changesPane,
      /flex\s*:\s*1/,
      ".changesPane must fill the center column",
    );
    assert.match(
      changesPane,
      /min-height\s*:\s*0/,
      ".changesPane must be allowed to shrink inside the thread column",
    );

    const changesSplit = ruleBody("changesSplit");
    assert.ok(changesSplit, ".changesSplit rule must exist");
    assert.match(
      changesSplit,
      /flex\s*:\s*1/,
      ".changesSplit must take leftover height above the commit box",
    );
    assert.match(
      changesSplit,
      /min-height\s*:\s*0/,
      ".changesSplit must be allowed to shrink inside the pane",
    );

    // First .changesFiles match is the max-width: 720px override (border
    // only). Collect every body so the scrolling rule still counts.
    const allBodies = (className: string): string[] => {
      const bodies: string[] = [];
      const re = new RegExp(`\\.${className}(?![\\w-])\\s*\\{`, "g");
      let match: RegExpExecArray | null;
      while ((match = re.exec(clean))) {
        const brace = match.index + match[0].length - 1;
        const end = clean.indexOf("}", brace);
        if (end < 0) break;
        bodies.push(clean.slice(brace + 1, end));
      }
      return bodies;
    };
    const has = (bodies: string[], re: RegExp) =>
      bodies.some((body) => re.test(body));

    const filesBodies = allBodies("changesFiles");
    assert.ok(filesBodies.length > 0, ".changesFiles rule must exist");
    assert.ok(
      has(filesBodies, /min-height\s*:\s*0/),
      ".changesFiles must shrink inside the split so a tall itinerary scrolls",
    );
    assert.ok(
      has(filesBodies, /overflow-y\s*:\s*auto/),
      ".changesFiles is the itinerary scroller",
    );

    const diffBodies = allBodies("changesDiff");
    assert.ok(diffBodies.length > 0, ".changesDiff rule must exist");
    assert.ok(
      has(diffBodies, /min-height\s*:\s*0/),
      ".changesDiff must shrink inside the split",
    );
    assert.ok(
      has(diffBodies, /overflow-y\s*:\s*auto/),
      ".changesDiff is the patch scroller",
    );

    assert.equal(
      ruleBody("changesScroll"),
      "",
      "dead .changesScroll wrapper must stay gone; the split columns scroll",
    );

    const mediaStart = clean.search(/@media\s*\(\s*max-width\s*:\s*720px\s*\)/);
    assert.ok(mediaStart >= 0, "narrow stacked-split media query must exist");
    const mediaOpen = clean.indexOf("{", mediaStart);
    let depth = 0;
    let mediaEnd = mediaOpen;
    for (let i = mediaOpen; i < clean.length; i++) {
      if (clean[i] === "{") depth++;
      else if (clean[i] === "}") {
        depth--;
        if (depth === 0) {
          mediaEnd = i;
          break;
        }
      }
    }
    const media = clean.slice(mediaOpen, mediaEnd + 1);
    assert.match(
      media,
      /grid-template-rows/,
      "narrow path must stack the split into rows, not grow the pane",
    );
    assert.doesNotMatch(
      media,
      /commitBox/,
      "narrow path must not restyle .commitBox into the scrolling split",
    );
  });
});

const twoOpenOneDismissed: WorkSuggestion[] = [
  suggestion({ id: "s-open-1", title: "Fix flaky reconnect test" }),
  suggestion({ id: "s-open-2", title: "Tighten cookie flags" }),
  suggestion({
    id: "s-gone",
    title: "Already dismissed",
    status: "dismissed",
  }),
];

describe("ThreadView suggested-work chips (issue #550)", () => {
  it("renders only open suggestions under data-suggested-work", () => {
    const html = render({
      detail: detail({
        thread: thread({ suggestions: twoOpenOneDismissed }),
      }),
    });
    assert.ok(
      html.includes("data-suggested-work"),
      "open chips render the strip",
    );
    assert.ok(html.includes('data-suggestion-id="s-open-1"'));
    assert.ok(html.includes('data-suggestion-id="s-open-2"'));
    assert.ok(
      !html.includes('data-suggestion-id="s-gone"'),
      "dismissed chips stay hidden",
    );
    assert.equal(
      (html.match(/data-suggestion-id=/g) || []).length,
      2,
      "exactly two rows",
    );
    assert.ok(html.includes("Fix flaky reconnect test"));
    assert.ok(html.includes("Tighten cookie flags"));
    assert.ok(!html.includes("Already dismissed"));
    assertNoNestedInteractive(html);
  });

  it("still renders open chips when the transcript is empty", () => {
    const html = render({
      detail: detail({
        thread: thread({
          suggestions: [
            suggestion({ id: "s-empty", title: "Empty-transcript chip" }),
          ],
        }),
        messages: [],
        workLog: [],
      }),
    });
    assert.ok(
      html.includes("data-suggested-work"),
      "empty transcript still shows the strip (not a message-only branch)",
    );
    assert.ok(html.includes('data-suggestion-id="s-empty"'));
    assert.ok(html.includes("Empty-transcript chip"));
    assert.ok(
      html.includes("Start by describing what to build"),
      "empty prompt stays visible next to the chips",
    );
  });

  it("renders nothing when there are no suggestions", () => {
    const html = render({ detail: detail({ thread: thread() }) });
    assert.ok(
      !html.includes("data-suggested-work"),
      "absent suggestions hide the strip",
    );
  });

  it("renders nothing when every suggestion is resolved", () => {
    const html = render({
      detail: detail({
        thread: thread({
          suggestions: [
            suggestion({
              id: "s-started",
              title: "Started",
              status: "started",
            }),
            suggestion({
              id: "s-filed",
              title: "Filed",
              status: "filed",
            }),
            suggestion({
              id: "s-dismissed",
              title: "Dismissed",
              status: "dismissed",
            }),
          ],
        }),
      }),
    });
    assert.ok(
      !html.includes("data-suggested-work"),
      "resolved chips hide the strip",
    );
  });
});

describe("ThreadView suggested-work chip actions (issue #550)", () => {
  const openChip = suggestion({
    id: "s-act",
    title: "Fix flaky reconnect test",
    prompt: "Pin the handshake before asserting ready.",
  });

  it("clicking each button fires the matching callback with that suggestion", async () => {
    const started: WorkSuggestion[] = [];
    const filed: WorkSuggestion[] = [];
    const dismissed: WorkSuggestion[] = [];
    const m = await mount(
      view({
        detail: detail({
          thread: thread({ suggestions: [openChip] }),
        }),
        onStartSuggestion: (s) => {
          started.push(s);
        },
        onFileSuggestion: (s) => {
          filed.push(s);
        },
        onDismissSuggestion: (s) => {
          dismissed.push(s);
        },
      }),
    );
    await m.click(m.query('[data-suggestion-action="start"]'));
    await m.click(m.query('[data-suggestion-action="file"]'));
    await m.click(m.query('[data-suggestion-action="dismiss"]'));
    assert.deepEqual(
      started.map((s) => s.id),
      ["s-act"],
    );
    assert.deepEqual(
      filed.map((s) => s.id),
      ["s-act"],
    );
    assert.deepEqual(
      dismissed.map((s) => s.id),
      ["s-act"],
    );
    assert.equal(started[0], openChip);
    assert.equal(filed[0], openChip);
    assert.equal(dismissed[0], openChip);
    m.unmount();
  });

  it("disables the row while its action promise is pending", async () => {
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const other = suggestion({ id: "s-other", title: "Other open chip" });
    const m = await mount(
      view({
        detail: detail({
          thread: thread({ suggestions: [openChip, other] }),
        }),
        onStartSuggestion: () => pending,
      }),
    );
    const row = m.query('[data-suggestion-id="s-act"]') as HTMLElement;
    const otherRow = m.query('[data-suggestion-id="s-other"]') as HTMLElement;
    const start = row.querySelector(
      '[data-suggestion-action="start"]',
    ) as HTMLButtonElement;
    const file = row.querySelector(
      '[data-suggestion-action="file"]',
    ) as HTMLButtonElement;
    const dismiss = row.querySelector(
      '[data-suggestion-action="dismiss"]',
    ) as HTMLButtonElement;
    const otherStart = otherRow.querySelector(
      '[data-suggestion-action="start"]',
    ) as HTMLButtonElement;
    await m.click(start);
    assert.equal(start.disabled, true);
    assert.equal(file.disabled, true, "all buttons on the in-flight row");
    assert.equal(dismiss.disabled, true);
    assert.equal(otherStart.disabled, false, "sibling rows stay enabled");
    release();
    await m.flush();
    assert.equal(start.disabled, false);
    assert.equal(file.disabled, false);
    assert.equal(dismiss.disabled, false);
    m.unmount();
  });
});

/**
 * Issue #564: the renderer only mounts the tail of a long transcript.
 * Marker text is `#${i}#` so `#1#` cannot match `#10#`.
 */
function bulkMessages(n: number): ChatMessage[] {
  const rows: ChatMessage[] = [];
  for (let i = 0; i < n; i++) {
    rows.push(
      msg({
        id: `bulk-${i}`,
        role: "user",
        text: `#${i}#`,
        createdAt: i + 1,
      }),
    );
  }
  return rows;
}

function renderedBulkIds(html: string, n: number): number[] {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    if (html.includes(`#${i}#`)) ids.push(i);
  }
  return ids;
}

describe("ThreadView transcript windowing (issue #564)", () => {
  it("renders only the tail window plus a Show earlier row on a 500-message thread", () => {
    const n = 500;
    const html = render({
      detail: detail({ messages: bulkMessages(n) }),
    });
    const ids = renderedBulkIds(html, n);
    assert.deepEqual(
      ids,
      [...Array(TRANSCRIPT_WINDOW).keys()].map((i) => n - TRANSCRIPT_WINDOW + i),
      "only the last 120 timeline entries mount",
    );
    assert.ok(
      html.includes("data-show-earlier"),
      "Show earlier control must render when entries sit above the window",
    );
    assert.ok(
      html.includes("Show earlier — 380 messages"),
      `expected hidden-count copy, got near: ${html.slice(
        html.indexOf("Show earlier"),
        html.indexOf("Show earlier") + 80,
      )}`,
    );
    assert.ok(!html.includes("#0#"), "the oldest message stays unmounted");
  });

  it("renders a short transcript fully with no Show earlier row", () => {
    const n = 40;
    const html = render({
      detail: detail({ messages: bulkMessages(n) }),
    });
    const ids = renderedBulkIds(html, n);
    assert.equal(ids.length, n, "every message mounts when under the window");
    assert.ok(html.includes("#0#") && html.includes("#39#"));
    assert.ok(
      !html.includes("data-show-earlier"),
      "no Show earlier row when the whole transcript fits",
    );
  });

  it("grows the window by another chunk when Show earlier is clicked", async () => {
    const n = 500;
    const m = await mount(
      view({ detail: detail({ messages: bulkMessages(n) }) }),
    );
    const btn = m.query("[data-show-earlier]");
    assert.ok(btn, "Show earlier button");
    await m.click(btn);
    const ids = renderedBulkIds(m.html(), n);
    assert.equal(ids[0], n - TRANSCRIPT_WINDOW * 2);
    assert.equal(ids[ids.length - 1], n - 1);
    assert.equal(ids.length, TRANSCRIPT_WINDOW * 2);
    assert.ok(
      m.text().includes("Show earlier — 260 messages"),
      "hidden count drops by one chunk",
    );
    assert.ok(!m.html().includes("#0#"), "the oldest message is still above the window");
    m.unmount();
  });

  it("appends a streamed message at the tail without revealing earlier entries", async () => {
    const n = 500;
    const initial = bulkMessages(n);

    function StreamHarness() {
      const [messages, setMessages] = useState(initial);
      return (
        <div>
          <button
            type="button"
            data-append-stream=""
            onClick={() =>
              setMessages((prev) => [
                ...prev,
                msg({
                  id: "streamed-tail",
                  role: "user",
                  text: "STREAMED_TAIL",
                  createdAt: n + 1,
                }),
              ])
            }
          >
            append
          </button>
          {view({ detail: detail({ messages }) })}
        </div>
      );
    }

    const m = await mount(<StreamHarness />);
    assert.ok(!m.html().includes("#0#"), "pre-stream: oldest is windowed out");
    assert.ok(m.html().includes("#499#"), "pre-stream: tail is mounted");
    await m.click(m.query("[data-append-stream]"));
    assert.ok(
      m.text().includes("STREAMED_TAIL"),
      "the streamed message mounts at the tail",
    );
    assert.ok(
      !m.html().includes("#0#"),
      "append must not extend the top of the window",
    );
    assert.ok(
      m.text().includes("Show earlier — 380 messages"),
      "hidden count stays put across a tail append",
    );
    m.unmount();
  });

  it("extends the window to include a jump-to-anchor above it", async () => {
    const n = 500;
    const messages = bulkMessages(n);

    function JumpHarness() {
      const [reveal, setReveal] = useState<string | null>(null);
      return (
        <div>
          <button
            type="button"
            data-jump-early=""
            onClick={() => setReveal(messages[0]!.id)}
          >
            jump
          </button>
          {view({
            detail: detail({ messages }),
            revealMessageId: reveal,
          })}
        </div>
      );
    }

    const m = await mount(<JumpHarness />);
    assert.ok(!m.html().includes("#0#"), "anchor starts above the window");
    await m.click(m.query("[data-jump-early]"));
    assert.ok(
      m.html().includes("#0#"),
      "ensureVisible must raise the window to include the target",
    );
    assert.ok(
      m.html().includes("#499#"),
      "the tail stays mounted after expanding upward",
    );
    m.unmount();
  });

  it("resets the window when switching to another thread", async () => {
    const longThread = detail({
      thread: thread({ id: "t-long" }),
      messages: bulkMessages(500),
    });
    const shortThread = detail({
      thread: thread({ id: "t-short", title: "short" }),
      messages: bulkMessages(8),
    });

    function SwitchHarness() {
      const [open, setOpen] = useState(longThread);
      return (
        <div>
          <button
            type="button"
            data-open-short=""
            onClick={() => setOpen(shortThread)}
          >
            short
          </button>
          {view({ detail: open })}
        </div>
      );
    }

    const m = await mount(<SwitchHarness />);
    assert.ok(m.query("[data-show-earlier]"), "long thread is windowed");
    await m.click(m.query("[data-open-short]"));
    assert.ok(m.html().includes("#0#"), "short thread shows its first message");
    assert.equal(
      m.query("[data-show-earlier]"),
      null,
      "a short thread must not inherit the previous window start",
    );
    m.unmount();
  });
});

