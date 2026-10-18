/**
 * #262: HMAC-chained governance audit — chain verifies, tampering fails.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAudit } = require("../governanceAudit.js");

function row(extra = {}) {
  return {
    threadId: "t-1",
    profileId: "p-1",
    provider: "claude",
    toolName: "Bash",
    actionHash: "a".repeat(64),
    declared: { tool: "bash", command: "npm publish", path: null, hosts: [] },
    executed: null,
    decision: "deny",
    layer: "profile.block",
    rule: "bash:npm publish",
    reason: "blocked by profile (never allowed)",
    ...extra,
  };
}

function lines(audit) {
  return fs.readFileSync(audit.logPath, "utf8").split("\n").filter(Boolean);
}

function rewrite(audit, mutate) {
  const ls = lines(audit).map((l) => JSON.parse(l));
  mutate(ls);
  fs.writeFileSync(audit.logPath, ls.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

describe("governance audit", () => {
  let dir;
  let audit;
  const warnings = [];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gov-audit-"));
    warnings.length = 0;
    audit = createAudit({ dir, log: (m) => warnings.push(m) });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("an untouched chain verifies; envelope carries decision, layer, actionHash", () => {
    audit.append(row());
    audit.append(row({ decision: "allow", layer: "profile.allow", executed: row().declared }));
    audit.append(row({ decision: "ask", layer: "profile.ask" }));
    assert.deepEqual(audit.verify(), { ok: true, entries: 3 });
    const first = JSON.parse(lines(audit)[0]);
    assert.equal(first.seq, 1);
    assert.equal(first.prev, "0".repeat(64));
    assert.equal(first.decision, "deny");
    assert.equal(first.layer, "profile.block");
    assert.equal(first.actionHash, "a".repeat(64));
    assert.match(first.hmac, /^[0-9a-f]{64}$/);
    assert.equal(JSON.parse(lines(audit)[1]).prev, first.hmac);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(audit.logPath).mode & 0o777, 0o600);
      assert.equal(fs.statSync(audit.keyPath).mode & 0o777, 0o600);
    }
  });

  it("a hand-edited layer fails verify at that seq", () => {
    audit.append(row());
    audit.append(row());
    rewrite(audit, (ls) => {
      ls[1].layer = "profile.allow";
    });
    assert.deepEqual(audit.verify(), { ok: false, seq: 2, reason: "hmac mismatch" });
  });

  it("a flipped bit in the hmac fails verify", () => {
    audit.append(row());
    rewrite(audit, (ls) => {
      const h = ls[0].hmac;
      ls[0].hmac = (h[0] === "0" ? "1" : "0") + h.slice(1);
    });
    assert.equal(audit.verify().ok, false);
  });

  it("a deleted line breaks the chain", () => {
    audit.append(row());
    audit.append(row());
    audit.append(row());
    rewrite(audit, (ls) => ls.splice(1, 1));
    const v = audit.verify();
    assert.equal(v.ok, false);
    assert.equal(v.seq, 2);
  });

  it("a missing key with entries fails verify and refuses to rotate", () => {
    audit.append(row());
    fs.rmSync(audit.keyPath);
    assert.deepEqual(audit.verify(), { ok: false, reason: "missing key" });
    const fresh = createAudit({ dir, log: (m) => warnings.push(m) });
    assert.equal(fresh.append(row()), null);
    assert.equal(fs.existsSync(fresh.keyPath), false);
    assert.match(warnings.join("\n"), /key is missing/);
  });

  it("resumes the chain from disk in a new process", () => {
    audit.append(row());
    const again = createAudit({ dir });
    again.append(row({ threadId: "t-2" }));
    assert.deepEqual(again.verify(), { ok: true, entries: 2 });
    assert.equal(again.list()[0].seq, 2);
  });

  it("list is newest-first, filterable, capped at 50, and hides hmac/prev", () => {
    for (let i = 0; i < 55; i++) audit.append(row({ threadId: i % 2 ? "odd" : "even" }));
    const all = audit.list({ limit: 500 });
    assert.equal(all.length, 50);
    assert.equal(all[0].seq, 55);
    assert.equal("hmac" in all[0], false);
    assert.equal("prev" in all[0], false);
    assert.ok(audit.list({ threadId: "odd" }).every((r) => r.threadId === "odd"));
    assert.equal(audit.list({ limit: 3 }).length, 3);
  });

  it("redacts secrets and truncates long commands before persisting", () => {
    const token = `ghp_${"A".repeat(36)}`;
    audit.append(
      row({
        declared: {
          tool: "bash",
          command: `curl -H "Authorization: ${token}" ${"x".repeat(600)}`,
          path: null,
          hosts: [],
        },
      }),
    );
    const text = fs.readFileSync(audit.logPath, "utf8");
    assert.equal(text.includes(token), false);
    assert.ok(JSON.parse(lines(audit)[0]).declared.command.length <= 501);
  });
});
