/**
 * Settings › Advanced › Hooks (#1724): lists both files, gates project
 * hooks behind Approve, shows the last run, and Test runs one hook.
 *
 * Run: node --import=./test/support/render.mjs --experimental-strip-types --test test/hooksSection.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { mount, unmountAll } from "./support/dom.ts";
import { createFakeCoder, installFakeCoder } from "./support/fakeCoder.ts";
import { HooksSection } from "../src/components/settings/HooksSection";
import type { ProjectInfo, UserHooksList } from "../src/shared/ipc";

/** window only exists once something is mounted. */
async function install(fake: ReturnType<typeof createFakeCoder>) {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
}

afterEach(() => {
  unmountAll();
  delete (window as unknown as { coder?: unknown }).coder;
});

const project = { id: "p1", name: "Repo", path: "/repo" } as ProjectInfo;

function listing(trusted: boolean): UserHooksList {
  return {
    user: {
      path: "/u/hooks.json",
      exists: true,
      hash: "u",
      error: "hooks[0].event must be one of PreToolUse, PostToolUse, UserPromptSubmit, Stop",
      hooks: [],
    },
    project: {
      path: "/repo/.solenta/hooks.json",
      exists: true,
      hash: "abc",
      error: null,
      trusted,
      hooks: [
        {
          id: "project:0",
          event: "PreToolUse",
          matcher: "Bash",
          command: ["./scripts/check.sh", "--strict"],
          timeoutMs: 5000,
          scripts: [{ path: "scripts/check.sh", sha256: "0123456789abcdef" }],
          lastRun: trusted
            ? {
                id: "project:0",
                event: "PreToolUse",
                exitCode: 2,
                durationMs: 42,
                timedOut: false,
                error: null,
                output: "no deploys",
                at: 0,
              }
            : null,
        },
      ],
    },
    nativePreToolUse: ["claude", "codex"],
  };
}

describe("HooksSection", () => {
  it("shows the invalid user file, gates the project file, and approves its hash", async () => {
    const fake = createFakeCoder();
    let trusted = false;
    fake.api.hooks.list = async () => listing(trusted);
    const approvals: unknown[] = [];
    fake.api.hooks.approve = async (input) => {
      approvals.push(input);
      trusted = true;
      return { hash: input.hash };
    };
    await install(fake);
    const m = await mount(<HooksSection projects={[project]} currentProjectId="p1" />);
    await m.flush();

    assert.match(m.query('[data-hook-error="User hooks"]')?.textContent || "", /none of its hooks run/);
    const row = m.query('[data-hook-row="project:0"]');
    assert.match(row?.textContent || "", /PreToolUse \[Bash\] · \.\/scripts\/check\.sh --strict · 5s/);
    assert.match(row?.textContent || "", /best effort on\s+other providers/);
    assert.equal(m.query("[data-hook-trust]")?.getAttribute("data-hook-trust"), "untrusted");

    await m.click(m.query("[data-hook-approve]"));
    await m.flush();
    assert.deepEqual(approvals, [{ projectId: "p1", hash: "abc" }]);
    assert.equal(m.query("[data-hook-trust]")?.getAttribute("data-hook-trust"), "trusted");
    assert.match(
      m.query('[data-hook-last-run="project:0"]')?.textContent || "",
      /exit 2 \(blocked\) · 42 ms[\s\S]*no deploys/,
    );
  });

  it("lists each hook's repo scripts with a short hash and says what approval covers (#1737)", async () => {
    const fake = createFakeCoder();
    fake.api.hooks.list = async () => listing(false);
    await install(fake);
    const m = await mount(<HooksSection projects={[project]} currentProjectId="p1" />);
    await m.flush();
    assert.match(
      m.query('[data-hook-scripts="project:0"]')?.textContent || "",
      /Runs from the project checkout: scripts\/check\.sh \(01234567\)/,
    );
    const intro = m.query("[data-hooks-settings] > p")?.textContent || "";
    assert.match(intro, /Approval also covers repo scripts a hook runs; they run from the\s+project checkout, not the thread.s worktree/);
    assert.match(intro, /package\.json scripts run through npm or npx/);
    assert.doesNotMatch(intro, /Approval covers hooks\.json only/);
  });

  it("Test runs that hook and refreshes", async () => {
    const fake = createFakeCoder();
    fake.api.hooks.list = async () => listing(true);
    await install(fake);
    const m = await mount(<HooksSection projects={[project]} currentProjectId="p1" />);
    await m.flush();
    await m.click(m.query('[data-hook-test="project:0"]'));
    await m.flush();
    const calls = fake.calls.filter((c) => c.channel === "hooks.test");
    assert.deepEqual(calls.map((c) => c.args[0]), [{ projectId: "p1", id: "project:0" }]);
  });
});
