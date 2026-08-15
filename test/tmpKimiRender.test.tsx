/**
 * TEMP diagnostic: render the LIVE kimi k3 thread data from the real
 * coder-store.json through ThreadView and check tool cards + Work Log render.
 * Run: node --import=./test/support/render.mjs --test test/tmpKimiRender.test.tsx
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { ThreadView } from "../src/components/ThreadView";
import type { ThreadDetail } from "../src/shared/ipc";

const store = JSON.parse(
  fs.readFileSync(
    path.join(os.homedir(), "Library/Application Support/Solenta/coder-store.json"),
    "utf8",
  ),
);
const THREAD_ID = "9f493640-1ccc-47fd-b642-0006cc34989b";
const rawThread = (Array.isArray(store.threads)
  ? store.threads
  : Object.values(store.threads)
).find((t: { id: string }) => t.id === THREAD_ID);
const messages = store.messagesByThread[THREAD_ID];
const workLog = store.workLogByThread[THREAD_ID];

const detail: ThreadDetail = {
  thread: {
    id: rawThread.id,
    projectId: rawThread.projectId,
    title: rawThread.title,
    branch: rawThread.branch ?? null,
    prNumber: null,
    prUrl: null,
    status: rawThread.status,
    createdAt: rawThread.createdAt,
    updatedAt: rawThread.updatedAt,
    runStartedAt: rawThread.runStartedAt ?? null,
    archived: false,
    settledOverride: null,
    settledAt: null,
    pinnedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: null,
    prState: null,
    provider: rawThread.provider,
    model: rawThread.model ?? null,
    sessionId: rawThread.sessionId ?? null,
    permissionMode: rawThread.permissionMode ?? "default",
    reasoningEffort: rawThread.reasoningEffort ?? null,
    worktreePath: rawThread.worktreePath ?? null,
  },
  messages,
  workLog,
  workflow: null,
  usage: store.usageByThread?.[THREAD_ID] ?? null,
} as ThreadDetail;

const noopAsync = async () => {};

it("renders kimi k3 worklog + tool cards from the live store", () => {
  const html = renderToStaticMarkup(
    <ThreadView
      detail={detail}
      project={{ id: "p1", slug: "a/b", name: "b", path: "/tmp" }}
      providers={[
        {
          id: "kimi",
          name: "Kimi Code",
          available: true,
          supportsResume: true,
          models: ["kimi-code/k3"],
          modelInfo: [],
          efforts: [],
        },
      ]}
      workflows={[]}
      hasProjects
      onAddProject={() => {}}
      onStartRun={() => {}}
      onStartWorkflow={() => {}}
      onSaveWorkflow={noopAsync as never}
      onRemoveWorkflow={noopAsync}
      onStopRun={() => {}}
      onSetPermissionMode={() => {}}
      onSetProvider={() => {}}
      onSetReasoningEffort={() => {}}
      onSetArchived={() => {}}
      onDeleteThread={() => {}}
      changesOpen={false}
      changesNonce={0}
      onCloseChanges={() => {}}
      onFetchDiff={async () => ({ files: [], patch: "", truncated: false })}
      onCommitChanges={async () => ({ subject: "x" })}
      onRevertFile={async (p) => ({ path: p })}
      onSuggestCommitMessage={async () => ({ message: "x" })}
      onPush={async () => ({ remote: "origin", branch: "main" })}
    />,
  );
  const toolCount = (html.match(/toolCard/g) ?? []).length;
  console.log("HTML length:", html.length);
  console.log("contains 'Work Log':", html.includes("Work Log"));
  console.log("toolCard count:", toolCount);
  console.log("contains 'Grep':", html.includes("Grep"));
  console.log("contains user prompt:", html.includes("Worklogs and toolcalls"));
  assert.ok(html.includes("Work Log"), "Work Log card missing");
  assert.ok(toolCount > 0, "no tool cards rendered");
});
