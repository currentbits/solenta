/**
 * Test files and test support (#1745): what the diff views' "Hide tests"
 * toggle drops, and what the review itinerary files under "tests".
 */
const TEST_DIR = /(^|\/)(test|tests|__tests__|__mocks__|fixtures|testdata)\//;
const TEST_NAME = /(^|\/)([^/]+\.(test|spec)\.[^/]+|[^/]+_test\.go|test_[^/]+\.py)$/;

export function isTestFile(path: string): boolean {
  const n = path.replace(/\\/g, "/").toLowerCase();
  return TEST_DIR.test(n) || TEST_NAME.test(n);
}
