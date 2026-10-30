/**
 * Named background jobs derived from the transcript + subagents + workflow
 * (#1775): shells, subagents, workflow fan-out.
 *
 * Run: node --experimental-strip-types --test test/backgroundJobs.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveBackgroundJobs } from "../src/backgroundJobs.ts";
import type { ChatMessage, SubagentInfo, WorkflowView } from "../src/shared/ipc.ts";

let nextId = 1;
function toolMsg(
  tool: Partial<ChatMessage["tool"]> & { name: string },
  createdAt = nextId++,
): ChatMessage {
  return {
    id: `m${createdAt}`,
    role: "tool",
    text: "",
    createdAt,
    tool: {
      id: `tool${createdAt}`,
      input: "{}",
      output: null,
      isError: false,
      done: true,
      ...tool,
    },
  };
}

describe("deriveBackgroundJobs", () => {
  it("a backgrounded shell with no finish signal is still running", () => {
    const jobs = deriveBackgroundJobs(
      [
        toolMsg({
          name: "Bash",
          input: JSON.stringify({ command: "npm run watch", run_in_background: true }),
          output: "Running in the background with ID: bash_1",
        }, 10),
      ],
      null,
      null,
      null,
    );
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.kind, "shell");
    assert.equal(jobs[0]!.label, "npm run watch");
    assert.equal(jobs[0]!.startedAt, 10);
  });

  it("a KillShell referencing the same shell id ends the job", () => {
    const jobs = deriveBackgroundJobs(
      [
        toolMsg({
          name: "Bash",
          input: JSON.stringify({ command: "npm run watch", run_in_background: true }),
          output: "Running in the background with ID: bash_1",
        }, 10),
        toolMsg({ name: "KillShell", input: JSON.stringify({ bash_id: "bash_1" }) }, 20),
      ],
      null,
      null,
      null,
    );
    assert.deepEqual(jobs, []);
  });

  it("a BashOutput reporting the shell completed ends the job", () => {
    const jobs = deriveBackgroundJobs(
      [
        toolMsg({
          name: "Bash",
          input: JSON.stringify({ command: "npm test", run_in_background: true }),
          output: "Running in the background with ID: bash_2",
        }, 10),
        toolMsg(
          {
            name: "BashOutput",
            input: JSON.stringify({ bash_id: "bash_2" }),
            output: "status: completed\nexit code 0",
            done: true,
          },
          20,
        ),
      ],
      null,
      null,
      null,
    );
    assert.deepEqual(jobs, []);
  });

  it("a BashOutput still pending (not done) surfaces as its own monitor row", () => {
    const jobs = deriveBackgroundJobs(
      [
        toolMsg({
          name: "Bash",
          input: JSON.stringify({ command: "npm run watch", run_in_background: true }),
          output: "Running in the background with ID: bash_3",
        }, 10),
        toolMsg(
          { name: "BashOutput", input: JSON.stringify({ bash_id: "bash_3" }), done: false },
          20,
        ),
      ],
      null,
      null,
      null,
    );
    const kinds = jobs.map((j) => j.kind).sort();
    assert.deepEqual(kinds, ["monitor", "shell"]);
    const monitor = jobs.find((j) => j.kind === "monitor")!;
    assert.match(monitor.label, /bash_3/);
    assert.equal(monitor.startedAt, 20);
  });

  it("a Bash call without run_in_background is not a background job", () => {
    const jobs = deriveBackgroundJobs(
      [toolMsg({ name: "Bash", input: JSON.stringify({ command: "ls" }) }, 10)],
      null,
      null,
      null,
    );
    assert.deepEqual(jobs, []);
  });

  it("only running subagents are listed; done/failed are not", () => {
    const subagents: SubagentInfo[] = [
      { id: "a1", description: "Explore the repo", agentType: "Explore", status: "running", startedAt: 5 },
      { id: "a2", description: "Write the report", agentType: null, status: "done", startedAt: 6 },
      { id: "a3", description: "Flaky one", agentType: null, status: "failed", startedAt: 7 },
    ];
    const jobs = deriveBackgroundJobs([], subagents, null, null);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.id, "subagent:a1");
    assert.equal(jobs[0]!.kind, "subagent");
    assert.equal(jobs[0]!.label, "Explore the repo");
    assert.equal(jobs[0]!.startedAt, 5);
  });

  it("a subagent row with no startedAt (older store rows) reports null, not a crash", () => {
    const subagents: SubagentInfo[] = [
      { id: "a1", description: "Legacy row", agentType: null, status: "running" },
    ];
    const jobs = deriveBackgroundJobs([], subagents, null, null);
    assert.equal(jobs[0]!.startedAt, null);
  });

  it("a running workflow agent is listed with its phase and model", () => {
    const workflow: WorkflowView = {
      id: "w1",
      name: "Build",
      settled: 1,
      total: 3,
      tokensTotal: 0,
      complete: false,
      phases: [
        {
          name: "Implement",
          pipelined: false,
          agents: [
            { id: "g1", model: "opus", status: "running", tokensUsed: 0 },
            { id: "g2", model: "sonnet", status: "settled", tokensUsed: 0 },
          ],
        },
      ],
    };
    const jobs = deriveBackgroundJobs([], null, workflow, 100);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.id, "workflow:g1");
    assert.equal(jobs[0]!.kind, "workflow");
    assert.equal(jobs[0]!.label, "Implement · opus");
    assert.equal(jobs[0]!.startedAt, 100);
  });

  it("combines shells, subagents and workflow agents into one list", () => {
    const subagents: SubagentInfo[] = [
      { id: "a1", description: "Helper", agentType: null, status: "running", startedAt: 1 },
    ];
    const workflow: WorkflowView = {
      id: "w1",
      name: "Build",
      settled: 0,
      total: 1,
      tokensTotal: 0,
      complete: false,
      phases: [
        { name: "Implement", pipelined: false, agents: [{ id: "g1", model: "opus", status: "running", tokensUsed: 0 }] },
      ],
    };
    const jobs = deriveBackgroundJobs(
      [
        toolMsg({
          name: "Bash",
          input: JSON.stringify({ command: "npm run watch", run_in_background: true }),
          output: "Running in the background with ID: bash_1",
        }, 10),
      ],
      subagents,
      workflow,
      5,
    );
    const kinds = jobs.map((j) => j.kind).sort();
    assert.deepEqual(kinds, ["shell", "subagent", "workflow"]);
  });
});
