import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { StrictMode } from "react";
import { mount, unmountAll, inAct } from "./support/dom.ts";
import { detail, thread } from "./support/fakeCoder.ts";
import type { ThreadDetail, PendingPermissionInfo } from "../src/shared/ipc";
import { ConversationAnnouncer } from "../src/components/ConversationAnnouncer";
import { ConversationSettings } from "../src/components/ConversationSettings";
import { conversationAnnouncement, conversationState, finalReplyPreview } from "../src/conversationAnnouncements";
import { setConversationAnnouncements, setConversationAnnouncementTitle, getConversationAnnouncements, getConversationAnnouncementTitle } from "../src/uiPrefs";

const working = () => detail({ thread: thread({ title: "My task", status: "working", runStartedAt: 100 }) });
const permission = (requestId = "p1"): PendingPermissionInfo => ({ requestId, toolName: "Bash", summary: "run a command", input: "private tool arguments" });
const render = (d: ThreadDetail, scopeId = "local:t1") => <ConversationAnnouncer detail={d} scopeId={scopeId} />;

afterEach(() => {
  unmountAll();
  setConversationAnnouncements("status");
  setConversationAnnouncementTitle(true);
});

describe("conversation announcement transitions", () => {
  it("distinguishes completion, stop, failure, quota pause and resume", () => {
    const running = working();
    const before = conversationState(running);
    const next = (patch: Partial<ThreadDetail["thread"]>) => {
      const d = { ...running, thread: { ...running.thread, runStartedAt: null, ...patch } };
      return conversationAnnouncement(before, conversationState(d), d, false);
    };
    assert.equal(next({ status: "done" }), "Run finished.");
    assert.equal(next({ status: "idle", stoppedAt: 200 }), "Run stopped.");
    assert.equal(next({ status: "failed", lastError: "sensitive error payload" }), "Run failed. Check the conversation for details.");
    assert.equal(next({ status: "quota-wait" }), "Run paused while waiting for provider quota.");
    const waiting = { ...running, thread: { ...running.thread, status: "quota-wait" as const } };
    assert.equal(conversationAnnouncement(conversationState(waiting), before, running, false), "Run resumed.");
    assert.equal(conversationAnnouncement(null, before, running, false), "Run in progress.");
  });

  it("announces persisted questions once even when the provider ends its turn", () => {
    const d = working();
    d.thread.pendingQuestion = { id: "q1", askedAt: 120, questions: [] };
    const question = conversationState(d);
    assert.match(conversationAnnouncement(null, question, d, false)!, /question needs your answer/);
    const completed = { ...d, thread: { ...d.thread, status: "done" as const, runStartedAt: null } };
    assert.equal(conversationAnnouncement(question, conversationState(completed), completed, false), null);
    const dismissed = { ...completed, thread: { ...completed.thread, pendingQuestion: null } };
    assert.equal(conversationAnnouncement(conversationState(completed), conversationState(dismissed), dismissed, false), null);
  });

  it("recognizes typed input, questions, plans and external approvals without reading their payload", () => {
    const d = working();
    const question = { ...d, pendingPermission: { ...permission(), questions: [{ question: "Private question", header: "Choice", multiSelect: false, options: [] }] } };
    assert.match(conversationAnnouncement(null, conversationState(question), question, false)!, /question needs/);
    const plan = { ...d, pendingPermission: { ...permission(), plan: "Private plan" } };
    assert.match(conversationAnnouncement(null, conversationState(plan), plan, false)!, /plan is ready/);
    const persistedPlan = { ...d, thread: { ...d.thread, pendingPlan: { id: "plan1", plan: "Plan", askedAt: 100 } } };
    assert.equal(conversationState(persistedPlan).kind, "plan");
    const awaiting = { ...d, thread: { ...d.thread, awaitingInput: true } };
    assert.equal(conversationState(awaiting).kind, "input");
    const typed = { ...d, pendingPermission: { ...permission(), inputRequest: { source: "mcp", message: "Private form", fields: [] } } };
    assert.equal(conversationAnnouncement(null, conversationState(typed), typed, false), "Your input is needed below the conversation.");
    const external = { ...d, thread: { ...d.thread, pendingExternalApproval: true } };
    assert.match(conversationAnnouncement(null, conversationState(external), external, false)!, /approval to start/);
  });

  it("bounds reply previews, excludes reasoning and tools, and refuses older replies", () => {
    const d = working();
    d.messages = [
      { id: "old", role: "assistant", text: "Old reply", createdAt: 99 },
      { id: "answer", role: "assistant", text: "## Done\n**Fixed** [the bug](https://example.test)\n```sh\nsecret command\n```\n" + "More detail. ".repeat(100), createdAt: 101 },
      { id: "tool", role: "tool", text: "Tool payload", createdAt: 102 },
      { id: "reasoning", role: "assistant", thinking: true, text: "Private reasoning", createdAt: 103 },
    ];
    const preview = finalReplyPreview(d, 100);
    assert.match(preview, /^Done Fixed the bug Code block in reply\./);
    assert.doesNotMatch(preview, /secret command|example.test|Tool payload|Private reasoning/);
    assert.ok(preview.length <= 601);
    assert.equal(finalReplyPreview(d, 200), "");
    assert.equal(finalReplyPreview(d, null), "");
  });
});

