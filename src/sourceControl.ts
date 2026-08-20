/**
 * Pure forge-readiness helpers (issue #608).
 *
 * The Electron probe lives in electron/sourceControl.js; this file is the
 * T3-shaped layer the renderer and add-project (#459) share: ready vs a
 * copy-pasteable hint, ready sources floated first.
 */
import type {
  SourceControlDiscovery,
  SourceControlProvider,
  SourceControlProviderKind,
} from "./shared/ipc";

export type AddProjectRemoteProviderKind = Extract<
  SourceControlProviderKind,
  "github" | "gitlab" | "bitbucket" | "azure-devops"
>;

export type AddProjectRemoteSource = AddProjectRemoteProviderKind | "url";

export type AddProjectRemoteSourceReadiness = Record<
  AddProjectRemoteSource,
  { ready: boolean; hint: string | null }
>;

const PROVIDER_SOURCES: readonly AddProjectRemoteProviderKind[] = [
  "github",
  "gitlab",
  "bitbucket",
  "azure-devops",
];

const UNAVAILABLE_HINT =
  "Provider status unavailable. Open Settings → Source Control and rescan.";

export function addProjectRemoteSourceLabel(
  source: AddProjectRemoteSource,
): string {
  switch (source) {
    case "github":
      return "GitHub";
    case "gitlab":
      return "GitLab";
    case "bitbucket":
      return "Bitbucket";
    case "azure-devops":
      return "Azure DevOps";
    case "url":
      return "Git URL";
  }
}

export function providerReady(
  provider: SourceControlProvider | undefined,
): boolean {
  return (
    provider != null &&
    provider.status === "available" &&
    provider.auth.status === "authenticated"
  );
}

export function providerHint(
  provider: SourceControlProvider | undefined,
): string {
  if (!provider) return UNAVAILABLE_HINT;
  if (provider.status !== "available") return provider.installHint;
  if (provider.auth.status === "unauthenticated") {
    return (
      provider.auth.detail ??
      `${provider.label} is not authenticated. Open Settings → Source Control.`
    );
  }
  if (provider.auth.status === "unknown") {
    return provider.auth.detail ?? provider.installHint;
  }
  return provider.installHint;
}

export function forgeReadiness(
  discovery: SourceControlDiscovery | null | undefined,
  kind: SourceControlProviderKind,
): { ready: boolean; hint: string | null } {
  if (!discovery) return { ready: false, hint: UNAVAILABLE_HINT };
  const provider = discovery.sourceControlProviders.find((p) => p.kind === kind);
  if (providerReady(provider)) return { ready: true, hint: null };
  return { ready: false, hint: providerHint(provider) };
}

export function buildAddProjectRemoteSourceReadiness(
  discovery: SourceControlDiscovery | null | undefined,
): AddProjectRemoteSourceReadiness {
  const unavailable = { ready: false, hint: UNAVAILABLE_HINT } as const;
  const readiness: AddProjectRemoteSourceReadiness = {
    url: { ready: true, hint: null },
    github: unavailable,
    gitlab: unavailable,
    bitbucket: unavailable,
    "azure-devops": unavailable,
  };
  if (!discovery) return readiness;
  for (const source of PROVIDER_SOURCES) {
    const next = forgeReadiness(discovery, source);
    readiness[source] = next.ready
      ? { ready: true, hint: null }
      : { ready: false, hint: next.hint };
  }
  return readiness;
}

export function sortAddProjectProviderSources(
  readinessBySource: AddProjectRemoteSourceReadiness,
): AddProjectRemoteProviderKind[] {
  return PROVIDER_SOURCES.slice().sort((a, b) => {
    const readyDelta =
      Number(readinessBySource[b].ready) - Number(readinessBySource[a].ready);
    if (readyDelta !== 0) return readyDelta;
    return addProjectRemoteSourceLabel(a).localeCompare(
      addProjectRemoteSourceLabel(b),
    );
  });
}
