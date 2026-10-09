/**
 * Issue #1529: signed model catalog between releases.
 * Run: node --test electron/test/remote-catalog.test.js
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const rc = require("../remoteCatalog.js");
const { PROVIDERS, CATALOG_REV } = require("../providers.js");
const { rmTree } = require("./support/rmTree.js");

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const PUB = publicKey.export({ type: "spki", format: "pem" });

function signed(rev, mutate = () => {}) {
  const catalog = rc.dumpCatalog(rev);
  mutate(catalog);
  const body = JSON.stringify(catalog);
  return { body, sig: crypto.sign(null, Buffer.from(body), privateKey).toString("base64") };
}

/** Deep copy so tests never touch the live registry. */
const copyProviders = () =>
  PROVIDERS.map((p) => ({ ...p, models: p.models.slice(), modelInfo: p.modelInfo.map((m) => ({ ...m })) }));

function fakeFetch(files) {
  return async (url) => {
    const name = url.split("/").pop();
    return name in files
      ? { ok: true, status: 200, text: async () => files[name] }
      : { ok: false, status: 404, text: async () => "" };
  };
}

const addModel = (c) =>
  c.providers.codex.modelInfo.unshift({ id: "gpt-7", label: "GPT-7", description: "new", vendor: "OpenAI", fast: true });

describe("remote catalog", () => {
  let dir;
  beforeEach(() => {
    rc.resetAppliedRev();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-remote-catalog-"));
  });
  afterEach(async () => {
    rc.resetAppliedRev();
    await rmTree(dir);
  });

  it("the bundled dump round-trips through sign + verify; tampering fails", () => {
    const { body, sig } = signed(CATALOG_REV);
    assert.equal(rc.verifyCatalog(body, sig, PUB), true);
    assert.equal(rc.verifyCatalog(body.replace("Opus", "0pus"), sig, PUB), false);
    assert.equal(rc.verifyCatalog(body, sig), false, "a foreign key never verifies against the embedded one");
  });

  it("applies only a newer rev and never downgrades past what it applied", () => {
    const providers = copyProviders();
    assert.equal(rc.applyCatalog(signed(CATALOG_REV, addModel).body, { providers }), false);
    assert.equal(rc.applyCatalog(signed(CATALOG_REV + 2, addModel).body, { providers }), true);
    assert.equal(providers.find((p) => p.id === "codex").modelInfo[0].id, "gpt-7");
    assert.equal(rc.applyCatalog(signed(CATALOG_REV + 1).body, { providers }), false);
  });

  it("keeps bundled data for a provider whose block is malformed", () => {
    const providers = copyProviders();
    const before = providers.find((p) => p.id === "claude").modelInfo.length;
    const { body } = signed(CATALOG_REV + 1, (c) => {
      c.providers.claude.modelInfo = [{ id: 7 }];
      addModel(c);
    });
    assert.equal(rc.applyCatalog(body, { providers }), true);
    assert.equal(providers.find((p) => p.id === "claude").modelInfo.length, before);
    assert.equal(providers.find((p) => p.id === "codex").modelInfo[0].id, "gpt-7");
  });

  it("fetches, verifies, caches, and starts the next launch from the cache", async () => {
    const providers = copyProviders();
    const good = signed(CATALOG_REV + 1, addModel);
    const applied = await rc.initRemoteCatalog(dir, {
      fetch: fakeFetch({ "catalog.json": good.body, "catalog.json.sig": good.sig }),
      publicKey: PUB,
      providers,
    });
    assert.equal(applied, true);
    assert.equal(fs.readFileSync(path.join(dir, "catalog.json"), "utf8"), good.body);

    rc.resetAppliedRev();
    const fresh = copyProviders();
    const offline = await rc.initRemoteCatalog(dir, { fetch: fakeFetch({}), publicKey: PUB, providers: fresh });
    assert.equal(offline, false);
    assert.equal(fresh.find((p) => p.id === "codex").modelInfo[0].id, "gpt-7", "cache applied offline");
  });

  it("rejects a bad signature and leaves no cache", async () => {
    const providers = copyProviders();
    const good = signed(CATALOG_REV + 1, addModel);
    const applied = await rc.initRemoteCatalog(dir, {
      fetch: fakeFetch({ "catalog.json": good.body.replace("GPT-7", "GPT-8"), "catalog.json.sig": good.sig }),
      publicKey: PUB,
      providers,
    });
    assert.equal(applied, false);
    assert.equal(fs.existsSync(path.join(dir, "catalog.json")), false);
    assert.notEqual(providers.find((p) => p.id === "codex").modelInfo[0].id, "gpt-7");
  });
});
