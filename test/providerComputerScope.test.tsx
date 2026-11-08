import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount, inAct } from "./support/dom.ts";
import { createFakeCoder, installFakeCoder, thread } from "./support/fakeCoder.ts";
import { useCoder, type UseCoderResult } from "../src/useCoder";
import type { ProviderInfo } from "../src/shared/ipc";

const catalog = (model: string): ProviderInfo[] => [{ id: "claude", name: "Claude Code", available: true, supportsResume: true, models: [model], modelInfo: [{ id: model, label: model, description: "", vendor: "Anthropic", efforts: ["high"] }], efforts: ["high"] }];

describe("provider computer scope (#1932)", () => {
  it("refreshes between worktrees in one project and rejects the previous worktree's late capabilities", async () => {
    const shell = await mount(<div />);
    const a = thread({ id: "worktree-a", worktreePath: "/repo/worktrees/a" });
    const b = thread({ id: "worktree-b", worktreePath: "/repo/worktrees/b" });
    const fake = createFakeCoder({ threads: [a, b] });
    const requests: string[] = [];
    const pending = new Map<string, (rows: ProviderInfo[]) => void>();
    fake.api.providers.list = async (input) => {
      if (!input?.threadId) return catalog("settings-model");
      requests.push(input.threadId);
      return new Promise((resolve) => pending.set(input.threadId, resolve));
    };
    installFakeCoder(fake);
    shell.unmount();
    let current!: UseCoderResult;
    function Probe() { current = useCoder(); return null; }
    const m = await mount(<Probe />);
    try {
      await m.flush();
      assert.deepEqual(requests, [a.id]);
      await inAct(() => current.selectThread(b.id));
      await m.flush();
      assert.deepEqual(requests, [a.id, b.id], "same project/account still discovers each worktree's context");
      await inAct(() => pending.get(a.id)!(catalog("a-discovered")));
      assert.deepEqual(current.threadProviders, [], "late capabilities cannot cross worktrees");
      await inAct(() => pending.get(b.id)!(catalog("b-project-fallback")));
      assert.deepEqual(current.threadProviders[0]?.models, ["b-project-fallback"]);
      await inAct(() => fake.emitThreads([a, { ...b, worktreePath: "/repo/worktrees/recreated-b" }]));
      await m.flush();
      assert.deepEqual(requests, [a.id, b.id, b.id], "a recreated worktree refreshes even for the same thread");
      assert.deepEqual(current.threadProviders, [], "old worktree metadata is hidden during refresh");
      await inAct(() => pending.get(b.id)!(catalog("recreated-b")));
      assert.deepEqual(current.threadProviders[0]?.models, ["recreated-b"]);
    } finally { m.unmount(); }
  });

  it("keeps a late local thread catalog separate from the local Settings boot list and refresh", async () => {
    const shell = await mount(<div />);
    const local = thread({ id: "local-scoped" });
    const fake = createFakeCoder({ threads: [local] });
    const requests: Array<{ threadId?: string } | undefined> = [];
    let finishThread!: (rows: ProviderInfo[]) => void;
    let localReads = 0;
    fake.api.providers.list = async (input) => {
      requests.push(input);
      if (!input?.threadId) return catalog(++localReads === 1 ? "settings-boot" : "settings-refresh");
      return new Promise((resolve) => { finishThread = resolve; });
    };
    installFakeCoder(fake);
    shell.unmount();
    let current!: UseCoderResult;
    function Probe() { current = useCoder(); return null; }
    const m = await mount(<Probe />);
    await m.flush();
    assert.deepEqual(requests, [undefined, { threadId: local.id }]);
    assert.deepEqual(current.providers[0]?.models, ["settings-boot"]);
    assert.deepEqual(current.threadProviders, [], "thread-specific catalog does not borrow local Settings metadata");
    await inAct(() => current.refreshProviders());
    assert.deepEqual(current.providers[0]?.models, ["settings-refresh"]);
    await inAct(() => finishThread(catalog("project-catalog")));
    assert.deepEqual(current.threadProviders[0]?.models, ["project-catalog"]);
    assert.deepEqual(current.providers[0]?.models, ["settings-refresh"], "late thread reply cannot overwrite local Settings");
    m.unmount();
  });

  it("routes the selected remote thread, rejects late account replies, and keeps Settings on local providers", async () => {
    const shell = await mount(<div />);
    const local = thread({ id: "local" });
    const host = { key: "computer-b", label: "Computer B", status: "online" as const };
    const a = thread({ id: "remote-a", host, providerInstance: "a" });
    const b = thread({ id: "remote-b", host: { ...host, key: "computer-c", label: "Computer C" }, providerInstance: "b" });
    const fake = createFakeCoder({ threads: [local, a, b], providers: catalog("local-model") });
    const requests: string[] = [];
    const pending = new Map<string, (rows: ProviderInfo[]) => void>();
    fake.api.providers.list = async (input) => {
      if (!input?.threadId || input.threadId === local.id) return catalog("local-model");
      const id = input.threadId;
      requests.push(id);
      return new Promise((resolve) => pending.set(id, resolve));
    };
    installFakeCoder(fake);
    shell.unmount();
    let current!: UseCoderResult;
    function Probe() { current = useCoder(); return null; }
    const m = await mount(<Probe />);
    await m.flush();
    assert.deepEqual(current.providers[0]?.models, ["local-model"]);
    await inAct(() => current.selectThread(a.id));
    await m.flush();
    assert.deepEqual(requests, [a.id]);
    assert.deepEqual(current.threadProviders, [], "local catalog never appears in a remote picker");
    await inAct(() => current.selectThread(b.id));
    await m.flush();
    assert.deepEqual(requests, [a.id, b.id]);
    await inAct(() => pending.get(a.id)!(catalog("account-a-model")));
    assert.deepEqual(current.threadProviders, [], "an older account reply is discarded");
    const oldB = pending.get(b.id)!;
    await inAct(() => current.saveSettings({ providerInstances: [{ id: "b", name: "b", provider: "claude", configDir: null, env: { ANTHROPIC_BASE_URL: "https://changed.invalid" } }] }));
    await m.flush();
    await inAct(() => oldB(catalog("before-configuration-change")));
    assert.deepEqual(current.threadProviders, [], "same account id with changed configuration discards the older reply");
    await inAct(() => current.refreshProviders());
    await inAct(() => pending.get(b.id)!(catalog("account-b-model")));
    assert.deepEqual(current.threadProviders[0]?.models, ["account-b-model"], "overlapping local refresh does not cancel remote discovery");
    await inAct(() => current.refreshProviders());
    assert.deepEqual(current.providers[0]?.models, ["local-model"], "Settings refresh stays on this computer");
    assert.deepEqual(current.threadProviders[0]?.models, ["account-b-model"], "local refresh cannot overwrite remote models");
    await inAct(() => current.selectThread(local.id));
    await m.flush();
    assert.deepEqual(current.threadProviders[0]?.models, ["local-model"]);
    m.unmount();
  });
});
