"use strict";

/**
 * Write files onto the other side of wrapCommand (ssh / WSL).
 * One `sh -c` so a stall is one timeout, not one per file.
 */

const path = require("node:path");
const { execCommand, posixQuote } = require("./ssh.js");

/**
 * Relative dest path: no absolute, no `.` / `..` segments.
 * @param {string} rel
 * @returns {string}
 */
function safeRelPath(rel) {
  const n = String(rel || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  if (!n) return "";
  const parts = n.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return "";
  return parts.join("/");
}

/**
 * @param {string} remoteHome
 * @param {string} threadId
 * @param {string} kind  e.g. cursor-guardrails, kimi-homes
 * @returns {string}
 */
function remoteOverlayDest(remoteHome, threadId, kind) {
  const home = String(remoteHome || "").replace(/\/+$/, "");
  const id = path.posix.basename(String(threadId || ""));
  const bucket = String(kind || "");
  if (!home || !id || id !== String(threadId || "")) return "";
  if (!/^[A-Za-z0-9_-]+$/.test(bucket)) return "";
  return `${home}/.solenta/${bucket}/${id}`;
}

/**
 * @param {{ remoteHost?: string, path?: string } | null} project
 * @returns {string}
 */
function probeRemoteHome(project) {
  return String(
    execCommand(project, "sh", ["-c", 'printf %s "$HOME"'], {
      encoding: "utf8",
    }),
  ).trim();
}

/**
 * @param {{ remoteHost?: string, path?: string } | null} project
 * @param {string} dest
 * @param {Record<string, string>} files
 * @param {string[]} [extraCmds]
 */
function writeRemoteOverlay(project, dest, files, extraCmds) {
  const destClean = String(dest || "");
  if (!destClean || destClean.includes("..")) {
    throw new Error("writeRemoteOverlay: dest unusable");
  }
  const parts = [`mkdir -p ${posixQuote(destClean)}`];
  for (const [rel, body] of Object.entries(files || {})) {
    const safe = safeRelPath(rel);
    if (!safe) continue;
    const destFile = `${destClean}/${safe}`;
    const destDir = destFile.slice(0, destFile.lastIndexOf("/"));
    parts.push(`mkdir -p ${posixQuote(destDir)}`);
    const b64 = Buffer.from(String(body), "utf8").toString("base64");
    parts.push(
      `printf '%s' ${posixQuote(b64)} | base64 -d > ${posixQuote(destFile)}`,
    );
  }
  if (Array.isArray(extraCmds)) {
    for (const cmd of extraCmds) {
      if (cmd) parts.push(String(cmd));
    }
  }
  execCommand(project, "sh", ["-c", parts.join(" && ")], { encoding: "utf8" });
}

module.exports = {
  safeRelPath,
  remoteOverlayDest,
  probeRemoteHome,
  writeRemoteOverlay,
};
