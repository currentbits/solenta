#!/usr/bin/env node
"use strict";

/**
 * Sign the bundled model catalog for the `catalog` release (#1529).
 * Usage: CATALOG_SIGNING_KEY="$(cat key.pem)" node scripts/catalog-publish.js <outDir>
 * Writes <outDir>/catalog.json and <outDir>/catalog.json.sig. Fails when the
 * data differs from the published copy but CATALOG_REV was not bumped, so a
 * catalog edit can never be published under an old rev (apps would ignore it).
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { dumpCatalog, verifyCatalog, BASE_URL } = require("../electron/remoteCatalog.js");

async function main() {
  const outDir = process.argv[2];
  const key = process.env.CATALOG_SIGNING_KEY;
  if (!outDir || !key) {
    console.error("usage: CATALOG_SIGNING_KEY=<pem> node scripts/catalog-publish.js <outDir>");
    process.exit(1);
  }
  const catalog = dumpCatalog();
  const body = `${JSON.stringify(catalog, null, 2)}\n`;

  const res = await fetch(`${BASE_URL}/catalog.json`);
  if (res.ok) {
    const prev = await res.json();
    const same = JSON.stringify(prev.providers) === JSON.stringify(catalog.providers);
    if (!same && prev.rev >= catalog.rev) {
      console.error(
        `catalog data changed but CATALOG_REV (${catalog.rev}) is not above the published rev ${prev.rev}; bump it in electron/providers.js`,
      );
      process.exit(1);
    }
    if (same && prev.rev === catalog.rev) {
      console.log(`catalog rev ${catalog.rev} already published; nothing to do`);
      return;
    }
  } else if (res.status !== 404) {
    throw new Error(`published catalog: HTTP ${res.status}`);
  }

  const sig = crypto.sign(null, Buffer.from(body), key).toString("base64");
  if (!verifyCatalog(body, sig)) {
    console.error("CATALOG_SIGNING_KEY does not match the public key in electron/remoteCatalog.js");
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "catalog.json"), body);
  fs.writeFileSync(path.join(outDir, "catalog.json.sig"), `${sig}\n`);
  console.log(`signed catalog rev ${catalog.rev}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
