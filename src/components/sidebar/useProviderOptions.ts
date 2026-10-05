import { useMemo } from "react";
import type { ProviderInfo, ThreadInfo } from "../../shared/ipc";

/** Provider filter choices: the registry plus any id a thread still uses. */
export function useProviderOptions(
  providers: ProviderInfo[],
  threads: ThreadInfo[],
) {
  const providerOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: { id: string; name: string }[] = [];
    const rank = ["claude", "codex", "grok", "kimi", "opencode", "cursor", "muse"];
    for (const p of providers) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push({ id: p.id, name: p.name });
    }
    for (const t of threads) {
      const id = t.provider;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name: id });
    }
    out.sort((a, b) => {
      const ia = rank.indexOf(a.id);
      const ib = rank.indexOf(b.id);
      return (
        (ia === -1 ? rank.length : ia) - (ib === -1 ? rank.length : ib) ||
        a.id.localeCompare(b.id)
      );
    });
    return out;
  }, [providers, threads]);
  const providerNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of providerOptions) m.set(p.id, p.name);
    return m;
  }, [providerOptions]);
  return { providerOptions, providerNames };
}
