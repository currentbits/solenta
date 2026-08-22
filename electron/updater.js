"use strict";

// Auto-updater over plain GitHub releases (no electron-updater: the app is
// assembled by scripts/package-app.sh, unsigned, so Squirrel is out).
//
// Two channels, stamped into the embedded package.json at package time:
//   prod    -> newest non-prerelease (GET /releases/latest)
//   nightly -> newest release of any kind (prereleases included)
// A build with no channel/releaseTag stamp (dev tree, local install-swap
// bundle) never updates itself.
//
// Checks are automatic; installs are not. checkUpdate() only asks the API;
// downloadUpdate() is what the user clicks, and it verifies the asset against
// the sha256 digest GitHub stamps on it before anything touches the bundle.
//
// Install on macOS reuses the proven swap: mv the running bundle aside as
// Solenta.app.old, ditto the new one into place, delete .old on next boot.
// The swapped-in bundle also means a plain quit+relaunch picks up the new
// build even if the user never clicks "Restart".
// ponytail: auto-install is macOS-only; win/linux get the release URL.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const REPO = "currentbits/solenta";
const API = `https://api.github.com/repos/${REPO}/releases`;
const HEADERS = {
  "User-Agent": "solenta-updater",
  Accept: "application/vnd.github+json",
};

/** @param {string} cmd @param {string[]} args */
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err) => (err ? reject(err) : resolve(undefined)));
  });
}

/** Channel/tag stamped by package-app.sh; nulls in a dev tree. */
function buildStamp(pkg) {
  try {
    const p = pkg || require("../package.json");
    return {
      channel: p.channel ? String(p.channel) : null,
      tag: p.releaseTag ? String(p.releaseTag) : null,
    };
  } catch {
    return { channel: null, tag: null };
  }
}

/** .app bundle root of the running process, or null when not a bundle. */
function bundlePath(execPath) {
  if (process.platform !== "darwin") return null;
  // Contents/MacOS/Solenta -> three levels up.
  const root = path.resolve(execPath || process.execPath, "..", "..", "..");
  // Refuse to swap a dev Electron.app out of node_modules.
  if (!root.endsWith(".app") || root.includes("node_modules")) return null;
  return root;
}

/** The release asset for this platform/arch, or null. */
function pickAsset(release, platform, arch) {
  const token =
    (platform || process.platform) === "darwin"
      ? `macos-${arch || process.arch}`
      : `${platform || process.platform}-${arch || process.arch}`;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  return assets.find((a) => a && a.name && a.name.includes(token)) || null;
}

/** Publish time of a release, 0 when GitHub sends neither stamp. */
function releaseTime(r) {
  return Date.parse(r.published_at || r.created_at || "") || 0;
}

/**
 * Latest release for a channel. prod trusts GitHub's "latest" (newest
 * non-prerelease); nightly takes the newest release of either kind. Nightly
 * means "newest code", so it has to include prod releases: a prerelease-only
 * feed freezes a nightly install forever as soon as prod moves ahead and no
 * newer nightly is cut. The channel itself is kept by the settings pin in
 * ipc.js, not by refusing to see prod tags.
 *
 * The list endpoint is NOT time-ordered: GitHub floats the "latest"
 * (non-prerelease) release to the front, so a prod tag cut this morning
 * outranks a nightly cut tonight and the nightly install is offered a
 * downgrade it can never satisfy. Pick by publish time instead of position.
 */
