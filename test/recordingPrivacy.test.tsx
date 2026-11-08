import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mount, inAct } from "./support/dom.ts";
import { createFakeCoder, installFakeCoder, thread, detail } from "./support/fakeCoder.ts";
import App from "../src/App";
import { parseRecordingPrivacy, recordingVisibility, RECORDING_PRIVACY_KEY } from "../src/recordingPrivacy";
import { useRecordingPrivacy } from "../src/app/useRecordingPrivacy";
import type { UseCoderResult } from "../src/useCoder";

const secret = thread({ id: "secret", title: "Private customer title", tags: ["private"], status: "working" });
const publicThread = thread({ id: "public", title: "Public work", tags: ["demo"] });
const enabled = { enabled: true, hiddenTags: ["private"] };

afterEach(() => { if (typeof window !== "undefined") window.localStorage.removeItem(RECORDING_PRIVACY_KEY); });

async function boot(recording = false, status: "idle" | "working" = "working", queued: typeof secret.queued = null) {
  const privateThread = { ...secret, status, queued };
  const shell = await mount(<div />);
  window.localStorage.setItem(RECORDING_PRIVACY_KEY, JSON.stringify({ ...enabled, enabled: recording }));
  const fake = createFakeCoder({ threads: [privateThread, publicThread], details: {
    secret: detail({ thread: privateThread, messages: [{ id: "secret-prompt", role: "user", text: "Sensitive scheduling prompt", createdAt: Date.now() }, { id: "secret-message", role: "assistant", text: "CONFIDENTIAL transcript", createdAt: Date.now() }] }),
    public: detail({ thread: publicThread }),
  } });
  installFakeCoder(fake);
  shell.unmount();
  const app = await mount(<App />);
  await app.flush();
  return { app, fake };
}

async function changeMode(app: Awaited<ReturnType<typeof mount>>, on: boolean) {
  if (!on) { await app.click(app.byText("End recording mode")); return; }
  await app.click(app.byText("Recording mode"));
  await app.click(app.byText("Start recording mode"));
}

