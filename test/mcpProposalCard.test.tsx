import assert from "node:assert/strict";
import { it, afterEach } from "node:test";
import { mount, unmountAll } from "./support/dom.ts";
import { McpProposalCard } from "../src/components/McpProposalCard";
import type { McpProposal, McpProposalResolution } from "../src/shared/ipc";

afterEach(unmountAll);
const proposal: McpProposal = { id: "proposal1", reviewToken: "review1", action: "add", status: "pending", at: Date.now(), config: {
  name: "project-tools", transport: "stdio", command: "npx", args: ["--yes", "example-mcp", "a value with spaces"], cwd: "/tmp/project",
  envNames: ["API_KEY"], headerNames: [],
} };

it("requires review, exact command details, trust and local credential entry before approval", async () => {
  const calls: McpProposalResolution[] = [];
  const m = await mount(<McpProposalCard threadId="t1" proposal={proposal} onResolve={async (input) => {
    calls.push(input); return { ...proposal, status: "approved" };
  }} />);
  assert.equal(m.byText("Approve connector"), null);
  assert.deepEqual(calls, []);
  await m.click(m.byText("Review connection"));
  assert.match(m.text(), /npx/);
  assert.match(m.text(), /a value with spaces/);
  assert.match(m.text(), /\/tmp\/project/);
  assert.match(m.text(), /all projects/);
  const approve = m.byText("Approve connector") as HTMLButtonElement;
  assert.equal(approve.disabled, true);
  const secret = m.query('input[type="password"]') as HTMLInputElement;
  await m.type(secret, "local-only-secret");
  assert.ok(!m.text().includes("local-only-secret"));
  assert.equal(approve.disabled, true);
  await m.click(m.query('input[type="checkbox"]'));
  assert.equal(approve.disabled, false);
  await m.click(approve);
  await m.flush();
  assert.deepEqual(calls, [{ threadId: "t1", proposalId: "proposal1", reviewToken: "review1", resolution: "approved", trustLocal: true, secrets: { "env:API_KEY": "local-only-secret" } }]);
  assert.match(m.text(), /Connector approved/);
  assert.equal(m.query('input[type="password"]'), null);
});

it("resets review and hides approval if proposal contents change", async () => {
  const resolve = async () => proposal;
  const m = await mount(<McpProposalCard threadId="t1" proposal={proposal} onResolve={resolve} />);
  await m.click(m.byText("Review connection"));
  await m.type(m.query('input[type="password"]') as HTMLInputElement, "old-secret");
  await m.click(m.query('input[type="checkbox"]'));
  await m.rerender(<McpProposalCard threadId="t1" proposal={{ ...proposal, reviewToken: "review2", config: { ...proposal.config, command: "changed" } }} onResolve={resolve} />);
  assert.equal(m.byText("Approve connector"), null);
  await m.click(m.byText("Review connection"));
  assert.equal((m.query('input[type="password"]') as HTMLInputElement).value, "");
  assert.equal((m.query('input[type="checkbox"]') as HTMLInputElement).checked, false);
  assert.match(m.text(), /changed/);
});

it("dismisses without credential values and has no action in a web client", async () => {
  const calls: McpProposalResolution[] = [];
  const m = await mount(<McpProposalCard threadId="t1" proposal={proposal} onResolve={async (input) => {
    calls.push(input); return { ...proposal, status: "dismissed" };
  }} />);
  await m.click(m.byText("Dismiss proposal"));
  assert.deepEqual(calls, [{ threadId: "t1", proposalId: "proposal1", resolution: "dismissed" }]);
  await m.rerender(<McpProposalCard key="web" threadId="t1" proposal={proposal} />);
  assert.match(m.text(), /owning computer/);
  await m.click(m.byText("Review connection"));
  assert.equal((m.byText("Approve connector") as HTMLButtonElement).disabled, true);
  assert.equal((m.byText("Dismiss proposal") as HTMLButtonElement).disabled, true);
});

it("shows removal as an explicit second action and preserves a failed proposal for retry", async () => {
  const removal: McpProposal = { ...proposal, action: "remove", config: { name: "project-tools" } };
  let attempts = 0;
  const m = await mount(<McpProposalCard threadId="t1" proposal={removal} onResolve={async () => {
    if (++attempts === 1) throw new Error("MCP configuration changed; request a fresh proposal");
    return { ...removal, status: "approved" };
  }} />);
  assert.equal(m.byText("Remove connector"), null);
  await m.click(m.byText("Review connection"));
  assert.equal(m.query('input[type="checkbox"]'), null);
  await m.click(m.byText("Remove connector"));
  assert.match(m.query('[role="alert"]')!.textContent!, /configuration changed/);
  await m.click(m.byText("Remove connector"));
  assert.match(m.text(), /Connector removed/);
});