describe("selected-conversation live region", () => {
  it("announces transitions without streaming chatter, repeated requests, or focus changes", async () => {
    const idle = detail({ thread: thread({ title: "My task", status: "idle" }) });
    const m = await mount(<><button>Keep focus</button>{render(idle)}</>);
    const button = m.query("button")! as HTMLElement;
    button.focus();
    const region = () => m.query("[data-conversation-announcer]")!;
    assert.equal(region().textContent, "");
    const live = working();
    const update = (d: ThreadDetail) => m.rerender(<><button>Keep focus</button>{render(d)}</>);
    await update(live);
    assert.equal(region().textContent, "My task. Run started.");
    const startedNode = region().firstChild;
    await update({ ...live, messages: [{ id: "a", role: "assistant", text: "streaming", createdAt: 101 }] });
    assert.equal(region().firstChild, startedNode, "streaming must not mutate the live region");
    const blocked = { ...live, pendingPermission: permission() };
    await update(blocked);
    assert.match(region().textContent!, /Permission needed/);
    const requestNode = region().firstChild;
    await update({ ...blocked, pendingPermission: { ...permission(), summary: "updated summary" } });
    assert.equal(region().firstChild, requestNode);
    await update({ ...blocked, pendingPermission: permission("p2") });
    assert.notEqual(region().firstChild, requestNode, "a second request with the same wording is still announced");
    await update(live);
    assert.match(region().textContent!, /Run resumed/);
    await update({ ...live, thread: { ...live.thread, status: "done", runStartedAt: null }, messages: [{ id: "a", role: "assistant", text: "Final text", createdAt: 101 }] });
    assert.equal(region().textContent, "My task. Run finished.");
    assert.equal(document.activeElement, button);
    assert.equal(region().getAttribute("aria-live"), "polite");
    assert.equal(region().getAttribute("aria-atomic"), "true");
  });

  it("clears old announcements when switching hosts or threads and never reads historical completions", async () => {
    const live = working();
    const m = await mount(render(live));
    assert.match(m.text(), /Run in progress/);
    const old = detail({ thread: thread({ status: "done" }), messages: [{ id: "a", role: "assistant", text: "Historical reply", createdAt: 1 }] });
    await m.rerender(render(old, "remote:t1"));
    assert.equal(m.query("[data-conversation-announcer]")!.textContent, "");
    await m.rerender(render({ ...old, pendingPermission: permission() }, "remote:t2"));
    assert.match(m.text(), /Permission needed/);
    await m.rerender(render(old, "local:t1"));
    assert.equal(m.query("[data-conversation-announcer]")!.textContent, "");
  });

  it("settings apply live, Off stays silent, and enabling previews does not replay an old reply", async () => {
    const live = working();
    const view = (d: ThreadDetail) => <><ConversationSettings />{render(d)}</>;
    const m = await mount(view(live));
    const mode = m.query("#conversation-announcements")!;
    await m.change(mode, "off");
    assert.equal(getConversationAnnouncements(), "off");
    assert.equal(m.query("[data-conversation-announcer]")!.textContent, "");
    assert.equal(m.query("[data-conversation-announcer]")!.getAttribute("aria-live"), "off");
    const completed = { ...live, thread: { ...live.thread, status: "done" as const, runStartedAt: null }, messages: [{ id: "a", role: "assistant" as const, text: "Old final answer", createdAt: 101 }] };
    await m.rerender(view(completed));
    await m.change(mode, "replies");
    assert.equal(m.query("[data-conversation-announcer]")!.textContent, "");
    const titleToggle = m.query('#conversation-announcements')!.parentElement!.querySelector('input[type="checkbox"]')!;
    await m.click(titleToggle);
    assert.equal(getConversationAnnouncementTitle(), false);
    const next = { ...live, thread: { ...live.thread, runStartedAt: 200 } };
    await m.rerender(view(next));
    assert.equal(m.query("[data-conversation-announcer]")!.textContent, "Run started.");
    await m.rerender(view({ ...completed, messages: [{ id: "b", role: "assistant", text: "**New final answer**", createdAt: 201 }] }));
    assert.equal(m.query("[data-conversation-announcer]")!.textContent, "Run finished. Reply: New final answer");
    assert.equal(window.localStorage.getItem("coder.conversationAnnouncements"), "replies");
  });

  it("initial announcements survive React strict effects without duplicate streaming updates", async () => {
    const d = working();
    const m = await mount(<StrictMode>{render(d)}</StrictMode>);
    const node = m.query("[data-conversation-announcer]")!.firstChild;
    assert.match(node!.textContent!, /Run in progress/);
    await m.rerender(<StrictMode>{render({ ...d, thread: { ...d.thread, title: "Renamed" } })}</StrictMode>);
    assert.equal(m.query("[data-conversation-announcer]")!.firstChild, node);
    await inAct(() => setConversationAnnouncementTitle(false));
    assert.equal(m.query("[data-conversation-announcer]")!.textContent, "");
  });
});
