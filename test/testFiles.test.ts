/**
 * isTestFile (#1745). Run: node --experimental-strip-types --test test/testFiles.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isTestFile } from "../src/shared/testFiles.ts";

describe("isTestFile", () => {
  it("matches test names and test support dirs", () => {
    for (const p of [
      "src/a.test.ts",
      "src/a.spec.tsx",
      "pkg/server_test.go",
      "app/test_models.py",
      "test/support/dom.ts",
      "pkg/tests/x.rs",
      "src/__tests__/a.ts",
      "src/__mocks__/fs.ts",
      "spec/fixtures/user.json",
      "go/testdata/in.txt",
      "Src\\Tests\\A.cs",
    ]) {
      assert.equal(isTestFile(p), true, p);
    }
  });

  it("leaves ordinary files alone", () => {
    for (const p of [
      "src/latest.ts",
      "src/testing.ts",
      "src/contest/a.ts",
      "src/attest.py",
      "docs/test.md",
      "test",
      "src/protest_test.ts",
    ]) {
      assert.equal(isTestFile(p), false, p);
    }
  });
});
