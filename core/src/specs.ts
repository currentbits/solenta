import type { WorkflowSpec } from "./types.js";

/** Default model for the canonical standard pipeline. */
const DEFAULT_MODEL = "sonnet-5";

/**
 * Adjective list for deterministic workflow name generation.
 * At least 24 entries; all uppercase single words.
 */
const ADJECTIVES = [
  "INTEGER",
  "BINARY",
  "COPPER",
  "SILVER",
  "GOLDEN",
  "CRIMSON",
  "AZURE",
  "IVORY",
  "SILENT",
  "RAPID",
  "QUIET",
  "BRAVE",
  "NOBLE",
  "ANCIENT",
  "MODERN",
  "HIDDEN",
  "BRIGHT",
  "HOLLOW",
  "SOLID",
  "LIQUID",
  "FROZEN",
  "COSMIC",
  "ORBITAL",
  "LINEAR",
  "NESTED",
  "ATOMIC",
  "QUANTUM",
  "PRIMAL",
  "STABLE",
  "FLUID",
  "VIVID",
  "CRISP",
] as const;

/**
 * Noun list for deterministic workflow name generation.
 * At least 24 entries; all uppercase single words.
 */
const NOUNS = [
  "SAFARI",
  "RIVER",
  "FOREST",
  "CANYON",
  "SUMMIT",
  "VALLEY",
  "HARBOR",
  "MEADOW",
  "PILLAR",
  "BRIDGE",
  "SIGNAL",
  "VECTOR",
  "MATRIX",
  "CIPHER",
  "ENGINE",
  "ORBIT",
  "PRISM",
  "RELAY",
  "SOCKET",
  "THREAD",
  "BUFFER",
  "STREAM",
  "CIRCUIT",
  "PULSE",
  "ANCHOR",
  "BEACON",
  "FORGE",
  "NEXUS",
  "RIDGE",
  "SPHERE",
  "TORCH",
  "WHEEL",
] as const;

/** Monotonic counter so same-named specs still get unique workflow ids. */
let standardSpecSeq = 0;

export interface BuildStandardSpecOptions {
  /** Explicit workflow id. When omitted, a unique id is generated. */
  id?: string;
}

/**
 * Canonical 5-phase pipeline used by the app:
 * seed(1) → analyze(4) → verify(4, pipelined) → judge(3) → synthesize(1).
 * Default model is sonnet-5 on every phase.
 *
 * Workflow ids are unique per call even when `name` is repeated, so
 * persistence keyed by id cannot collide. Pass `options.id` to pin one.
 */
export function buildStandardSpec(
  name: string,
  options?: BuildStandardSpecOptions,
): WorkflowSpec {
  const id =
    options?.id ?? `wf-${slugify(name)}-${standardSpecSeq++}`;
  return {
    id,
    name,
    phases: [
      { name: "seed", agentCount: 1, model: DEFAULT_MODEL },
      { name: "analyze", agentCount: 4, model: DEFAULT_MODEL },
      {
        name: "verify",
        agentCount: 4,
        model: DEFAULT_MODEL,
        pipelined: true,
      },
      { name: "judge", agentCount: 3, model: DEFAULT_MODEL },
      { name: "synthesize", agentCount: 1, model: DEFAULT_MODEL },
    ],
  };
}

/**
 * Deterministic ADJECTIVE-NOUN name from a numeric seed
 * (e.g. nameForSeed(0) might yield "INTEGER-SAFARI").
 * Same seed always returns the same name.
 */
export function nameForSeed(seed: number): string {
  const s = Math.trunc(seed);
  const adjIndex = mod(s, ADJECTIVES.length);
  // Mix seed so small consecutive seeds also vary the noun.
  const nounIndex = mod(Math.imul(s, 2654435761) ^ (s >>> 16), NOUNS.length);
  return `${ADJECTIVES[adjIndex]}-${NOUNS[nounIndex]}`;
}

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "workflow";
}
