"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPeerLinks } = require("../peerLinks.js");
const { parseDirectUrl } = require("../remoteConnections.js");

describe("linked computers (#1832)", () => {
  it("pins verified peer identity across token rotation and fragment links", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peers-id-"));
    const probes = [];
    const links = createPeerLinks({ userDataPath: dir, hub: { setPeers() {} }, remote: {
      parseDirectUrl,
      probeToken: async (url, token, opts) => { probes.push({ url, token, opts }); return { computerId: "computer-one" }; },
    } });
    try {
      await links.link({ link: "https://box.ts.net/#token=secret&computerId=computer-one" });
      assert.equal(probes[0].opts.computerId, "computer-one");
      assert.equal(links.list()[0].computerId, "computer-one");
      await links.link({ link: "https://box.ts.net/#token=rotated" });
      assert.equal(probes[1].opts.computerId, "computer-one");
      await assert.rejects(links.link({ link: "https://box.ts.net/#token=wrong&computerId=computer-two" }), /identity mismatch/);
      assert.equal(probes.length, 2, "mismatched link never reaches the credential probe");
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "peers.json"), "utf8"))[0].token, "rotated");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("checks the token, keeps it in a private file, never hands it out, and feeds the hub", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peers-"));
    const fed = [];
    const probed = [];
    const links = createPeerLinks({
      userDataPath: dir,
      hub: { setPeers: (rows) => fed.push(rows) },
      remote: { parseDirectUrl, probeToken: async (url, token) => { probed.push([url, token]); if (token === "bad") throw new Error("rejected this token"); } },
    });
    try {
      const rows = await links.link({ link: "http://mac.tailnet.ts.net:4620/?token=s3cret", label: "Mac" });
      assert.deepEqual(rows, [{ key: "http://mac.tailnet.ts.net:4620", url: "http://mac.tailnet.ts.net:4620", label: "Mac" }]);
      assert.deepEqual(probed, [["http://mac.tailnet.ts.net:4620", "s3cret"]], "checked before saving");
      const file = path.join(dir, "peers.json");
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8"))[0].token, "s3cret");
      assert.equal(fed.at(-1)[0].token, "s3cret", "the hub gets the token to connect with");
      assert.equal(JSON.stringify(links.list()).includes("s3cret"), false);

      await assert.rejects(links.link({ link: "http://mac.tailnet.ts.net:4620/" }), /device link/);
      await assert.rejects(links.link({ link: "http://8.8.8.8/?token=x" }), /Plain http/);
      await assert.rejects(links.link({ link: "http://box.lan/?token=bad" }), /rejected this token/);
      assert.equal(links.list().length, 1, "a refused link is not saved");

      // Relinking the same address replaces it; a restart reconnects.
      await links.link({ link: "http://mac.tailnet.ts.net:4620/?token=new", label: "Mac 2" });
      assert.deepEqual(links.list().map((r) => r.label), ["Mac 2"]);
      const again = [];
      createPeerLinks({ userDataPath: dir, hub: { setPeers: (r) => again.push(r) } }).start();
      assert.equal(again[0][0].token, "new");

      assert.deepEqual(links.unlink({ key: "http://mac.tailnet.ts.net:4620" }), []);
      assert.deepEqual(fed.at(-1), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
