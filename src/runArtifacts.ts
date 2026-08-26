import { resolveWebToken } from "./coderApi";
import { isWebMode } from "./shared/wire";
import type { RunArtifactInfo } from "./shared/ipc";

export function runArtifactMediaUrl(
  threadId: string,
  artifactId: string,
): string {
  if (!isWebMode()) {
    return `solenta-media://artifact/${encodeURIComponent(artifactId)}`;
  }
  const token = resolveWebToken() ?? "";
  return `/api/run-artifacts/${encodeURIComponent(threadId)}/${encodeURIComponent(artifactId)}?token=${encodeURIComponent(token)}`;
}

export function artifactDurationLabel(durationMs?: number): string | null {
  if (!Number.isFinite(durationMs) || durationMs! < 0) return null;
  const seconds = Math.round(durationMs! / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const SOURCE_LABELS: Record<RunArtifactInfo["source"], string> = {
  simulator: "Simulator",
  verification: "Verification",
  browser: "Browser",
  manual: "Manual",
};

export function artifactSourceLabel(
  source: RunArtifactInfo["source"],
): string {
  return SOURCE_LABELS[source];
}

export function artifactRunLabel(artifact: RunArtifactInfo): string {
  return artifact.runId ? `Run ${artifact.runId}` : "Manual capture";
}

export function formatArtifactTimestamp(createdAt: string): string {
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function resolvePosterArtifact(
  artifact: RunArtifactInfo,
  allArtifacts: RunArtifactInfo[],
): RunArtifactInfo | null {
  if (!artifact.posterArtifactId) return null;
  return (
    allArtifacts.find((candidate) => candidate.id === artifact.posterArtifactId) ??
    null
  );
}
