"use strict";

// createIOSSimulatorService seam: Xcode developer directory selection, device
// and capability discovery, and the toolchain entry points (#1447 pass V2,
// seam 2). Convention: see the header of electron/runner-watchdogs.js; plan:
// docs/superpowers/specs/2026-10-05-ios-simulator-split.md.

const {
  IOSSimulatorError,
  iosError,
  remapToolchainError,
  parseXcodeVersion,
  parseSimulatorList,
  capabilitySnapshot,
  runActiveDeveloperDir,
  runXcodeVersion,
  runFirstLaunchStatus,
  runFindSimctl,
  runListDevices,
  validateCandidateDeveloperDir,
} = require("./ios-simulator-parse.js");

/**
 * @param {object} ctx - createIOSSimulatorService context
 */
function createDevices(ctx) {
  const {
    processAdapter,
    preferencesFile,
    resolvedToolchain,
    resolveThread,
    helperCapsForSnapshot,
    readPreferences,
    writePreferences,
  } = ctx;

  async function selectedDeveloperDirectory() {
    const saved = await readPreferences(preferencesFile);
    if (saved) {
      return saved.developerDir;
    }
    return String(
      await runActiveDeveloperDir(() => processAdapter.activeDeveloperDir()),
    ).trim();
  }

  async function discoverRaw(developerDir) {
    const dir = developerDir ?? (await selectedDeveloperDirectory());
    const versionText = String(
      await runXcodeVersion(() => processAdapter.xcodeVersion(dir)),
    ).trim();
    await runFirstLaunchStatus(() => processAdapter.firstLaunchStatus(dir));
    await runFindSimctl(() => processAdapter.findSimctl(dir));
    let doc;
    try {
      const listText = await runListDevices(() => processAdapter.listDevices(dir));
      doc = JSON.parse(listText);
    } catch (err) {
      if (err instanceof IOSSimulatorError) throw err;
      throw iosError("unexpected", "Simulator device list is invalid");
    }
    return {
      developerDir: dir,
      xcode: parseXcodeVersion(versionText),
      ...parseSimulatorList(doc),
    };
  }

  async function discoverDevices() {
    return (await discoverRaw()).devices;
  }

  async function discoverCapabilities() {
    const raw = await discoverRaw();
    return capabilitySnapshot(raw, helperCapsForSnapshot());
  }

  async function validateDeveloperDirectory(developerDir) {
    const selected = validateCandidateDeveloperDir(developerDir);
    return discoverRaw(selected);
  }

  async function validateAndPersistDeveloperDirectory(developerDir) {
    const raw = await validateDeveloperDirectory(developerDir);
    await writePreferences(preferencesFile, {
      version: 1,
      developerDir: raw.developerDir,
    });
    return capabilitySnapshot(raw);
  }

  async function getCapabilities(input) {
    const threadId = input && input.threadId;
    resolveThread(threadId);
    return discoverCapabilities();
  }

  async function selectDeveloperDirectory(input) {
    const threadId = input && input.threadId;
    const developerDir = input && input.developerDir;
    resolveThread(threadId);
    return validateAndPersistDeveloperDirectory(developerDir);
  }

  async function listDevices(input) {
    const threadId = input && input.threadId;
    resolveThread(threadId);
    return discoverDevices();
  }

  async function discoverToolchains(input) {
    resolveThread(input && input.threadId);
    const developerDir = await selectedDeveloperDirectory();
    try {
      return await resolvedToolchain.discoverToolchains(developerDir);
    } catch (err) {
      throw remapToolchainError(err);
    }
  }

  async function fingerprintToolchain(input) {
    resolveThread(input && input.threadId);
    const developerDir = await selectedDeveloperDirectory();
    try {
      return await resolvedToolchain.fingerprintToolchain(developerDir);
    } catch (err) {
      throw remapToolchainError(err);
    }
  }

  async function ensureHelper(input) {
    resolveThread(input && input.threadId);
    const developerDir = await selectedDeveloperDirectory();
    try {
      return await resolvedToolchain.ensureHelper(developerDir);
    } catch (err) {
      throw remapToolchainError(err);
    }
  }

  return {
    selectedDeveloperDirectory,
    discoverRaw,
    getCapabilities,
    selectDeveloperDirectory,
    listDevices,
    discoverToolchains,
    fingerprintToolchain,
    ensureHelper,
  };
}

module.exports = { createDevices };
