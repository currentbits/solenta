import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { descriptionTasks, toggleDescriptionTask } from "../src/descriptionTasks.ts";

describe("description task source patches", () => {
  it("preserves every other byte including CRLF, nesting, list style and uppercase X", () => {
    const body = "Intro\r\n\r\n+ [ ] parent\r\n  1. [X] child\r\n\r\n```md\r\n- [ ] fake\r\n```\r\n";
    const tasks = descriptionTasks(body);
    assert.equal(tasks.length, 2);
    assert.equal(toggleDescriptionTask(body, body, tasks[1]), body.replace("[X]", "[ ]"));
    assert.equal(toggleDescriptionTask(body, body, tasks[0]), body.replace("+ [ ]", "+ [x]"));
  });
  it("uses the precise duplicate source position", () => {
    const body = "- [ ] same\n- [ ] same\n";
    assert.equal(toggleDescriptionTask(body, body, descriptionTasks(body)[1]), "- [ ] same\n- [x] same\n");
  });
  it("rebases an unchanged unique task while preserving unrelated server edits", () => {
    const body = "Header\n\n- [ ] task\n\nFooter";
    const latest = "New header\n\n- [ ] task\n\nNew footer\n";
    assert.equal(toggleDescriptionTask(body, latest, descriptionTasks(body)[0]), latest.replace("[ ]", "[x]"));
  });
  it("conflicts for ambiguous duplicates, removed/changed tasks and code-fence lookalikes", () => {
    const body = "- [ ] same\n- [ ] same\n";
    assert.throws(() => toggleDescriptionTask(body, "Intro\n" + body, descriptionTasks(body)[1]), /Reload/);
    const mixed = "- [ ] same\n* [X] same\n";
    assert.throws(() => toggleDescriptionTask(mixed, "- [X] same\n* [ ] same\n", descriptionTasks(mixed)[0]), /Reload/);
    const one = "- [ ] same";
    for (const latest of ["- [ ] different", "- [x] same", "```\n- [ ] same\n```", ""]) {
      assert.throws(() => toggleDescriptionTask(one, latest, descriptionTasks(one)[0]), /Reload/);
    }
    assert.throws(() => toggleDescriptionTask("```\n- [ ] fake\n```", "", { start: 4, end: 14 }), /Reload/);
  });
});
