/**
 * OTLP header textarea parse/format.
 * Run: npm run test:renderer -- test/otelHeaders.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatOtelHeaders,
  parseOtelHeaders,
} from "../src/components/SettingsModal";

describe("parseOtelHeaders", () => {
  it("reads one key: value per line and skips blanks", () => {
    assert.deepEqual(
      parseOtelHeaders("Authorization: Bearer secret\n\nx-foo: bar\n"),
      { Authorization: "Bearer secret", "x-foo": "bar" },
    );
  });

  it("skips lines without a key before the colon", () => {
    assert.deepEqual(parseOtelHeaders("no-colon\n: missing-key\n ok : yes "), {
      ok: "yes",
    });
  });
});

describe("formatOtelHeaders", () => {
  it("round-trips a parsed block", () => {
    const text = "Authorization: Bearer secret\nx-foo: bar";
    assert.equal(formatOtelHeaders(parseOtelHeaders(text)), text);
  });
});
