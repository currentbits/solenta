"use strict";
const { it } = require("node:test");
const assert = require("node:assert/strict");
const { createKeyPair, thumbprint, signProof, verifyProof } = require("../cloud/protocol.js");

it("cloud proofs bind their signing key, purpose, destination and expiry", async () => {
  const key = await createKeyPair();
  const other = await createKeyPair();
  assert.equal(key.publicJwk.d, undefined);
  assert.match(await thumbprint(key.publicJwk), /^[A-Za-z0-9_-]{43}$/);
  const proof = await signProof(key.privateJwk, { nonce: "a-unique-request", sub: "owner" }, "mint", "computer-one", 1_000_000);
  const opts = { purpose: "mint", audience: "computer-one", now: 1_001_000 };
  assert.equal((await verifyProof(proof, key.publicJwk, opts)).sub, "owner");
  await assert.rejects(verifyProof(proof, other.publicJwk, opts));
  await assert.rejects(verifyProof(proof, key.publicJwk, { ...opts, purpose: "exchange" }));
  await assert.rejects(verifyProof(proof, key.publicJwk, { ...opts, audience: "computer-two" }));
  await assert.rejects(verifyProof(proof, key.publicJwk, { ...opts, now: 1_061_000 }));
  await assert.rejects(verifyProof("x".repeat(20_000), key.publicJwk, opts));
});

it("cloud proofs reject unsupported algorithms and attacker-selected key headers", async () => {
  const { SignJWT } = await import("jose");
  const key = await createKeyPair();
  const forged = await new SignJWT({ purpose: "mint" }).setProtectedHeader({ alg: "HS256" })
    .setAudience("computer-one").setIssuedAt(1000).setExpirationTime(1060).sign(new Uint8Array(32));
  await assert.rejects(verifyProof(forged, key.publicJwk, { purpose: "mint", audience: "computer-one", now: 1_001_000 }));
  await assert.rejects(thumbprint({ ...key.publicJwk, d: "private-key-material" }));
});
