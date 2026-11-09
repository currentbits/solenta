"use strict";

const jose = () => import("jose");
const PROOF_SECONDS = 60;

function publicKey(jwk) {
  if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(jwk.x) || jwk.d !== undefined) throw new Error("Invalid cloud public key.");
  return { kty: "OKP", crv: "Ed25519", x: jwk.x };
}

async function createKeyPair() {
  const { generateKeyPair, exportJWK } = await jose();
  const pair = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  return { privateJwk: await exportJWK(pair.privateKey), publicJwk: await exportJWK(pair.publicKey) };
}

async function thumbprint(jwk) {
  return (await jose()).calculateJwkThumbprint(publicKey(jwk));
}

async function signProof(privateJwk, claims, purpose, audience, now = Date.now()) {
  const { SignJWT, importJWK } = await jose();
  const seconds = Math.floor(now / 1000);
  return new SignJWT({ ...claims, purpose }).setProtectedHeader({ alg: "EdDSA", typ: "solenta+proof" })
    .setIssuer("solenta-connect").setAudience(audience).setIssuedAt(seconds).setExpirationTime(seconds + PROOF_SECONDS)
    .sign(await importJWK(privateJwk, "EdDSA"));
}

async function verifyProof(proof, jwk, { purpose, audience, now = Date.now() }) {
  if (typeof proof !== "string" || proof.length > 16384) throw new Error("Invalid cloud proof.");
  const { jwtVerify, importJWK } = await jose();
  const { payload, protectedHeader } = await jwtVerify(proof, await importJWK(publicKey(jwk), "EdDSA"), {
    algorithms: ["EdDSA"], typ: "solenta+proof", issuer: "solenta-connect", audience,
    maxTokenAge: PROOF_SECONDS, currentDate: new Date(now),
  });
  if (Object.keys(protectedHeader).some(key => !["alg", "typ"].includes(key)) || payload.purpose !== purpose ||
      !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) || payload.exp <= payload.iat ||
      payload.exp - payload.iat > PROOF_SECONDS) throw new Error("Invalid cloud proof binding.");
  return payload;
}

module.exports = { createKeyPair, thumbprint, signProof, verifyProof, publicKey };
