"use strict";

// Pinned before any Date use: DST cases below are Amsterdam's 2026 switches
// (Mar 29 02:00 -> 03:00, Oct 25 03:00 -> 02:00).
process.env.TZ = "Europe/Amsterdam";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { parseCron, nextCronFire, nextCronFires } = require("../cron.js");
const { nextFire } = require("../automations.js");
const { parseAutomations, mergeAutomations } = require("../automations-file.js");
const { migrateAutomation } = require("../store-migrate.js");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createToolHandlers } = require("../orchServer.js");

const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const stamp = (t) => {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} ${-d.getTimezoneOffset() / 60}`;
};
const fires = (expr, from, n = 3) => nextCronFires(expr, from, n).map(stamp);

describe("parseCron", () => {
  it("expands *, lists, ranges, steps and names", () => {
    const p = parseCron("*/15 9-17/4 1,15 jan-MAR mon-fri");
    assert.deepEqual(p.minutes, [0, 15, 30, 45]);
    assert.deepEqual(p.hours, [9, 13, 17]);
    assert.deepEqual([...p.days], [1, 15]);
    assert.deepEqual([...p.months], [1, 2, 3]);
    assert.deepEqual([...p.weekdays], [1, 2, 3, 4, 5]);
    assert.equal(p.domStar, false);
    assert.equal(p.dowStar, false);
    // "a/step" runs a..max; 7 is Sunday.
    assert.deepEqual(parseCron("5/20 0 * * 7").minutes, [5, 25, 45]);
    assert.deepEqual([...parseCron("0 0 * * 7").weekdays], [0]);
  });

  it("rejects bad fields with a readable message", () => {
    const bad = {
      "0 0 * *": /Cron needs 5 fields .* got 4/,
      "60 * * * *": /minute must be 0-59 \(got "60"\)/,
      "0 24 * * *": /hour must be 0-23/,
      "0 0 0 * *": /day-of-month must be 1-31/,
      "0 0 * 13 *": /month must be 1-12 or jan-dec/,
      "0 0 * * 8": /day-of-week must be 0-7 or sun-sat/,
      "0 0 * * funday": /day-of-week must be 0-7 or sun-sat \(got "funday"\)/,
      "0 0 * * 5-1": /day-of-week range "5-1" runs backwards/,
      "*/0 0 * * *": /minute step must be a positive number/,
      "0,,5 0 * * *": /minute has an empty list item/,
      "0 1- * * *": /hour has a malformed range/,
      "0 0 31 feb *": /never fires/,
    };
    for (const [expr, re] of Object.entries(bad)) {
      assert.throws(() => parseCron(expr), re, expr);
    }
  });

  it("rejects anything firing more often than every 5 minutes", () => {
    assert.throws(() => parseCron("* * * * *"), /fires every 1 minute; automations can run at most every 5 minutes/);
    assert.throws(() => parseCron("*/4 * * * *"), /every 4 minutes/);
    assert.throws(() => parseCron("0,3 9 * * *"), /every 3 minutes/);
    // 58 then 00 of the next hour is 2 minutes apart.
    assert.throws(() => parseCron("58,0 9,10 * * *"), /every 2 minutes/);
    for (const ok of ["*/5 * * * *", "55,0 * * * *", "58,0 9,11 * * *", "0 * * * *"]) {
      assert.doesNotThrow(() => parseCron(ok), ok);
    }
  });
});

describe("nextCronFire", () => {
  it("rolls over month and year ends", () => {
    assert.deepEqual(fires("0 0 1 * *", local(2026, 12, 15)), [
      "2027-01-01 00:00 1",
      "2027-02-01 00:00 1",
      "2027-03-01 00:00 1",
    ]);
    assert.deepEqual(fires("30 23 31 * *", local(2026, 4, 1), 2), [
      "2026-05-31 23:30 2",
      "2026-07-31 23:30 2",
    ]);
    assert.deepEqual(fires("0 0 29 feb *", local(2026, 1, 1), 2), [
      "2028-02-29 00:00 1",
      "2032-02-29 00:00 1",
    ]);
  });

  it("weekdays only skips the weekend", () => {
    // Fri 2026-10-30 10:00: today's 9:00 is gone, Sat/Sun skipped.
    assert.deepEqual(fires("0 9 * * 1-5", local(2026, 10, 30, 10)), [
      "2026-11-02 09:00 1",
      "2026-11-03 09:00 1",
      "2026-11-04 09:00 1",
    ]);
  });

  it("restricted day-of-month and day-of-week match either (OR)", () => {
    // 13th or any Friday, Jan 2026: Fri 2, Fri 9, Tue 13, Fri 16.
    assert.deepEqual(fires("0 0 13 * fri", local(2026, 1, 1), 4), [
      "2026-01-02 00:00 1",
      "2026-01-09 00:00 1",
      "2026-01-13 00:00 1",
      "2026-01-16 00:00 1",
    ]);
    // A "*"-led day field keeps AND: every Friday that is also odd-dated.
    assert.deepEqual(fires("0 0 */2 * fri", local(2026, 1, 1), 2), [
      "2026-01-09 00:00 1",
      "2026-01-23 00:00 1",
    ]);
  });

  it("is strictly after fromMs", () => {
    assert.equal(stamp(nextCronFire("0 9 * * *", local(2026, 6, 1, 9))), "2026-06-02 09:00 2");
  });

  it("spring-forward: a skipped time fires once at the first valid minute", () => {
    assert.deepEqual(fires("30 2 * * *", local(2026, 3, 28, 12)), [
      "2026-03-29 03:00 2",
      "2026-03-30 02:30 2",
      "2026-03-31 02:30 2",
    ]);
    // Every skipped slot collapses onto 03:00, which fires once.
    assert.deepEqual(fires("*/15 2 * * *", local(2026, 3, 29), 2), [
      "2026-03-29 03:00 2",
      "2026-03-30 02:00 2",
    ]);
  });

  it("fall-back: the repeated hour does not double-fire", () => {
    assert.deepEqual(fires("30 2 * * *", local(2026, 10, 24, 12)), [
      "2026-10-25 02:30 2",
      "2026-10-26 02:30 1",
      "2026-10-27 02:30 1",
    ]);
    const half = nextCronFires("*/30 * * * *", local(2026, 10, 25, 1), 5);
    assert.deepEqual(half.map(stamp), [
      "2026-10-25 01:30 2",
      "2026-10-25 02:00 2",
      "2026-10-25 02:30 2",
      "2026-10-25 03:00 1",
      "2026-10-25 03:30 1",
    ]);
    // 02:30 CEST -> 03:00 CET is 90 real minutes: the CET 02:xx pass is skipped.
    assert.equal(half[3] - half[2], 90 * 60_000);
  });

  it("nextFire routes preset cron to the expression", () => {
    assert.equal(
      stamp(nextFire("cron", null, local(2026, 10, 30, 10), null, "0 9 * * 1-5")),
      "2026-11-02 09:00 1",
    );
    assert.throws(() => nextFire("cron", null, Date.now(), null, "nope"), /5 fields/);
  });
});

describe("cron automations round trip", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "coder-cron-"));

  it("private: create, persist, reload, switch back to a preset", () => {
    const dir = tmp();
    try {
      const file = path.join(dir, "store.json");
      const store = new Store(file);
      store.setProjects([{ id: "p1", name: "p", path: dir }]);
      const created = services.addAutomation(store, {
        projectId: "p1",
        name: "Weekday standup",
        prompt: "Summarize yesterday",
        provider: "claude",
        preset: "cron",
        cron: "  0 9  * * mon-fri ",
      });
      assert.equal(created.preset, "cron");
      assert.equal(created.cron, "0 9 * * mon-fri");
      assert.equal(created.hour, null);
      assert.equal(created.nextRunAt, nextCronFire("0 9 * * mon-fri", created.stageSince));
      store.saveNow();

      const reloaded = new Store(file).getAutomation(created.id);
      assert.equal(reloaded.preset, "cron");
      assert.equal(reloaded.cron, "0 9 * * mon-fri");

      const edited = services.updateAutomation(store, { id: created.id, cron: "30 7 * * *" });
      assert.equal(edited.cron, "30 7 * * *");
      assert.equal(new Date(edited.nextRunAt).getMinutes(), 30);

      const back = services.updateAutomation(store, { id: created.id, preset: "daily", hour: 8 });
      assert.equal(back.preset, "daily");
      assert.equal("cron" in back, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a bad or too-frequent expression on create", () => {
    const dir = tmp();
    try {
      const store = new Store(path.join(dir, "store.json"));
      store.setProjects([{ id: "p1", name: "p", path: dir }]);
      const base = { projectId: "p1", name: "x", prompt: "y", provider: "claude", preset: "cron" };
      assert.throws(() => services.addAutomation(store, base), /Cron expression is required/);
      assert.throws(() => services.addAutomation(store, { ...base, cron: "0 25 * * *" }), /hour must be 0-23/);
      assert.throws(() => services.addAutomation(store, { ...base, cron: "* * * * *" }), /at most every 5 minutes/);
      assert.equal(store.getAutomations().length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("project: writes cron to solenta.json and merges it back", () => {
    const dir = tmp();
    try {
      const store = new Store(path.join(dir, "store.json"));
      store.setProjects([{ id: "p1", name: "p", path: dir }]);
      services.addAutomation(store, {
        projectId: "p1",
        name: "Nightly sweep",
        prompt: "Sweep",
        provider: "claude",
        preset: "cron",
        cron: "15 2 * * 1-5",
        scope: "project",
      });
      const file = JSON.parse(fs.readFileSync(path.join(dir, "solenta.json"), "utf8"));
      assert.equal(file.automations[0].preset, "cron");
      assert.equal(file.automations[0].cron, "15 2 * * 1-5");
      const merged = mergeAutomations(store, Date.now()).find((a) => a.id === "shared:p1:nightly-sweep");
      assert.equal(merged.cron, "15 2 * * 1-5");
      assert.equal(new Date(merged.nextRunAt).getMinutes(), 15);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("solenta.json validation: cron rows, bad cron, stray cron; old rows keep their hash", () => {
    const row = {
      id: "nightly",
      name: "Nightly",
      prompt: "p",
      provider: "claude",
      model: null,
      preset: "daily",
      hour: 3,
      trigger: null,
      tier: null,
    };
    const before = parseAutomations({ automations: [row] });
    assert.equal(before.error, undefined);
    assert.equal(
      before.hash,
      require("node:crypto").createHash("sha256").update(JSON.stringify([row])).digest("hex"),
    );
    const cronRow = { ...row, preset: "cron", hour: null, cron: "0 3 * * 1-5" };
    assert.equal(parseAutomations({ automations: [cronRow] }).automations[0].cron, "0 3 * * 1-5");
    assert.match(
      parseAutomations({ automations: [{ ...cronRow, cron: "0 3 * *" }] }).error,
      /automations\[0\]\.cron: Cron needs 5 fields/,
    );
    assert.match(
      parseAutomations({ automations: [{ ...row, cron: "0 3 * * *" }] }).error,
      /cron needs preset "cron"/,
    );
  });

  it("store migration keeps a valid cron row and heals a broken one", () => {
    const ok = migrateAutomation({ id: "a", preset: "cron", cron: "0 9 * * 1-5", hour: 4 });
    assert.equal(ok.preset, "cron");
    assert.equal(ok.cron, "0 9 * * 1-5");
    assert.equal(ok.hour, null);
    assert.equal(migrateAutomation({ id: "b", preset: "cron", cron: "* * * * *" }).preset, "hourly");
  });

  it("automation_create accepts cron (preset implied) and rejects a bad one", async () => {
    const dir = tmp();
    try {
      const store = new Store(path.join(dir, "store.json"));
      store.setProjects([{ id: "p1", slug: "acme/app", name: "Alpha", path: dir }]);
      store.setThreads([{ id: "t1", projectId: "p1", title: "T", status: "idle", provider: "claude" }]);
      const h = createToolHandlers({
        store,
        runner: { startRun: async () => ({}) },
        forkThread: () => ({ id: "fork-1" }),
        getProvider: () => null,
      });
      const out = await h.automation_create({
        threadId: "t1",
        projectId: "p1",
        name: "Weekday digest",
        prompt: "digest",
        cron: "0 9 * * 1-5",
      });
      assert.equal(out.ok, true);
      assert.equal(out.preset, "cron");
      assert.equal(out.cron, "0 9 * * 1-5");
      assert.equal(out.hour, null);
      assert.equal(new Date(out.nextRunAt).getHours(), 9);
      await assert.rejects(
        h.automation_create({ threadId: "t1", projectId: "p1", name: "x", prompt: "y", preset: "cron", cron: "*/2 * * * *" }),
        /at most every 5 minutes/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("once automations file round trip (#1812)", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "coder-once-"));

  it("project: writes runAt to solenta.json and merges it back", () => {
    const dir = tmp();
    try {
      const store = new Store(path.join(dir, "store.json"));
      store.setProjects([{ id: "p1", name: "p", path: dir }]);
      const runAt = new Date(Date.now() + 86_400_000).toISOString();
      services.addAutomation(store, {
        projectId: "p1",
        name: "One-off sweep",
        prompt: "Sweep",
        provider: "claude",
        preset: "once",
        runAt,
        scope: "project",
      });
      const file = JSON.parse(fs.readFileSync(path.join(dir, "solenta.json"), "utf8"));
      assert.equal(file.automations[0].preset, "once");
      assert.equal(file.automations[0].runAt, runAt);
      assert.equal(file.automations[0].hour, null);
      const merged = mergeAutomations(store, Date.now()).find((a) => a.id === "shared:p1:one-off-sweep");
      assert.equal(merged.runAt, runAt);
      assert.equal(merged.nextRunAt, new Date(runAt).getTime());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("solenta.json validation: once rows, bad runAt, stray runAt; a fired row's past runAt still parses", () => {
    const row = {
      id: "nightly",
      name: "Nightly",
      prompt: "p",
      provider: "claude",
      model: null,
      preset: "daily",
      hour: 3,
      trigger: null,
      tier: null,
    };
    const onceRow = { ...row, preset: "once", hour: null, runAt: "2099-01-01T09:00" };
    assert.equal(parseAutomations({ automations: [onceRow] }).automations[0].runAt, "2099-01-01T09:00");
    // A long-fired row's runAt is legitimately in the past; parsing it must
    // not error the whole section out (electron/automations-file.js parseRow).
    assert.equal(
      parseAutomations({ automations: [{ ...onceRow, runAt: "2000-01-01T09:00" }] }).automations[0].runAt,
      "2000-01-01T09:00",
    );
    assert.match(
      parseAutomations({ automations: [{ ...onceRow, runAt: "not a date" }] }).error,
      /automations\[0\]\.runAt: runAt is not a valid date/,
    );
    assert.match(
      parseAutomations({ automations: [{ ...onceRow, runAt: "" }] }).error,
      /automations\[0\]\.runAt: runAt is required/,
    );
    assert.match(
      parseAutomations({ automations: [{ ...row, runAt: "2099-01-01T09:00" }] }).error,
      /runAt needs preset "once"/,
    );
  });

  it("store migration keeps a valid once row and heals a broken one", () => {
    const ok = migrateAutomation({ id: "a", preset: "once", runAt: "2099-01-01T09:00" });
    assert.equal(ok.preset, "once");
    assert.equal(ok.runAt, "2099-01-01T09:00");
    assert.equal(ok.hour, null);
    assert.equal(migrateAutomation({ id: "b", preset: "once", runAt: "not a date" }).preset, "hourly");
  });

  it("automation_create accepts runAt (preset implied) and rejects a past one", async () => {
    const dir = tmp();
    try {
      const store = new Store(path.join(dir, "store.json"));
      store.setProjects([{ id: "p1", slug: "acme/app", name: "Alpha", path: dir }]);
      store.setThreads([{ id: "t1", projectId: "p1", title: "T", status: "idle", provider: "claude" }]);
      const h = createToolHandlers({
        store,
        runner: { startRun: async () => ({}) },
        forkThread: () => ({ id: "fork-1" }),
        getProvider: () => null,
      });
      const runAt = new Date(Date.now() + 86_400_000).toISOString();
      const out = await h.automation_create({
        threadId: "t1",
        projectId: "p1",
        name: "Ping me",
        prompt: "ping",
        runAt,
      });
      assert.equal(out.ok, true);
      assert.equal(out.preset, "once");
      assert.equal(out.runAt, runAt);
      assert.equal(out.hour, null);
      await assert.rejects(
        h.automation_create({
          threadId: "t1",
          projectId: "p1",
          name: "x",
          prompt: "y",
          preset: "once",
          runAt: new Date(Date.now() - 1000).toISOString(),
        }),
        /future/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
