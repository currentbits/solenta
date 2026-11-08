import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppSettings, CoderApi, HostTag, ProviderInfo, SidebarHostStatus, WorkflowTemplateInfo } from "../shared/ipc";

/** Global discovery has no project/thread ID, so carry ownership through the
 * existing authenticated host router. Never expose an arbitrary invoke API. */
export function computerApi(api: CoderApi, hostKey?: string): CoderApi {
  if (!hostKey) return api;
  const next = { ...api };
  for (const namespace of ["settings", "providers", "skills", "mcp", "harness", "sourceControl", "workflows"] as const) {
    const methods = api[namespace];
    if (!methods) continue;
    next[namespace] = Object.fromEntries(Object.entries(methods).map(([name, method]) => [name,
      typeof method === "function" ? (...args: unknown[]) => {
        if (args.length === 0 || args[0] === undefined) return method({ onHost: hostKey });
        return method(args[0], { ...(args[1] as object ?? {}), onHost: hostKey });
      } : method,
    ])) as never;
  }
  return next;
}

export function liveComputerHost(host: HostTag | undefined, hosts: SidebarHostStatus[]): HostTag | undefined {
  if (!host) return undefined;
  const live = hosts.find(h => h.key === host.key || h.routes?.some(route => route.key === host.key)
    || (host.computerId && host.computerId === h.computerId));
  return live ? { ...host, status: live.status } : host;
}

type Snapshot = { key: string; settings: AppSettings; providers: ProviderInfo[] };
export function useComputerContext(api: CoderApi, host: HostTag | undefined,
  localSettings: AppSettings | null, localProviders: ProviderInfo[]) {
  const key = host?.key ?? "";
  const scopedApi = useMemo(() => computerApi(api, key || undefined), [api, key]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [nonce, setNonce] = useState(0);
  const generation = useRef(0);
  const saveGeneration = useRef(0);
  const appliedSave = useRef(0);
  const currentKey = useRef(key);
  currentKey.current = key;
  useEffect(() => {
    const gen = ++generation.current;
    if (!key) return;
    setFailure(null);
    void Promise.all([scopedApi.settings.get(), scopedApi.providers.list()]).then(([settings, providers]) => {
      if (gen === generation.current && currentKey.current === key) setSnapshot({ key, settings, providers });
    }).catch((err) => {
      if (gen === generation.current && currentKey.current === key) {
        setSnapshot(null);
        setFailure({ key, message: err instanceof Error ? err.message : String(err) });
      }
    });
    return () => { generation.current += 1; };
  }, [key, scopedApi, nonce, host?.status]);
  const remote = snapshot?.key === key ? snapshot : null;
  const refresh = useCallback(() => setNonce(n => n + 1), []);
  const save = useCallback(async (patch: Partial<AppSettings>) => {
    if (!key || !remote || currentKey.current !== key) throw new Error("Computer settings are unavailable. Reconnect and retry.");
    generation.current += 1;
    const save = ++saveGeneration.current;
    const next = await scopedApi.settings.set(patch);
    if (currentKey.current === key && save > appliedSave.current) {
      generation.current += 1;
      appliedSave.current = save;
      setSnapshot(prev => prev?.key === key ? { ...prev, settings: next } : prev);
    }
    return next;
  }, [key, remote, scopedApi]);
  return {
    key, label: host?.label ?? "This computer", api: scopedApi,
    settings: key ? remote?.settings ?? null : localSettings,
    providers: key ? remote?.providers ?? [] : localProviders,
    loading: Boolean(key && !remote && failure?.key !== key),
    error: failure?.key === key ? failure.message : null,
    refresh, save,
  };
}


/** Workflow IDs are scoped to the computer that stores their definitions. */
export function useComputerWorkflows(api: CoderApi, host: HostTag | undefined,
  localWorkflows: WorkflowTemplateInfo[], localError: string | null) {
  const key = host?.key ?? "";
  const scopedApi = useMemo(() => computerApi(api, key || undefined), [api, key]);
  const currentKey = useRef(key);
  currentKey.current = key;
  const generation = useRef(0);
  const [snapshot, setSnapshot] = useState<{ key: string; rows: WorkflowTemplateInfo[] } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const assertCurrent = useCallback(() => {
    if (currentKey.current !== key) throw new Error("The workflow computer changed. Reopen its workflows before continuing.");
  }, [key]);
  const refresh = useCallback(async (preserveRows = false) => {
    assertCurrent();
    const gen = ++generation.current;
    try {
      const rows = await scopedApi.workflows.list();
      if (currentKey.current === key && generation.current === gen) {
        setSnapshot({ key, rows });
        setFailure(null);
      }
    } catch (error) {
      if (currentKey.current === key && generation.current === gen) {
        if (!preserveRows) setSnapshot(null);
        setFailure({ key, message: error instanceof Error ? error.message : String(error) });
      }
      throw error;
    }
  }, [key, scopedApi, assertCurrent]);
  useEffect(() => {
    if (key) void refresh().catch(() => {});
    return () => { generation.current += 1; };
  }, [key, refresh, host?.status]);
  const rows = key ? snapshot?.key === key ? snapshot.rows : [] : localWorkflows;
  const error = key ? failure?.key === key ? failure.message : null : localError;
  const adopt = useCallback((change: (rows: WorkflowTemplateInfo[]) => WorkflowTemplateInfo[]) => {
    if (currentKey.current !== key) return;
    generation.current += 1;
    setSnapshot(prev => ({ key, rows: change(prev?.key === key ? prev.rows : []) }));
  }, [key]);
  const save = useCallback(async (input: Parameters<CoderApi["workflows"]["save"]>[0]) => {
    assertCurrent();
    const saved = await scopedApi.workflows.save(input);
    if (currentKey.current !== key) return saved;
    adopt(rows => rows.some(row => row.id === saved.id) ? rows.map(row => row.id === saved.id ? saved : row) : [...rows, saved]);
    try { await refresh(true); } catch (error) {
      if (currentKey.current === key) {
        // Keep the acknowledged ID so retrying a failed list never creates
        // a second template, matching the local editor's write contract.
        adopt(rows => rows.some(row => row.id === saved.id) ? rows : [...rows, saved]);
        setFailure({ key, message: `Saved, but the list failed to refresh: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    return saved;
  }, [key, scopedApi, assertCurrent, adopt, refresh]);
  const remove = useCallback(async (id: string) => {
    assertCurrent();
    await scopedApi.workflows.remove({ id });
    if (currentKey.current !== key) return;
    adopt(rows => rows.filter(row => row.id !== id));
    try { await refresh(true); } catch { /* refresh exposes its error without replaying removal */ }
  }, [key, scopedApi, assertCurrent, adopt, refresh]);
  const assertTemplate = useCallback((id?: string) => {
    assertCurrent();
    if (key && (!snapshot || snapshot.key !== key)) throw new Error("This computer's workflows are unavailable. Reconnect and refresh before starting one.");
    if (id && !rows.some(row => row.id === id)) throw new Error("This workflow is not available on the selected computer. Refresh its workflows and choose again.");
  }, [key, snapshot, rows, error, assertCurrent]);
  return { key, api: scopedApi, workflows: rows, error, refresh, save, remove, assertCurrent, assertTemplate };
}