async function fetchLatest(channel, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  if (channel === "nightly") {
    const res = await doFetch(`${API}?per_page=15`, { headers: HEADERS });
    if (!res.ok) throw new Error(`GitHub releases: HTTP ${res.status}`);
    const list = await res.json();
    const live = (Array.isArray(list) ? list : []).filter((r) => r && !r.draft);
    let best = null;
    for (const r of live) {
      if (!best || releaseTime(r) > releaseTime(best)) best = r;
    }
    return best;
  }
  const res = await doFetch(`${API}/latest`, { headers: HEADERS });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub releases: HTTP ${res.status}`);
  return res.json();
}

/** @type {Promise<any> | null} */
let checking = null;
/** @type {Promise<any> | null} */
let installing = null;
/** @type {string | null} tag already swapped into place this boot */
let stagedTag = null;

/**
 * Check the channel for a newer release. Never touches the installed bundle.
 * Resolves to an UpdateStatus (src/shared/ipc.ts).
 */
function checkUpdate(deps = {}) {
  if (!checking) {
    checking = doCheck(deps, false).finally(() => {
      checking = null;
    });
  }
  return checking;
}

/** Download + verify + swap the new bundle in. User-initiated only. */
function downloadUpdate(deps = {}) {
  if (!installing) {
    installing = doCheck(deps, true).finally(() => {
      installing = null;
    });
  }
  return installing;
}

async function doCheck(deps, install) {
  const stamp = buildStamp(deps.pkg);
  // Settings override wins; the stamped tag is still required so a dev tree
  // (no releaseTag) can never update itself onto a channel.
  const channel = deps.channelOverride || stamp.channel;
  const tag = stamp.tag;
  const status = { state: "disabled", channel, tag: null, url: null, error: null };
  if (!channel || !tag) return status;
  if (stagedTag) return { ...status, state: "staged", tag: stagedTag };

  try {
    const latest = await fetchLatest(channel, deps.fetch);
    if (!latest || latest.tag_name === tag) {
      return { ...status, state: "none" };
    }
    status.tag = String(latest.tag_name);
    status.url = latest.html_url ? String(latest.html_url) : null;

    const asset = pickAsset(latest, deps.platform, deps.arch);
    const bundle = deps.bundlePath !== undefined ? deps.bundlePath : bundlePath();
    if (!install || !asset || !bundle) return { ...status, state: "available" };

    await stage(asset, bundle, status.tag, deps);
    stagedTag = status.tag;
    return { ...status, state: "staged" };
  } catch (err) {
    return {
      ...status,
      state: status.tag ? "available" : "error",
      error: err && err.message ? String(err.message) : String(err),
    };
  }
}

/** Download the zip, check its digest, swap the bundle (mv aside + ditto in). */
async function stage(asset, bundle, tag, deps) {
  const doFetch = deps.fetch || fetch;
  // GitHub stamps `digest` ("sha256:<hex>") on release assets server-side. The
  // artifact is unsigned, so this is the only integrity check there is: no
  // digest means no auto-install, and the user installs from the release page.
  const want = /^sha256:([0-9a-f]{64})$/.exec(String(asset.digest || ""));
  if (!want) throw new Error("release asset carries no sha256 digest");
  const work = path.join(os.tmpdir(), `solenta-update-${tag.replace(/[^\w.-]/g, "_")}`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  try {
    const zip = path.join(work, "update.zip");
    const res = await doFetch(asset.browser_download_url, {
      headers: { "User-Agent": HEADERS["User-Agent"] },
    });
    if (!res.ok || !res.body) throw new Error(`download: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(zip));

    const hash = crypto.createHash("sha256");
    await pipeline(fs.createReadStream(zip), hash);
    const got = hash.digest("hex");
    if (got !== want[1]) throw new Error(`digest mismatch: expected ${want[1]}, got ${got}`);

    await run("ditto", ["-x", "-k", zip, work]);
    const newApp = fs
      .readdirSync(work)
      .map((n) => path.join(work, n))
      .find((p) => p.endsWith(".app") && fs.existsSync(path.join(p, "Contents")));
    if (!newApp) throw new Error("update zip contains no .app bundle");

    const old = `${bundle}.old`;
    fs.rmSync(old, { recursive: true, force: true });
    fs.renameSync(bundle, old);
    try {
      await run("ditto", [newApp, bundle]);
    } catch (err) {
      // Put the running bundle back; a half-swapped install is the one
      // failure mode that loses the app entirely.
      fs.rmSync(bundle, { recursive: true, force: true });
      fs.renameSync(old, bundle);
      throw err;
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Relaunch into the (already swapped-in) new bundle. */
function applyUpdate() {
  const { app } = require("electron");
  app.relaunch();
  app.quit();
}

/** Delete the previous bundle left aside by the last update. Boot-time. */
function cleanupOldBundle(deps = {}) {
  const bundle = deps.bundlePath !== undefined ? deps.bundlePath : bundlePath();
  if (!bundle) return;
  fs.rm(`${bundle}.old`, { recursive: true, force: true }, () => {});
}

module.exports = {
  checkUpdate,
  downloadUpdate,
  applyUpdate,
  cleanupOldBundle,
  // seams for tests
  buildStamp,
  bundlePath,
  pickAsset,
  fetchLatest,
  stage,
};
