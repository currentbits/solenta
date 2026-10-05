"use strict";

// createIOSSimulatorService seam: preferences file and lease journal I/O
// (#1447 pass V2, seam 1). Owns `journalTail`, the queue that orders every
// journal write, remove and quarantine. Convention: see the header of
// electron/runner-watchdogs.js; plan: docs/superpowers/specs/2026-10-05-ios-simulator-split.md.

const path = require("node:path");
const {
  IOSSimulatorError,
  iosError,
  validatePersistedDeveloperDir,
  parseLeaseJournal,
} = require("./ios-simulator-parse.js");

const QUARANTINE_MAX_ATTEMPTS = 8;

/**
 * @param {object} ctx - createIOSSimulatorService context
 */
function createJournal(ctx) {
  const { fsApi, randomUUID, now, leaseJournalFile } = ctx;

  async function readPreferences(file) {
    try {
      const stat = await fsApi.promises.lstat(file);
      if (!stat.isFile()) {
        throw iosError("unexpected", "Simulator preferences are invalid");
      }
      const parsed = JSON.parse(await fsApi.promises.readFile(file, "utf8"));
      if (!parsed || parsed.version !== 1) {
        throw iosError("unexpected", "Simulator preferences are invalid");
      }
      const developerDir = validatePersistedDeveloperDir(parsed.developerDir);
      return { version: 1, developerDir };
    } catch (error) {
      if (error instanceof IOSSimulatorError) throw error;
      if (error && error.code === "ENOENT") return null;
      throw iosError("unexpected", "Simulator preferences are invalid");
    }
  }

  async function syncParentDirectory(file) {
    try {
      const parent = path.dirname(file);
      const handle = await fsApi.promises.open(parent, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // fsync parent directory is best-effort.
    }
  }

  async function atomicWriteJson(file, value, failureMessage) {
    const maxAttempts = 5;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const temp = `${file}.${randomUUID()}.tmp`;
      let handle;
      try {
        await fsApi.promises.mkdir(path.dirname(file), { recursive: true });
        handle = await fsApi.promises.open(temp, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
        await handle.sync();
        await handle.close();
        handle = null;
        await fsApi.promises.rename(temp, file);
        await syncParentDirectory(file);
        return;
      } catch (error) {
        if (handle) {
          try {
            await handle.close();
          } catch {
            // best-effort
          }
        }
        await fsApi.promises.unlink(temp).catch(() => {});
        if (error instanceof IOSSimulatorError) throw error;
        if (attempt + 1 >= maxAttempts) {
          throw iosError("unexpected", failureMessage);
        }
      }
    }
  }

  async function writePreferences(file, value) {
    return atomicWriteJson(file, value, "Simulator preferences are invalid");
  }

  // Journal mutations run one at a time in call order. Takeover invalidates the
  // lease synchronously and then writes outside the `mutate` queue, so without
  // this an in-flight write from the superseded generation could win the rename
  // race and put the old owner back on disk. Ordering by call gives the newest
  // record the last rename, which is what makes the identity checks in
  // `clearRecordingJournalBestEffort` and the intent rollback sufficient.
  let journalTail = Promise.resolve();

  function enqueueJournalOp(op) {
    const run = journalTail.then(op, op);
    journalTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function writeJournal(value) {
    return enqueueJournalOp(() =>
      atomicWriteJson(
        leaseJournalFile,
        value,
        "Simulator lease journal is invalid",
      ),
    );
  }

  async function removeJournal() {
    try {
      await enqueueJournalOp(() => fsApi.promises.unlink(leaseJournalFile));
    } catch {
      // Best-effort: an in-memory lease release still succeeds if the
      // journal file cannot be removed; a corrupt/absent journal is
      // handled by future crash recovery, never by re-erasing a device.
    }
  }

  async function readLeaseJournalRecord() {
    let stat;
    try {
      stat = await fsApi.promises.lstat(leaseJournalFile);
    } catch (err) {
      if (err && err.code === "ENOENT") return { status: "absent" };
      return { status: "unreadable" };
    }
    if (!stat.isFile() || stat.isSymbolicLink()) return { status: "invalid" };
    let text;
    try {
      text = await fsApi.promises.readFile(leaseJournalFile, "utf8");
    } catch {
      return { status: "unreadable" };
    }
    const record = parseLeaseJournal(text);
    if (!record) return { status: "invalid" };
    return { status: "valid", record };
  }

  // Reserves each quarantine name exclusively before moving the journal onto
  // it, so a second corrupt journal in the same millisecond can never destroy
  // the evidence from the first. Runs inside the journal queue so the
  // reserve-then-rename pair cannot interleave with another journal write.
  async function quarantineJournalLocked() {
    for (let attempt = 0; attempt < QUARANTINE_MAX_ATTEMPTS; attempt += 1) {
      const suffix = attempt === 0 ? "" : `-${attempt}`;
      const target = `${leaseJournalFile}.corrupt-${now()}-${String(
        randomUUID(),
      )}${suffix}`;
      let reserved;
      try {
        reserved = await fsApi.promises.open(target, "wx", 0o600);
      } catch (err) {
        if (err && err.code === "EEXIST") continue;
        return false;
      }
      try {
        await reserved.close();
      } catch {
        // The reservation still holds the name.
      }
      try {
        await fsApi.promises.rename(leaseJournalFile, target);
        return true;
      } catch {
        await fsApi.promises.unlink(target).catch(() => {});
        return false;
      }
    }
    return false;
  }

  async function quarantineJournal() {
    return enqueueJournalOp(() => quarantineJournalLocked());
  }

  async function removeJournalStrict() {
    return enqueueJournalOp(async () => {
      try {
        await fsApi.promises.unlink(leaseJournalFile);
        return true;
      } catch (err) {
        return Boolean(err && err.code === "ENOENT");
      }
    });
  }

  return {
    readPreferences,
    writePreferences,
    writeJournal,
    removeJournal,
    readLeaseJournalRecord,
    quarantineJournal,
    removeJournalStrict,
  };
}

module.exports = { createJournal };
