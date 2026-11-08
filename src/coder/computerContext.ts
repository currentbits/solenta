import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppSettings, CoderApi, HostTag, ProviderInfo } from "../shared/ipc";

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
        const first = args[0];
        return method(first, { ...(args[1] as object ?? {}), onHost: hostKey });
      } : method,
    ])) as never;
  }
  return next;
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
    if (!key || !remote) throw new Error("Computer settings are unavailable. Reconnect and retry.");
    const next = await scopedApi.settings.set(patch);
    if (currentKey.current === key) setSnapshot(prev => prev?.key === key ? { ...prev, settings: next } : prev);
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
