/**
 * Pair two runs by step number and report the first divergence (issue #393).
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatMessage, ThreadInfo } from "../src/shared/ipc.ts";
import {
  comparePeerLabel,
  compareSteps,
  extractSteps,
  formatDivergenceHeadline,
  sameTaskPeers,
  sameThreadRuns,
  truncateStepValue,
} from "../src/divergence.ts";

function tool(
  over: Partial<ChatMessage> & {
    name: string;
    input?: string;
    output?: string | null;
    done?: boolean;
    isError?: boolean;
  },
): ChatMessage {
  return {
    id: over.id ?? `m-${over.name}-${over.createdAt ?? 1}`,
    role: "tool",
    text: `${over.name}: ${over.input ?? ""}`,
    createdAt: over.createdAt ?? 1,
    runId: over.runId ?? "run-a",
    tool: {
      id: over.id ?? `tool-${over.name}`,
      name: over.name,
      input: over.input ?? "",
      output: over.output === undefined ? "ok" : over.output,
      isError: over.isError ?? false,
      done: over.done ?? true,
    },
  };
}

function asst(text: string, createdAt = 1): ChatMessage {
  return {
    id: `a-${createdAt}`,
    role: "assistant",
    text,
    createdAt,
    runId: "run-a",
  };
}

function user(text: string, createdAt = 1): ChatMessage {
  return {
    id: `u-${createdAt}`,
    role: "user",
    text,
    createdAt,
  };
}

function row(
  over: Partial<ThreadInfo> & Pick<ThreadInfo, "id">,
): Pick<ThreadInfo, "id" | "projectId" | "handoffFrom" | "provider" | "title"> {
  return {
    id: over.id,
    projectId: over.projectId ?? "p1",
    handoffFrom: over.handoffFrom ?? null,
    provider: over.provider ?? "claude",
    title: over.title ?? over.id,
  };
}

describe("extractSteps", () => {
  it("numbers tool calls in transcript order and skips prose", () => {
    const steps = extractSteps([
      user("fix it"),
      asst("looking"),
      tool({ name: "Read", input: "a.ts", createdAt: 3 }),
      tool({ name: "Bash", input: "npm test", createdAt: 4 }),
      asst("done", 5),
    ]);
    assert.deepEqual(
      steps.map((s) => ({ n: s.number, name: s.name, input: s.input })),
      [
        { n: 1, name: "Read", input: "a.ts" },
        { n: 2, name: "Bash", input: "npm test" },
      ],
    );
  });

  it("filters to one runId when asked", () => {
    const steps = extractSteps(
      [
        tool({ name: "Read", runId: "r1", createdAt: 1 }),
        tool({ name: "Bash", runId: "r2", createdAt: 2 }),
        tool({ name: "Edit", runId: "r1", createdAt: 3 }),
      ],
      "r1",
    );
    assert.deepEqual(
      steps.map((s) => s.name),
      ["Read", "Edit"],
    );
    assert.equal(steps[0]!.number, 1);
    assert.equal(steps[1]!.number, 2);
  });

  it("maps pending / error / ok onto decision", () => {
    const steps = extractSteps([
      tool({ name: "Read", done: false, output: null }),
      tool({ name: "Bash", isError: true, output: "boom" }),
      tool({ name: "Edit", output: "ok" }),
    ]);
    assert.deepEqual(
      steps.map((s) => s.decision),
      ["pending", "error", "ok"],
    );
  });

  it("treats a missing tool payload as not a step", () => {
    const steps = extractSteps([
      {
        id: "bare",
        role: "tool",
        text: "Bash: npm test",
        createdAt: 1,
        runId: "r",
      },
    ]);
    assert.deepEqual(steps, []);
  });
});

describe("compareSteps", () => {
  const left = extractSteps([
    tool({ name: "Read", input: "a.ts", id: "l1" }),
    tool({ name: "Bash", input: "npm test", id: "l2" }),
    tool({ name: "Edit", input: "a.ts", output: "ok", id: "l3" }),
  ]);
  const same = extractSteps([
    tool({ name: "Read", input: "a.ts", id: "r1" }),
    tool({ name: "Bash", input: "npm test", id: "r2" }),
    tool({ name: "Edit", input: "a.ts", output: "ok", id: "r3" }),
  ]);

  it("returns no first hit when every paired field matches", () => {
    const report = compareSteps(left, same);
    assert.equal(report.first, null);
    assert.equal(report.matched, 3);
    assert.equal(report.pending, false);
  });

  it("reports the first step whose name differs, not a later one", () => {
    const right = extractSteps([
      tool({ name: "Read", input: "a.ts" }),
      tool({ name: "Read", input: "b.ts" }),
      tool({ name: "Edit", input: "a.ts" }),
    ]);
    const report = compareSteps(left, right);
    assert.equal(report.matched, 1);
    assert.equal(report.first?.step, 2);
    assert.deepEqual(report.first?.fields, ["name", "input"]);
    assert.equal(report.first?.left?.name, "Bash");
    assert.equal(report.first?.right?.name, "Read");
  });

  it("treats output-only drift as a decision-preserving divergence", () => {
    const right = extractSteps([
      tool({ name: "Read", input: "a.ts" }),
      tool({ name: "Bash", input: "npm test", output: "fail" }),
    ]);
    const report = compareSteps(left.slice(0, 2), right);
    assert.equal(report.first?.step, 2);
    assert.deepEqual(report.first?.fields, ["output"]);
  });

  it("treats a failed vs successful same tool as a decision split", () => {
    const right = extractSteps([
      tool({ name: "Read", input: "a.ts", isError: true, output: "ok" }),
    ]);
    const report = compareSteps(left.slice(0, 1), right);
    assert.deepEqual(report.first?.fields, ["decision"]);
  });

  it("does not call a length gap a divergence while the shorter run is live", () => {
    const report = compareSteps(left.slice(0, 1), left, {
      leftDone: false,
      rightDone: true,
    });
    assert.equal(report.first, null);
    assert.equal(report.pending, true);
    assert.equal(report.matched, 1);
  });

  it("calls a length gap a divergence once the shorter run has finished", () => {
    const report = compareSteps(left.slice(0, 1), left, {
      leftDone: true,
      rightDone: true,
    });
    assert.equal(report.first?.step, 2);
    assert.equal(report.first?.left, null);
    assert.equal(report.first?.right?.name, "Bash");
    assert.equal(report.pending, false);
  });

  it("still reports a field mismatch while either run is live", () => {
    const right = extractSteps([tool({ name: "Grep", input: "a.ts" })]);
    const report = compareSteps(left.slice(0, 1), right, {
      leftDone: false,
      rightDone: false,
    });
    assert.equal(report.first?.step, 1);
    assert.ok(report.first?.fields.includes("name"));
    assert.equal(report.pending, false);
  });
});

describe("formatDivergenceHeadline", () => {
  it("names both tools when the first split is the tool name", () => {
    const left = extractSteps([tool({ name: "Bash", input: "npm test" })]);
    const right = extractSteps([tool({ name: "Read", input: "pkg.json" })]);
    const report = compareSteps(left, right);
    assert.equal(
      formatDivergenceHeadline(report, "Claude Code", "Codex"),
      "Diverged at step 1 · name · Bash vs Read",
    );
  });

  it("names the missing side when one run ran longer", () => {
    const left = extractSteps([
      tool({ name: "Read", input: "a.ts" }),
      tool({ name: "Bash", input: "npm test" }),
    ]);
    const right = extractSteps([tool({ name: "Read", input: "a.ts" })]);
    const report = compareSteps(left, right);
    assert.equal(
      formatDivergenceHeadline(report, "Claude Code", "Codex"),
      "Diverged at step 2: Claude Code Bash, Codex has no step",
    );
  });

  it("says matching when nothing split", () => {
    const steps = extractSteps([tool({ name: "Read", input: "a.ts" })]);
    assert.equal(
      formatDivergenceHeadline(compareSteps(steps, steps), "A", "B"),
      "No divergence · 1 matching step",
    );
  });

  it("says not yet when the shorter run is still going", () => {
    const left = extractSteps([tool({ name: "Read", input: "a.ts" })]);
    const right = extractSteps([
      tool({ name: "Read", input: "a.ts" }),
      tool({ name: "Bash", input: "npm test" }),
    ]);
    const report = compareSteps(left, right, { leftDone: false });
    assert.equal(
      formatDivergenceHeadline(report, "A", "B"),
      "No divergence yet · 1 matching step",
    );
  });

  it("says there is nothing to compare when both sides are empty", () => {
    assert.equal(
      formatDivergenceHeadline(compareSteps([], []), "A", "B"),
      "No steps to compare",
    );
  });
});

describe("sameTaskPeers", () => {
  const source = row({ id: "src", title: "task" });
  const claude = row({
    id: "claude",
    handoffFrom: "src",
    provider: "claude",
    title: "Fork: task",
  });
  const codex = row({
    id: "codex",
    handoffFrom: "src",
    provider: "codex",
    title: "Fork: task",
  });
  const other = row({ id: "other", projectId: "p2", handoffFrom: "src" });
  const child = row({ id: "kid", handoffFrom: "claude" });

  it("lists the source and sibling forks, not other projects", () => {
    const peers = sameTaskPeers(claude, [source, claude, codex, other, child]);
    assert.deepEqual(
      peers.map((p) => p.id),
      ["codex", "src"],
    );
  });

  it("lists children when the open thread is the source", () => {
    const peers = sameTaskPeers(source, [source, claude, codex]);
    assert.deepEqual(
      peers.map((p) => p.id),
      ["claude", "codex"],
    );
  });

  it("returns nothing for an isolated thread", () => {
    assert.deepEqual(sameTaskPeers(source, [source, other]), []);
  });
});

describe("comparePeerLabel", () => {
  it("uses the provider display name when providers are unique", () => {
    assert.equal(
      comparePeerLabel(
        { id: "a", provider: "claude", title: "Fork: x" },
        [{ id: "b", provider: "codex" }],
        [
          { id: "claude", name: "Claude Code" },
          { id: "codex", name: "Codex" },
        ],
      ),
      "Claude Code",
    );
  });

  it("appends the title when two peers share a provider", () => {
    assert.equal(
      comparePeerLabel(
        { id: "a", provider: "claude", title: "Fork: opus" },
        [
          { id: "a", provider: "claude" },
          { id: "b", provider: "claude" },
        ],
        [{ id: "claude", name: "Claude Code" }],
      ),
      "Claude Code · Fork: opus",
    );
  });
});

describe("sameThreadRuns", () => {
  it("labels completed tool-bearing runs in first-seen order and drops a live tail", () => {
    const messages = [
      tool({ name: "Read", runId: "r1", createdAt: 1 }),
      tool({ name: "Bash", runId: "r2", createdAt: 2 }),
      asst("still going", 3),
    ];
    messages[2] = { ...messages[2]!, runId: "r3" };
    const runs = sameThreadRuns(messages, "working");
    assert.deepEqual(runs, [
      { runId: "r1", label: "Run 1" },
      { runId: "r2", label: "Run 2" },
    ]);
  });

  it("skips a completed run that never called a tool", () => {
    const messages = [
      user("hi"),
      asst("ok"),
      tool({ name: "Read", runId: "r2", createdAt: 3 }),
    ];
    messages[1] = { ...messages[1]!, runId: "r1" };
    assert.deepEqual(sameThreadRuns(messages, "done"), [
      { runId: "r2", label: "Run 1" },
    ]);
  });
});

describe("truncateStepValue", () => {
  it("leaves short values alone and ellipsizes long ones", () => {
    assert.equal(truncateStepValue("npm test"), "npm test");
    assert.equal(truncateStepValue("abcdefghij", 8), "abcdefg…");
  });
});
