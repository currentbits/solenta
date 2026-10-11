const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { parseDeepLink, deepLinkFromArgv } = require("../deepLinks.js");

const ID = "9f837e97-3bea-4df8-86bf-d6ddd40fadbf";

describe("solenta:// deep links", () => {
  it("routes thread and project links", () => {
    assert.deepEqual(parseDeepLink(`solenta://thread/${ID}`), { kind: "thread", id: ID });
    assert.deepEqual(parseDeepLink(`solenta://project/${ID}/`), { kind: "project", id: ID });
  });

  it("rejects other schemes, kinds and malformed ids", () => {
    for (const url of [
      `https://thread/${ID}`,
      `solenta://settings/${ID}`,
      "solenta://thread/",
      "solenta://thread/a/b",
      "solenta://thread/%2e%2e",
      "not a url",
      undefined,
    ]) {
      assert.equal(parseDeepLink(url), null, String(url));
    }
  });

  it("finds the link among launch arguments", () => {
    assert.deepEqual(
      deepLinkFromArgv(["/opt/Solenta/solenta", "--no-sandbox", `solenta://thread/${ID}`]),
      { kind: "thread", id: ID },
    );
    assert.equal(deepLinkFromArgv(["/opt/Solenta/solenta"]), null);
  });
});
