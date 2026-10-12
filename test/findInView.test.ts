/**
 * Find-in-thread / find-in-diffs matching (#1524).
 * Run: npm run test:renderer -- --test-name-pattern="findInView|find in"
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findDiffHits,
  findSurfaceForEvent,
  findTranscriptHits,
  stepIndex,
} from "../src/findInView";
import { setKeybindingOverrides } from "../src/uiPrefs";
import { setMacPlatformForTests } from "../src/keybindings";

describe("findInView", () => {
  it("finds messages, tool summaries, and the plan card", () => {
    const hits = findTranscriptHits(
      {
        messages: [
          { id: "u1", role: "user", text: "please fix the login timeout" },
          { id: "t1", role: "tool", text: "Bash: npm test" },
          { id: "a1", role: "assistant", text: "I bumped the login timeout." },
        ],
        plan: "Harden the auth session",
        planSteps: [{ step: "Raise the login timeout" }, { step: "Add a test" }],
      },
      "timeout",
    );
    assert.deepEqual(
      hits.map((h) => `${h.kind}:${h.id}`),
      ["plan:plan", "message:u1", "message:a1"],
    );
    assert.deepEqual(
      findTranscriptHits(
        {
          messages: [{ id: "t1", role: "tool", text: "Bash: npm test" }],
          plan: null,
          planSteps: [],
        },
        "npm test",
      ),
      [{ kind: "message", id: "t1" }],
    );
  });

  it("is case-insensitive and ignores blank queries", () => {
    const src = {
      messages: [{ id: "m1", role: "user", text: "Alpha Bravo" }],
      plan: null,
      planSteps: [],
    };
    assert.deepEqual(findTranscriptHits(src, "bravo"), [{ kind: "message", id: "m1" }]);
    assert.deepEqual(findTranscriptHits(src, "   "), []);
    assert.deepEqual(findTranscriptHits(src, ""), []);
  });

  it("finds loaded patches and file paths", () => {
    const files = [{ path: "src/a.ts" }, { path: "notes.txt" }];
    const patches = [
      { path: "src/a.ts", text: "-old\n+new timeout" },
      { path: "notes.txt", text: "+hello" },
    ];
    assert.deepEqual(
      findDiffHits(files, patches, "timeout").map((h) => h.path),
      ["src/a.ts"],
    );
    assert.deepEqual(
      findDiffHits(files, patches, "notes").map((h) => h.path),
      ["notes.txt"],
    );
    assert.deepEqual(
      findDiffHits(files, [{ path: "src/a.ts", text: "-old\n+new" }], "hello"),
      [],
      "unloaded notes.txt patch is not searched",
    );
    assert.deepEqual(
      findDiffHits(files, [{ path: "src/a.ts", text: "-old\n+new" }], "notes").map(
        (h) => h.path,
      ),
      ["notes.txt"],
      "a path match still counts when the patch is not loaded",
    );
  });

  it("steps through matches and wraps", () => {
    assert.equal(stepIndex(0, 3, 1), 1);
    assert.equal(stepIndex(2, 3, 1), 0);
    assert.equal(stepIndex(0, 3, -1), 2);
    assert.equal(stepIndex(0, 0, 1), 0);
  });

  it("routes a shared ⌘F to the surface under the cursor", () => {
    setMacPlatformForTests(true);
    setKeybindingOverrides({});
    const git = {
      closest: (sel: string) => (sel.includes("data-git-pane") ? git : null),
    };
    const e = (target: unknown) => ({
      key: "f",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      target,
    });
    assert.equal(findSurfaceForEvent(e(null)), "transcript");
    assert.equal(findSurfaceForEvent(e(git)), "diff");
    setKeybindingOverrides({ "transcript.find": "mod+g" });
    assert.equal(
      findSurfaceForEvent({
        key: "g",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        target: git,
      }),
      "transcript",
      "a remapped transcript chord wins even inside a diff",
    );
    setKeybindingOverrides({});
    setMacPlatformForTests(null);
  });
});