describe("recording privacy", () => {
  it("filters matching tags without changing thread data; handles invalid saved preferences", () => {
    assert.deepEqual(parseRecordingPrivacy("{bad"), { enabled: false, hiddenTags: [] });
    assert.deepEqual(parseRecordingPrivacy('{"enabled":true,"hiddenTags":["private",null,2,"private",""]}'), enabled);
    const model = recordingVisibility([secret, publicThread], enabled);
    assert.deepEqual(model.threads.map((t) => t.id), ["public"]);
    assert.equal(model.visible("unknown-server-result"), false);
    assert.equal(secret.status, "working");
    assert.deepEqual(secret.tags, ["private"]);
    assert.equal(recordingVisibility([secret, publicThread], { ...enabled, enabled: false }).threads.length, 2);
  });

  it("hides the open transcript immediately and restores it on exit without changing or stopping threads", async () => {
    const { app, fake } = await boot();
    assert.match(app.text(), /CONFIDENTIAL transcript/);
    await changeMode(app, true);
    assert.ok(app.query("[data-recording-mode]"));
    assert.doesNotMatch(app.text(), /CONFIDENTIAL|Private customer title/);
    assert.equal(app.query('button[aria-label="Select thread: Private customer title"]'), null);
    assert.ok(app.query('button[aria-label="Select thread: Public work"]'));
    await changeMode(app, false);
    assert.match(app.text(), /CONFIDENTIAL transcript/);
    assert.equal(fake.of("runs.stop").length, 0);
    assert.equal(fake.of("runs.stopAll").length, 0);
    assert.equal(fake.of("threads.setArchived").length, 0);
    app.unmount();
  });

  it("keeps selected visible work on exit, guards navigation history and removes cached palette hits", async () => {
    const { app } = await boot();
    await app.click(app.query('button[aria-label="Select thread: Public work"]'));
    await inAct(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })));
    assert.match(app.text(), /Private customer title/);
    await changeMode(app, true);
    assert.doesNotMatch(app.text(), /Private customer title|CONFIDENTIAL/);
    await inAct(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await app.click(app.query('[data-history-back]'));
    assert.doesNotMatch(app.text(), /CONFIDENTIAL/);
    await changeMode(app, false);
    assert.doesNotMatch(app.text(), /CONFIDENTIAL/);
    app.unmount();
  });

  it("removes already cached transcript snippets while the palette stays open", async () => {
    const { app, fake } = await boot();
    fake.api.threads.search = async () => ({ threads: [secret, publicThread], truncated: false });
    fake.api.threads.searchMessages = async () => ({ hits: [{ threadId: secret.id, messageId: "secret-message", snippet: "PRIVATE SEARCH EXCERPT", createdAt: Date.now() }], truncated: false });
    await inAct(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })));
    await app.type(app.query("[data-command-palette-dialog] input"), "customer");
    await inAct(async () => { await new Promise((resolve) => setTimeout(resolve, 220)); });
    assert.match(app.query("[data-command-palette-dialog]")?.textContent ?? "", /PRIVATE SEARCH EXCERPT/);
    await inAct(async () => window.dispatchEvent(new window.StorageEvent("storage", { key: RECORDING_PRIVACY_KEY, newValue: JSON.stringify(enabled) })));
    assert.ok(app.query("[data-command-palette-dialog]"));
    assert.equal((app.query("[data-command-palette-dialog] input") as HTMLInputElement)?.value, "customer", "query survives mode toggle");
    assert.doesNotMatch(app.text(), /PRIVATE SEARCH EXCERPT|Private customer title/);
    app.unmount();
  });

  it("refreshes sidebar content search when recording ends without changing its query", async () => {
    const { app, fake } = await boot(true);
    fake.api.threads.search = async (input) => ({
      threads: [secret, publicThread].filter((t) => !input.threadIds || input.threadIds.includes(t.id)),
      truncated: false,
    });
    const input = app.query('input[placeholder="Search threads…"]') as HTMLInputElement;
    await app.type(input, "needle");
    await inAct(async () => { await new Promise((resolve) => setTimeout(resolve, 320)); });
    assert.equal(app.query('button[aria-label="Select thread: Private customer title"]'), null);
    await changeMode(app, false);
    await inAct(async () => { await new Promise((resolve) => setTimeout(resolve, 320)); });
    assert.equal(input.value, "needle");
    assert.ok(app.query('button[aria-label^="Select thread: Private customer title"]'), "private content match returns for the unchanged query");
    app.unmount();
  });

  it("refreshes palette message search when recording ends without clearing its query", async () => {
    const { app, fake } = await boot(true);
    fake.api.threads.searchMessages = async (input) => ({
      hits: [secret, publicThread].filter((t) => !input.threadIds || input.threadIds.includes(t.id)).map((t) => ({ threadId: t.id, messageId: t.id, snippet: t.id === "secret" ? "RESTORED PRIVATE EXCERPT" : "Public excerpt", createdAt: Date.now() })),
      truncated: false,
    });
    await inAct(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })));
    const input = app.query("[data-command-palette-dialog] input") as HTMLInputElement;
    await app.type(input, "needle");
    await inAct(async () => { await new Promise((resolve) => setTimeout(resolve, 220)); });
    assert.doesNotMatch(app.text(), /RESTORED PRIVATE EXCERPT/);
    await inAct(async () => window.dispatchEvent(new window.StorageEvent("storage", { key: RECORDING_PRIVACY_KEY, newValue: JSON.stringify({ ...enabled, enabled: false }) })));
    await inAct(async () => { await new Promise((resolve) => setTimeout(resolve, 220)); });
    assert.equal(input.value, "needle");
    assert.match(app.query("[data-command-palette-dialog]")?.textContent ?? "", /RESTORED PRIVATE EXCERPT/);
    app.unmount();
  });

  it("configures hidden tags and persists them across mounts", async () => {
    const { app } = await boot();
    await app.click(app.byText("Recording mode"));
    const check = app.query('section[aria-label="Recording privacy"] input[type="checkbox"]') as HTMLInputElement;
    assert.ok(check);
    await app.click(check);
    const stored = parseRecordingPrivacy(window.localStorage.getItem(RECORDING_PRIVACY_KEY));
    assert.ok(stored.hiddenTags.includes("demo"));
    app.unmount();
    const again = await mount(<App />);
    await again.click(again.byText("Recording mode"));
    assert.equal((again.query('section[aria-label="Recording privacy"] input[type="checkbox"]') as HTMLInputElement).checked, true);
    again.unmount();
  });

  it("receives recording changes from other windows before rendering hidden content", async () => {
    const { app } = await boot();
    await inAct(async () => window.dispatchEvent(new window.StorageEvent("storage", { key: RECORDING_PRIVACY_KEY, newValue: JSON.stringify(enabled) })));
    assert.doesNotMatch(app.text(), /Private customer title|CONFIDENTIAL/);
    assert.ok(app.query("[data-recording-mode]"));
    app.unmount();
  });


  it("preserves dirty notes when another window hides and restores the open thread", async () => {
    const { app, fake } = await boot();
    await app.click(app.query("[data-thread-details-btn]"));
    await app.click(app.query("[data-thread-notes-btn]"));
    await app.type(app.query("[data-thread-notes-input]"), "Unsaved private note");
    const writesBefore = fake.of("threads.setNotes").length;
    await inAct(async () => window.dispatchEvent(new window.StorageEvent("storage", { key: RECORDING_PRIVACY_KEY, newValue: JSON.stringify(enabled) })));
    assert.equal(app.query("[data-thread-notes-input]"), null);
    assert.equal(fake.of("threads.setNotes").length, writesBefore, "mode does not write the note");
    await inAct(async () => window.dispatchEvent(new window.StorageEvent("storage", { key: RECORDING_PRIVACY_KEY, newValue: JSON.stringify({ ...enabled, enabled: false }) })));
    assert.equal((app.query("[data-thread-notes-input]") as HTMLTextAreaElement)?.value, "Unsaved private note");
    app.unmount();
  });

  it("preserves an unsaved queued follow-up edit through recording mode", async () => {
    const { app } = await boot(false, "working", { prompt: "Queued thought", items: ["Queued thought"] });
    await app.click(app.query("[data-edit-queued]"));
    await app.type(app.query("[data-edit-queued-input]"), "Unsaved queued edit");
    await inAct(async () => window.dispatchEvent(new window.StorageEvent("storage", { key: RECORDING_PRIVACY_KEY, newValue: JSON.stringify(enabled) })));
    assert.equal(app.query("[data-edit-queued-input]"), null);
    await inAct(async () => window.dispatchEvent(new window.StorageEvent("storage", { key: RECORDING_PRIVACY_KEY, newValue: JSON.stringify({ ...enabled, enabled: false }) })));
    assert.equal((app.query("[data-edit-queued-input]") as HTMLTextAreaElement)?.value, "Unsaved queued edit");
    app.unmount();
  });

  it("masks a scheduling draft from a hidden thread and restores its unsaved edits", async () => {
    const { app } = await boot(false, "idle");
    await app.click(app.query("[data-thread-title-menu]"));
    await app.click(app.query("[data-repeat-schedule]"));
    assert.ok(app.query("[data-automation-create]"));
    await app.type(app.query('input[aria-label="Name"]'), "Unsaved private schedule");
    await inAct(async () => window.dispatchEvent(new window.StorageEvent("storage", { key: RECORDING_PRIVACY_KEY, newValue: JSON.stringify(enabled) })));
    assert.equal(app.query("[data-automation-create]"), null);
    assert.doesNotMatch(app.text(), /Sensitive scheduling prompt|Private customer title|Unsaved private schedule/);
    await inAct(async () => window.dispatchEvent(new window.StorageEvent("storage", { key: RECORDING_PRIVACY_KEY, newValue: JSON.stringify({ ...enabled, enabled: false }) })));
    assert.equal((app.query('input[aria-label="Name"]') as HTMLInputElement)?.value, "Unsaved private schedule");
    assert.equal((app.query('textarea[aria-label="Prompt"]') as HTMLTextAreaElement)?.value, "Sensitive scheduling prompt");
    app.unmount();
  });

  it("counts hidden runs in the explicit Stop all confirmation", async () => {
    const { app, fake } = await boot(true);
    await inAct(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })));
    await app.click(app.byText("Stop all running threads"));
    assert.match(app.query("[data-stop-all-confirm]")?.textContent ?? "", /Stop 1 running thread/);
    assert.equal(fake.of("runs.stopAll").length, 0);
    app.unmount();
  });

  it("filters remote search, previews, reports, teams and in-flight responses through the same current visibility", async () => {
    const shell = await mount(<div />);
    window.localStorage.setItem(RECORDING_PRIVACY_KEY, JSON.stringify(enabled));
    shell.unmount();
    const fake = createFakeCoder({ threads: [secret, publicThread] });
    const base = { ...fake.api };
    Object.assign(base.threads, { pendingApprovals: async () => [{ threadId: "secret" }, { threadId: "public" }] });
    Object.assign(base.fleet, { evidence: async () => ({ threads: [{ threadId: "secret" }, { threadId: "public" }], prs: [{ threadId: "secret" }, { threadId: "public" }, { threadId: null }] }) });
    Object.assign(base.insights, { failureModes: async () => [{ id: "mixed", offenders: [{ threadId: "secret" }, { threadId: "public" }] }, { id: "public-mode", offenders: [{ threadId: "public" }] }] });
    let resolveSearch!: (result: { threads: typeof secret[]; truncated: boolean }) => void;
    const searched: unknown[] = [];
    const backend = {
      api: base, threads: [secret, publicThread], selectedThreadId: "secret", detail: detail({ thread: secret }),
      selectThread: () => {},
      searchThreads: async (input: unknown) => { searched.push(input); return new Promise((res) => { resolveSearch = res; }); },
      searchMessages: async () => ({ hits: [{ threadId: "secret", snippet: "leak" }, { threadId: "public", snippet: "fine" }], truncated: false }),
      peekThread: async (id: string) => detail({ thread: id === "secret" ? secret : publicThread }),
      listThreadSummaries: async () => [secret, publicThread],
      listCrewTasks: async () => ({ rootThreadId: "public", tasks: [{ id: "secret-task", owner: "secret" }, { id: "public-task", owner: "public" }] }),
      crewIntegration: async () => ({ workers: [{ workerId: "secret" }, { workerId: "public" }], receipts: [{ workerId: "secret" }] }),
      listActivity: async () => [{ threadId: "secret" }, { threadId: "public" }],
      listDigest: async () => ({ runs: [{ threadId: "secret" }, { threadId: "public" }] }),
      listUsageByDay: async () => ({ byDay: {}, threadsByDay: { today: { secret: { title: "leak" }, public: { title: "fine" } } } }),
      listLanes: async () => [{ threadId: "secret" }, { threadId: "public" }],
      listAutomationRuns: async () => ({ runs: [{ threadId: "secret" }, { threadId: "public" }] }),
    } as unknown as UseCoderResult;
    let current!: ReturnType<typeof useRecordingPrivacy>;
    function Harness() { current = useRecordingPrivacy(backend); return <div />; }
    const m = await mount(<Harness />);
    const read = current.coder;
    assert.equal(read.selectedThreadId, null);
    assert.equal(read.detail, null);
    assert.equal((await read.api.threads.pendingApprovals()).length, 1);
    assert.equal((await read.api.fleet.evidence({ days: 90 })).threads.length, 1);
    assert.equal((await read.api.fleet.evidence({ days: 90 })).prs.length, 2);
    assert.deepEqual((await read.api.insights.failureModes()).map((m) => m.id), ["public-mode"]);
    assert.deepEqual((await read.searchMessages({ query: "term" })).hits.map((h) => h.threadId), ["public"]);
    await assert.rejects(read.peekThread("secret"), /hidden/);
    assert.deepEqual((await read.listThreadSummaries()).map((t) => t.id), ["public"]);
    assert.equal((await read.listCrewTasks("public")).tasks.length, 1);
    assert.equal((await read.crewIntegration("public")).workers.length, 1);
    assert.equal((await read.crewIntegration("public")).receipts.length, 0);
    assert.equal((await read.listActivity()).length, 1);
    assert.equal((await read.listDigest()).runs.length, 1);
    assert.deepEqual(Object.keys((await read.listUsageByDay()).threadsByDay.today), ["public"]);
    assert.equal((await read.listLanes({ projectId: "p1" })).length, 1);
    assert.equal((await read.listAutomationRuns("automation")).runs.length, 1);
    const pending = read.searchThreads({ query: "term", threadIds: ["secret", "public"] });
    assert.deepEqual(searched, [{ query: "term", threadIds: ["public"] }]);
    resolveSearch({ threads: [secret, publicThread], truncated: false });
    assert.deepEqual((await pending).threads.map((t) => t.id), ["public"]);
    // The same function captured while mode is off must consult the latest
    // visibility when an older backend request eventually returns.
    await inAct(async () => current.updatePrivacy({ ...enabled, enabled: false }));
    const late = read.searchThreads({ query: "old" });
    await inAct(async () => current.updatePrivacy(enabled));
    resolveSearch({ threads: [secret, publicThread], truncated: false });
    assert.deepEqual((await late).threads.map((t) => t.id), ["public"]);
    m.unmount();
  });
});
