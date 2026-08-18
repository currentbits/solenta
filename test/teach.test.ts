import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  teachAllowedPermissionModes,
  teachAutonomyFor,
  teachPermissionAllowed,
} from "../src/teach";
import { TEACH_REVIEW_THRESHOLDS } from "../src/shared/ipc";

describe("teach helpers", () => {
  it("promotes autonomy at the same thresholds as the backend", () => {
    assert.equal(teachAutonomyFor(0), "hint");
    assert.equal(teachAutonomyFor(TEACH_REVIEW_THRESHOLDS.review), "review");
    assert.equal(teachAutonomyFor(TEACH_REVIEW_THRESHOLDS.pair), "pair");
  });

  it("caps permission modes until pair", () => {
    assert.deepEqual(teachAllowedPermissionModes("hint"), ["default", "plan"]);
    assert.ok(teachAllowedPermissionModes("review").includes("acceptEdits"));
    assert.equal(
      teachPermissionAllowed("bypassPermissions", {
        autonomy: "review",
        reviewsPassed: 3,
      }),
      false,
    );
    assert.equal(
      teachPermissionAllowed("bypassPermissions", {
        autonomy: "pair",
        reviewsPassed: 8,
      }),
      true,
    );
    assert.equal(teachPermissionAllowed("bypassPermissions", null), true);
  });
});
