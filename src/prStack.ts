/** One PR in a base→head chain (#1527). */
export interface StackPr {
  number: number;
  headRefName: string;
  baseRefName: string;
  title?: string;
  state?: "OPEN" | "CLOSED" | "MERGED";
  url?: string;
}

function refKey(name: string): string {
  return String(name || "").trim().replace(/^refs\/heads\//, "");
}

/**
 * Chains of PRs whose bases point at another PR's head. Bottom first
 * (targets the default base, or nothing else in the set). Length ≥ 2.
 */
export function detectPrStacks(prs: StackPr[]): StackPr[][] {
  const rows = prs.filter((p) => p && p.number > 0 && refKey(p.headRefName));
  const byHead = new Map<string, StackPr>();
  for (const pr of rows) byHead.set(refKey(pr.headRefName), pr);

  const seen = new Set<number>();
  const stacks: StackPr[][] = [];

  for (const pr of rows) {
    if (seen.has(pr.number)) continue;
    let bottom = pr;
    const down = new Set<number>();
    while (refKey(bottom.baseRefName)) {
      if (down.has(bottom.number)) break;
      down.add(bottom.number);
      const parent = byHead.get(refKey(bottom.baseRefName));
      if (!parent || parent.number === bottom.number) break;
      bottom = parent;
    }
    const chain: StackPr[] = [];
    let cur: StackPr | undefined = bottom;
    const up = new Set<number>();
    while (cur && !up.has(cur.number)) {
      up.add(cur.number);
      chain.push(cur);
      seen.add(cur.number);
      const head = refKey(cur.headRefName);
      cur = rows.find(
        (p) => p.number !== cur!.number && refKey(p.baseRefName) === head,
      );
    }
    if (chain.length >= 2) stacks.push(chain);
  }
  return stacks;
}

export function stackContaining(
  stacks: StackPr[][],
  prNumber: number,
): StackPr[] | null {
  return stacks.find((s) => s.some((p) => p.number === prNumber)) || null;
}
