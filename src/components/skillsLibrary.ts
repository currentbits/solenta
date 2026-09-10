import type { SkillInfo, SkillProvenance, SkillTarget } from "../shared/ipc";

export type SkillsView = "library" | "catalog" | "mcp" | "add";

export const SOURCE_FILTERS: Array<{ id: SkillProvenance; label: string }> = [
  { id: "added", label: "User" },
  { id: "project", label: "Project" },
  { id: "curated", label: "Catalog" },
];

export const PROVIDER_FILTERS: Array<{ id: SkillTarget; label: string }> = [
  { id: "claude", label: "Claude" },
  { id: "agents", label: "Agents" },
  { id: "codex", label: "Codex" },
  { id: "grok", label: "Grok" },
  { id: "opencode", label: "OpenCode" },
  { id: "kimi", label: "Kimi" },
  { id: "cursor", label: "Cursor" },
  { id: "muse", label: "Muse" },
];

export function skillKey(skill: SkillInfo): string {
  return `${skill.source}:${skill.name}`;
}

export function skillMatchesQuery(skill: SkillInfo, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    skill.name.toLowerCase().includes(q) ||
    skill.description.toLowerCase().includes(q)
  );
}

export function skillMatchesSources(
  skill: SkillInfo,
  sources: ReadonlySet<SkillProvenance>,
): boolean {
  if (sources.size === 0) return true;
  return sources.has(skill.provenance);
}

export function skillMatchesProviders(
  skill: SkillInfo,
  providers: ReadonlySet<SkillTarget>,
): boolean {
  if (providers.size === 0) return true;
  return skill.installedIn.some((provider) => providers.has(provider));
}

export function filterInstalledSkills(
  skills: readonly SkillInfo[],
  opts: {
    query: string;
    sources: ReadonlySet<SkillProvenance>;
    providers: ReadonlySet<SkillTarget>;
  },
): SkillInfo[] {
  return skills.filter(
    (skill) =>
      skillMatchesQuery(skill, opts.query) &&
      skillMatchesSources(skill, opts.sources) &&
      skillMatchesProviders(skill, opts.providers),
  );
}

export function sourceFilterCount(
  skills: readonly SkillInfo[],
  source: SkillProvenance,
  opts: { query: string; providers: ReadonlySet<SkillTarget> },
): number {
  return skills.filter(
    (skill) =>
      skill.provenance === source &&
      skillMatchesQuery(skill, opts.query) &&
      skillMatchesProviders(skill, opts.providers),
  ).length;
}

export function providerFilterCount(
  skills: readonly SkillInfo[],
  provider: SkillTarget,
  opts: { query: string; sources: ReadonlySet<SkillProvenance> },
): number {
  return skills.filter(
    (skill) =>
      skill.installedIn.includes(provider) &&
      skillMatchesQuery(skill, opts.query) &&
      skillMatchesSources(skill, opts.sources),
  ).length;
}

export function toggleSetValue<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}
