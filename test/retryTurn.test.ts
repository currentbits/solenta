/**
 * Pure Retry-turn decisions (round 48).
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatMessage, WorkflowView } from "../src/shared/ipc";
import {
  failedWorkflowRetryAgentId,
  isInterruptEvent,
  lastEventMessage,
  lastUserMessage,
  retryAnchorEventId,
  retryButtonTitle,
} from "../src/retryTurn";

function m(
  over: Partial<ChatMessage> & Pick<ChatMessage, "role" | "text" | "id">,
): ChatMessage {
  return {
    id: over.id,
    role: over.role,
    text: over.text,
    createdAt: over.createdAt ?? 1,
    runId: over.runId ?? null,
    tool: over.tool,
    thinking: over.thinking,
  };
}

describe("lastUserMessage", () => {
  it("returns the LAST user message, not the first", () => {
    const msgs = [
      m({ id: "u1", role: "user", text: "first prompt" }),
      m({ id: "a1", role: "assistant", text: "reply" }),
      m({ id: "u2", role: "user", text: "second prompt" }),
      m({ id: "e1", role: "event", text: "Run error: boom" }),
    ];
    const last = lastUserMessage(msgs);
    assert.ok(last);
    assert.equal(last.id, "u2");
    assert.equal(last.text, "second prompt");
  });

  it("returns null when no user messages", () => {
    assert.equal(
      lastUserMessage([m({ id: "e1", role: "event", text: "Run error" })]),
      null,
    );
  });
});

describe("retryAnchorEventId", () => {
  const twoUsers = [
    m({ id: "u1", role: "user", text: "older" }),
    m({ id: "a1", role: "assistant", text: "ok" }),
    m({ id: "u2", role: "user", text: "newer fix" }),
    m({ id: "e1", role: "event", text: "Run error: exit 1" }),
  ];

  it("anchors on last message when it is a failed-run event", () => {
    assert.equal(retryAnchorEventId("failed", twoUsers), "e1");
  });

  it("anchors on interrupt event when it is the last message (idle)", () => {
    const msgs = [
      m({ id: "u1", role: "user", text: "do work" }),
      m({ id: "e1", role: "event", text: "Run interrupted by app quit" }),
    ];
    assert.equal(retryAnchorEventId("idle", msgs), "e1");
  });

  it("is null for a stale interrupt after a successful retry (done + later messages)", () => {
    // Reviewer mutant: last-EVENT anchor returned "e1" here. Last-MESSAGE
    // rule requires the interrupt to be the final transcript entry.
    assert.equal(
      retryAnchorEventId("done", [
        m({ id: "u1", role: "user", text: "first" }),
        m({ id: "e1", role: "event", text: "Run interrupted by app quit" }),
        m({ id: "u2", role: "user", text: "retry prompt" }),
        m({ id: "a1", role: "assistant", text: "answered" }),
      ]),
      null,
    );
  });

  it("is null while working even if failed-shaped transcript", () => {
    assert.equal(retryAnchorEventId("working", twoUsers), null);
  });

  it("is null while working when last message is a live interrupt marker", () => {
    // B-2: without the working guard, status working + last interrupt would
    // still show Retry and allow a double-send mid-retry.
    assert.equal(
      retryAnchorEventId("working", [
        m({ id: "u1", role: "user", text: "retry me" }),
        m({ id: "e1", role: "event", text: "Run interrupted by app quit" }),
      ]),
      null,
    );
  });

  it("is null without a user message", () => {
    assert.equal(
      retryAnchorEventId("failed", [
        m({ id: "e1", role: "event", text: "Run error" }),
      ]),
      null,
    );
  });

  it("is null for idle without interrupt marker", () => {
    assert.equal(
      retryAnchorEventId("idle", [
        m({ id: "u1", role: "user", text: "hi" }),
        m({ id: "e1", role: "event", text: "Run stopped" }),
      ]),
      null,
    );
  });

  it("is null when there is no event surface", () => {
    assert.equal(
      retryAnchorEventId("failed", [
        m({ id: "u1", role: "user", text: "only user" }),
      ]),
      null,
    );
  });

  it("is null when the last event is a thinking card, not an interrupt", () => {
    assert.equal(
      retryAnchorEventId("failed", [
        m({ id: "u1", role: "user", text: "prompt" }),
        m({
          id: "e1",
          role: "event",
          text: "I should read ThreadView first.",
          thinking: true,
        }),
      ]),
      null,
    );
  });

  it("is null when last message is not an event even if an older interrupt exists", () => {
    assert.equal(
      retryAnchorEventId("failed", [
        m({ id: "u1", role: "user", text: "prompt" }),
        m({ id: "e1", role: "event", text: "Run error: boom" }),
        m({ id: "a1", role: "assistant", text: "partial" }),
      ]),
      null,
    );
  });

  it("still anchors when the last event is this Build and a slot failed", () => {
    const wfMsgs = [
      m({
        id: "u1",
        role: "user",
        text: "build the login form",
        runId: "wf-run",
      }),
      m({
        id: "e-kick",
        role: "event",
        text: "Kicked off 4 subagents\nplan 1",
        runId: "wf-run",
      }),
      m({
        id: "e1",
        role: "event",
        text: "Run error (plan-1):\nbad spawn",
        runId: "wf-run",
      }),
    ];
    const workflow = wfView({
      id: "wf-run",
      agents: [{ id: "plan-1", status: "failed" }],
    });
    assert.equal(retryAnchorEventId("failed", wfMsgs, workflow), "e1");
    assert.equal(
      retryAnchorEventId(
        "idle",
        [
          m({ id: "u1", role: "user", text: "build it", runId: "wf-run" }),
          m({
            id: "e1",
            role: "event",
            text: "Run interrupted by app quit",
            runId: "wf-run",
          }),
        ],
        workflow,
      ),
      "e1",
    );
  });

  it("is null when the last event is this Build but no slot failed", () => {
    const workflow = wfView({
      id: "wf-run",
      agents: [{ id: "plan-1", status: "settled" }],
    });
    assert.equal(
      retryAnchorEventId(
        "failed",
        [
          m({ id: "u1", role: "user", text: "build it", runId: "wf-run" }),
          m({
            id: "e1",
            role: "event",
            text: "Run error: exit 1",
            runId: "wf-run",
          }),
        ],
        workflow,
      ),
      null,
    );
  });

  it("still anchors when a leftover workflow id does not match the last run", () => {
    assert.equal(
      retryAnchorEventId(
        "failed",
        [
          m({ id: "u1", role: "user", text: "older build", runId: "wf-run" }),
          m({
            id: "e-old",
            role: "event",
            text: "Kicked off 2 subagents",
            runId: "wf-run",
          }),
          m({ id: "u2", role: "user", text: "later chat", runId: "chat-2" }),
          m({
            id: "e1",
            role: "event",
            text: "Run error: exit 1",
            runId: "chat-2",
          }),
        ],
        wfView({
          id: "wf-run",
          agents: [{ id: "plan-1", status: "settled" }],
        }),
      ),
      "e1",
    );
  });
});

function wfView(over: {
  id?: string;
  agents?: Array<{
    id: string;
    status: WorkflowView["phases"][0]["agents"][0]["status"];
  }>;
  phases?: WorkflowView["phases"];
}): WorkflowView {
  const agents = (
    over.agents ?? [{ id: "plan-1", status: "failed" as const }]
  ).map((a) => ({
    id: a.id,
    model: "grok",
    status: a.status,
    tokensUsed: 0,
  }));
  return {
    id: over.id ?? "wf-run",
    name: "WF-test",
    phases: over.phases ?? [{ name: "plan", pipelined: false, agents }],
    settled: 0,
    total: agents.length,
    tokensTotal: 0,
    complete: false,
  };
}

describe("failedWorkflowRetryAgentId", () => {
  it("returns the first failed agent in Agents-panel order", () => {
    const workflow = wfView({
      phases: [
        {
          name: "plan",
          pipelined: false,
          agents: [
            { id: "plan-1", model: "grok", status: "settled", tokensUsed: 1 },
            { id: "plan-2", model: "grok", status: "failed", tokensUsed: 0 },
          ],
        },
        {
          name: "build",
          pipelined: false,
          agents: [
            { id: "build-1", model: "grok", status: "failed", tokensUsed: 0 },
          ],
        },
      ],
    });
    assert.equal(failedWorkflowRetryAgentId(workflow, "failed"), "plan-2");
  });

  it("is null while the thread is working", () => {
    assert.equal(
      failedWorkflowRetryAgentId(
        wfView({ agents: [{ id: "plan-1", status: "failed" }] }),
        "working",
      ),
      null,
    );
  });

  it("is null when no agent failed", () => {
    assert.equal(
      failedWorkflowRetryAgentId(
        wfView({ agents: [{ id: "plan-1", status: "settled" }] }),
        "failed",
      ),
      null,
    );
  });

  it("is null without a workflow", () => {
    assert.equal(failedWorkflowRetryAgentId(null, "failed"), null);
  });
});

describe("retryButtonTitle", () => {
  it("prefixes Retry: and truncates long text at ~60 codepoints", () => {
    const long = "x".repeat(80);
    const title = retryButtonTitle(long);
    assert.ok(title.startsWith("Retry: "));
    assert.ok(title.endsWith("…"));
    assert.ok(title.length < 80);
  });

  it("keeps short text intact", () => {
    assert.equal(
      retryButtonTitle("fix the sidebar chip"),
      "Retry: fix the sidebar chip",
    );
  });

  it("does not split a trailing surrogate pair when truncating", () => {
    // 59 ASCII + one emoji (two UTF-16 units, one codepoint) → keep emoji.
    const text = `${"a".repeat(59)}\u{1F680}extra`;
    const title = retryButtonTitle(text);
    assert.equal(title, `Retry: ${"a".repeat(59)}\u{1F680}…`);
  });
});

describe("isInterruptEvent / lastEventMessage", () => {
  it("detects the interruption marker substring", () => {
    assert.equal(isInterruptEvent("Run interrupted by app quit"), true);
    assert.equal(isInterruptEvent("Run interrupted: crash"), true);
    assert.equal(isInterruptEvent("Run error: boom"), false);
  });

  it("picks the last event, not the first", () => {
    const last = lastEventMessage([
      m({ id: "e1", role: "event", text: "Run stopped" }),
      m({ id: "u1", role: "user", text: "again" }),
      m({ id: "e2", role: "event", text: "Run error" }),
    ]);
    assert.equal(last?.id, "e2");
  });
});
