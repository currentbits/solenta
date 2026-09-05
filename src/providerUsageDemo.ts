/**
 * Vite-only demo rows for /usage review. Not live account data.
 *
 * Lead integration: wire `demoProviderLimits` into
 * `createDevCoder().usage.providerLimits` in src/devCoder.ts.
 * This UI branch does not edit that file.
 */
import type { ProviderUsage } from "./shared/ipc.ts";

export function demoProviderLimits(now = Date.now()): ProviderUsage[] {
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  return [
    {
      provider: "claude",
      status: "ok",
      windows: [
        {
          label: "5 hours",
          usedPercent: 44,
          resetsAt: now + 2 * hour,
          windowSeconds: 5 * 60 * 60,
        },
        {
          label: "Weekly",
          usedPercent: 21,
          resetsAt: now + 4 * day,
          windowSeconds: 7 * 24 * 60 * 60,
        },
      ],
      fetchedAt: now,
    },
    {
      provider: "grok",
      status: "ok",
      windows: [
        {
          label: "Weekly",
          usedPercent: 31,
          resetsAt: now + 3 * day,
          windowSeconds: 7 * 24 * 60 * 60,
        },
      ],
      fetchedAt: now,
    },
    {
      provider: "cursor",
      status: "unavailable",
      windows: [],
      fetchedAt: null,
      message: "Demo fixture. This CLI does not report account limits",
    },
  ];
}
