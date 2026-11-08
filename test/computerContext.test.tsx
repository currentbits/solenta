import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { inAct, mount, unmountAll } from "./support/dom.ts";
import { computerApi, useComputerContext } from "../src/coder/computerContext";
import type { AppSettings, CoderApi, HostTag, ProviderInfo } from "../src/shared/ipc";

afterEach(unmountAll);
const local = { agentProfiles: [{ id: "same", name: "Local profile" }] } as AppSettings;
const remote = { agentProfiles: [{ id: "same", name: "Remote profile" }] } as AppSettings;
const providers = [{ id: "remote-only", name: "Remote agent" }] as ProviderInfo[];
const host = (key: string): HostTag => ({ key, label: key, status: "online" });
function deferred<T>() { let resolve!: (x: T) => void; let reject!: (x: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

it("scopes settings, model discovery and writes through existing method channels", async () => {
  const calls: unknown[] = [];
  const api = { settings: { get: (...args: unknown[]) => { calls.push(args); return Promise.resolve(remote); }, set: (...args: unknown[]) => { calls.push(args); return Promise.resolve(remote); } }, providers: { fetchModels: (...args: unknown[]) => { calls.push(args); return Promise.resolve([]); } } } as unknown as CoderApi;
  const scoped = computerApi(api, "work");
  assert.equal(await scoped.settings.get(), remote);
  await scoped.settings.set({ defaultProvider: "remote-only" });
  await scoped.providers.fetchModels({ provider: "remote-only" });
  assert.deepEqual(calls, [[{ onHost: "work" }], [{ defaultProvider: "remote-only" }, { onHost: "work" }], [{ provider: "remote-only" }, { onHost: "work" }]]);
});

it("shows owning-computer profiles and remote-only providers, never a same-ID local profile", async () => {
  let current: ReturnType<typeof useComputerContext>;
  const api = { settings: { get: async () => remote }, providers: { list: async () => providers } } as unknown as CoderApi;
  function View() { current = useComputerContext(api, host("work"), local, []); return <p>{current.settings?.agentProfiles?.[0]?.name} {current.providers.map(p => p.name).join(",")}</p>; }
  const m = await mount(<View />);
  assert.match(m.container.textContent!, /Remote profile Remote agent/);
  assert.doesNotMatch(m.container.textContent!, /Local profile/);
});

it("ignores a late previous-computer reply and fails offline without local fallback", async () => {
  const a = deferred<AppSettings>();
  const b = deferred<AppSettings>();
  let current: ReturnType<typeof useComputerContext>;
  const api = { settings: { get: (scope: { onHost: string }) => scope.onHost === "a" ? a.promise : scope.onHost === "b" ? b.promise : Promise.reject(new Error("Computer is offline")) }, providers: { list: async () => providers } } as unknown as CoderApi;
  function View({ computer }: { computer: string }) { current = useComputerContext(api, host(computer), local, [{ id: "local-only" } as ProviderInfo]); return <p>{current.settings?.agentProfiles?.[0]?.name ?? "Unavailable"} {current.error}</p>; }
  const m = await mount(<View computer="a" />);
  assert.match(m.container.textContent!, /Unavailable/);
  await m.rerender(<View computer="b" />);
  await inAct(async () => { b.resolve(remote); });
  await inAct(async () => { a.resolve(local); });
  assert.match(m.container.textContent!, /Remote profile/);
  assert.deepEqual(current!.providers, providers);
  await m.rerender(<View computer="offline" />);
  assert.match(m.container.textContent!, /Unavailable Computer is offline/);
  assert.equal(current!.settings, null);
  assert.deepEqual(current!.providers, []);
});

it("late writes cannot replace the next computer's settings", async () => {
  const pendingSave = deferred<AppSettings>();
  const settingsB = { agentProfiles: [{ id: "same", name: "B profile" }] } as AppSettings;
  const api = { settings: { get: async (scope: { onHost: string }) => scope.onHost === "a" ? remote : settingsB, set: async () => pendingSave.promise }, providers: { list: async () => providers } } as unknown as CoderApi;
  let current: ReturnType<typeof useComputerContext>;
  function View({ computer }: { computer: string }) { current = useComputerContext(api, host(computer), local, []); return <p>{current.settings?.agentProfiles?.[0]?.name}</p>; }
  const m = await mount(<View computer="a" />);
  const saved = current!.save({ defaultProvider: "remote-only" });
  await m.rerender(<View computer="b" />);
  await inAct(async () => { pendingSave.resolve(local); await saved; });
  assert.match(m.text(), /B profile/);
});

it("local discovery keeps the original API and provider credentials local", () => {
  const api = { settings: { get: async () => local } } as unknown as CoderApi;
  assert.equal(computerApi(api), api);
});

it("passes ownership as the first object for zero-argument catalogs, preserving default input handlers", async () => {
  const inputs: unknown[] = [];
  const list = async (input: { projectPath?: string; onHost?: string } = {}) => { inputs.push(input); return input.projectPath ?? []; };
  const api = { skills: { list }, mcp: { list }, harness: { detectSources: list } } as unknown as CoderApi;
  const scoped = computerApi(api, "work");
  await scoped.skills.list();
  await scoped.mcp.list();
  await scoped.harness.detectSources();
  assert.deepEqual(inputs, [{ onHost: "work" }, { onHost: "work" }, { onHost: "work" }]);
});
