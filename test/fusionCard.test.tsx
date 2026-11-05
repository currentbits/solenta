/**
 * Instruction-file Fusion card (#1856) in Settings → Memory → Project tools.
 *
 * Run: node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test --test-timeout=60000 test/fusionCard.test.tsx
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mount, unmountAll } from "./support/dom.ts";
import { MemoryProjectTools } from "../src/components/MemoryTab";
import type { FusionInput, FusionPlan } from "../src/shared/ipc";

afterEach(unmountAll);

function planFor(input: FusionInput, synced: boolean): FusionPlan {
  const pm = input.picks?.packageManager ?? "npm";
  const diff = (path: string) =>
    synced
      ? ""
      : `--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,4 @@\n # Top\n+<!-- solenta:fusion:start sha:x -->\n+- Package manager: ${pm}\n+<!-- solenta:fusion:end -->`;
  return {
    projectId: input.projectId,
    files: [
      { path: "AGENTS.md", kind: "agents", kindLabel: "Codex, Grok, OpenCode and others", hasBlock: synced },
      { path: "CLAUDE.md", kind: "claude", kindLabel: "Claude Code", hasBlock: synced },
    ],
    agreed: [{ key: "build", label: "Build", value: "npm run build", sources: [{ path: "AGENTS.md", line: 9 }] }],
    conflicts: [
      {
        id: "packageManager",
        key: "packageManager",
        label: "Package manager",
        pick: pm,
        options: [
          { value: "npm", sources: [{ path: "AGENTS.md", line: 5 }] },
          { value: "pnpm", sources: [{ path: "CLAUDE.md", line: 5 }] },
        ],
      },
    ],
    diffs: [
      { path: "AGENTS.md", diff: diff("AGENTS.md"), changed: !synced },
      { path: "CLAUDE.md", diff: diff("CLAUDE.md"), changed: !synced },
    ],
    status: { synced, syncedAt: synced ? Date.now() : null },
  };
}

describe("Fusion card", () => {
  it("picks a side, shows the diff, syncs only ticked files, then reports synced", async () => {
    const planCalls: FusionInput[] = [];
    const syncCalls: Array<FusionInput & { paths: string[] }> = [];
    let synced = false;
    const m = await mount(
      <MemoryProjectTools
        projectId="p1"
        projectSlug="coder"
        fusionPlan={async (input) => {
          planCalls.push(input);
          return planFor(input, synced);
        }}
        fusionSync={async (input) => {
          syncCalls.push(input);
          synced = true;
          return { projectId: input.projectId, written: input.paths, status: { synced: true, syncedAt: Date.now() } };
        }}
      />,
    );

    // Status shows on the collapsed card.
    assert.equal(m.query("[data-fusion-status]")?.textContent, "Not synced");
    await m.click(m.query("[data-fusion] summary"));

    assert.ok(m.text().includes("AGENTS.md"));
    assert.ok(m.text().includes("Claude Code"));
    assert.ok(m.text().includes("AGENTS.md:5"));
    assert.ok(m.text().includes("CLAUDE.md:5"));
    assert.ok(m.query("[data-fusion-agreed]")?.textContent?.includes("npm run build"));

    const pnpm = m.query('[data-fusion-conflict="packageManager"] input[value="pnpm"]');
    await m.click(pnpm);
    assert.deepEqual(planCalls.at(-1)?.picks, { packageManager: "pnpm" });
    assert.ok(m.query('[data-fusion-diff="AGENTS.md"] pre')?.textContent?.includes("+- Package manager: pnpm"));

    // Untick CLAUDE.md: only AGENTS.md is written.
    await m.click(m.query('[data-fusion-diff="CLAUDE.md"] input[type="checkbox"]'));
    await m.click(m.byText("Sync"));
    assert.equal(syncCalls.length, 1);
    assert.deepEqual(syncCalls[0].paths, ["AGENTS.md"]);
    assert.deepEqual(syncCalls[0].picks, { packageManager: "pnpm" });

    assert.ok(m.query("[data-fusion-wrote]")?.textContent?.includes("Wrote AGENTS.md"));
    assert.equal(m.query("[data-fusion-status]")?.textContent, "Synced just now");
    assert.ok(m.text().includes("Nothing to change."));
  });

  it("offers the CLAUDE.md import and passes it to the plan", async () => {
    const planCalls: FusionInput[] = [];
    const m = await mount(
      <MemoryProjectTools
        projectId="p1"
        projectSlug="coder"
        fusionPlan={async (input) => {
          planCalls.push(input);
          return planFor(input, false);
        }}
      />,
    );
    await m.click(m.query("[data-fusion] summary"));
    assert.equal(m.byText("Sync"), null, "no Sync without a writer");
    const box = [...m.container.querySelectorAll("label")].find((l) =>
      l.textContent?.includes("instead of a copy"),
    );
    await m.click(box?.querySelector("input") ?? null);
    assert.equal(planCalls.at(-1)?.importInClaude, true);
  });
});
