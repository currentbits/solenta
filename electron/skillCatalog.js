"use strict";

/**
 * Main-process curated skill catalog. Renderer looks up by id only; URLs
 * never come from the client.
 */

const { listSkills } = require("./skills.js");

const PONYTAIL_URL = "https://github.com/DietrichGebert/ponytail";

/** @type {readonly { id: string, name: string, description: string, publisher: string, sourceUrl: string, homepage: string }[]} */
const CATALOG = Object.freeze([
  Object.freeze({
    id: "ponytail",
    name: "Ponytail",
    description:
      "Lazy senior dev mode. Forces the simplest, shortest solution that actually works: YAGNI, stdlib first, no unrequested abstractions.",
    publisher: "Dietrich Gebert",
    sourceUrl: PONYTAIL_URL,
    homepage: PONYTAIL_URL,
  }),
]);

/**
 * @param {unknown} id
 * @returns {(typeof CATALOG)[number] | null}
 */
function getCatalogEntry(id) {
  const key = typeof id === "string" ? id.trim() : "";
  if (!key) return null;
  return CATALOG.find((entry) => entry.id === key) || null;
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, userDataPath?: string }} [opts]
 */
function listCatalog(opts = {}) {
  const env = opts.env || process.env;
  const listed = listSkills(null, env, opts.userDataPath);
  const installedIds = new Set();
  for (const row of listed) {
    if (
      row.provenance === "curated" &&
      row.origin &&
      typeof row.origin.catalogId === "string" &&
      row.origin.catalogId
    ) {
      installedIds.add(row.origin.catalogId);
    }
  }
  return CATALOG.map((entry) => ({
    id: entry.id,
    name: entry.name,
    description: entry.description,
    publisher: entry.publisher,
    sourceUrl: entry.sourceUrl,
    homepage: entry.homepage,
    installed: installedIds.has(entry.id),
  }));
}

module.exports = {
  CATALOG,
  getCatalogEntry,
  listCatalog,
};
