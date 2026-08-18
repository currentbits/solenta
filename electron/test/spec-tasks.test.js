/**
 * Issue #537: parse tasks.md into a dispatch DAG.
 * Run: npm run test:electron
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { parseTasksMd, taskWaves, normalizeTaskId } = require("../specTasks.js");

describe("normalizeTaskId", () => {
  it("treats T1, t1, #1, and 1 as the same id", () => {
    assert.equal(normalizeTaskId("T1"), "1");
    assert.equal(normalizeTaskId("t1"), "1");
    assert.equal(normalizeTaskId("#1"), "1");
    assert.equal(normalizeTaskId("1"), "1");
    assert.equal(normalizeTaskId("  12 "), "12");
    assert.equal(normalizeTaskId("api"), "");
  });
});

describe("parseTasksMd", () => {
  it("returns an empty graph for blank or prose-only input", () => {
    assert.deepEqual(parseTasksMd("").tasks, []);
    assert.deepEqual(parseTasksMd("# Tasks\n\nJust a paragraph.\n").tasks, []);
    assert.deepEqual(parseTasksMd(null).tasks, []);
  });

  it("assigns 1-based ids in document order when none are written", () => {
    const { tasks, errors, waves } = parseTasksMd(
      "- [ ] Parse the config (`src/config.ts`) — req 1\n" +
        "- [ ] Wire the IPC (`electron/ipc.js`) — req 2\n",
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(
      tasks.map((t) => [t.id, t.title, t.done, t.needs]),
      [
        ["1", "Parse the config (`src/config.ts`) — req 1", false, []],
        ["2", "Wire the IPC (`electron/ipc.js`) — req 2", false, []],
      ],
    );
    assert.deepEqual(waves, [["1", "2"]]);
  });

  it("keeps explicit 1. / T1: / #1 ids and parses needs:", () => {
    const { tasks, errors, waves } = parseTasksMd(
      "# Tasks\n" +
        "- [ ] 1. Parse (`src/a.ts`) — req 1\n" +
        "- [ ] T2: Wire (`electron/b.js`) — req 2 — needs: 1\n" +
        "- [x] #3) Tests (`test/a.test.js`) needs: 1, T2\n" +
        "\n" +
        "A note that is not a task.\n" +
        "* [ ] 4. UI (`src/c.tsx`) — req 3 — needs: 2, 3\n",
    );
    assert.deepEqual(errors, []);
    assert.equal(tasks.length, 4);
    assert.deepEqual(
      tasks.map((t) => [t.id, t.done, t.needs]),
      [
        ["1", false, []],
        ["2", false, ["1"]],
        ["3", true, ["1", "2"]],
        ["4", false, ["2", "3"]],
      ],
    );
    assert.match(tasks[1].title, /^T2: Wire/);
    assert.match(tasks[3].title, /^4\. UI/);
    // 3 is done, so 4 only waits on 2. Wave 1 is just 1; then 2; then 4.
    assert.deepEqual(waves, [["1"], ["2"], ["4"]]);
  });

  it("accepts CRLF and + checkboxes", () => {
    const { tasks, errors } = parseTasksMd("+ [ ] 1. One\r\n+ [x] 2. Two\r\n");
    assert.deepEqual(errors, []);
    assert.equal(tasks.length, 2);
    assert.equal(tasks[1].done, true);
  });

  it("reports unknown needs, self-needs, invalid ids, duplicates, empty titles", () => {
    const { errors } = parseTasksMd(
      "- [ ] 1. First — needs: 9\n" +
        "- [ ] 1. Duplicate\n" +
        "- [ ] 2. Loop — needs: 2\n" +
        "- [ ]   \n" +
        "- [ ] 3. Bad — needs: api\n",
    );
    assert.ok(errors.some((e) => /unknown task "9"/.test(e)), errors.join("; "));
    assert.ok(errors.some((e) => /duplicate task id 1/.test(e)), errors.join("; "));
    assert.ok(errors.some((e) => /cannot need itself/.test(e)), errors.join("; "));
    assert.ok(errors.some((e) => /empty task title/.test(e)), errors.join("; "));
    assert.ok(errors.some((e) => /invalid dependency id "api"/.test(e)), errors.join("; "));
  });

  it("reports a dependency cycle", () => {
    const { errors, waves } = parseTasksMd(
      "- [ ] 1. A — needs: 2\n" +
        "- [ ] 2. B — needs: 1\n",
    );
    assert.ok(errors.some((e) => /cycle/.test(e)), errors.join("; "));
    assert.deepEqual(waves, []);
  });

  it("fills implicit ids around explicit ones without colliding", () => {
    const { tasks, errors } = parseTasksMd(
      "- [ ] 2. Second\n" +
        "- [ ] First\n",
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(
      tasks.map((t) => t.id),
      ["2", "1"],
    );
  });
});

describe("taskWaves", () => {
  it("puts a diamond into three waves", () => {
    const { waves, cycle } = taskWaves([
      { id: "1", needs: [] },
      { id: "2", needs: ["1"] },
      { id: "3", needs: ["1"] },
      { id: "4", needs: ["2", "3"] },
    ]);
    assert.equal(cycle, null);
    assert.deepEqual(waves, [["1"], ["2", "3"], ["4"]]);
  });

  it("skips done tasks when computing the next wave", () => {
    const { waves, cycle } = taskWaves([
      { id: "1", needs: [], done: true },
      { id: "2", needs: ["1"] },
      { id: "3", needs: ["2"], status: "done" },
    ]);
    assert.equal(cycle, null);
    assert.deepEqual(waves, [["2"]]);
  });
});
