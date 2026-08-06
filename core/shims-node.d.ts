/** Minimal ambient types so we stay typescript-only (no @types/node). */

declare module "node:assert/strict" {
  interface AssertStrict {
    equal(actual: unknown, expected: unknown, message?: string | Error): void;
    notEqual(actual: unknown, expected: unknown, message?: string | Error): void;
    deepEqual(
      actual: unknown,
      expected: unknown,
      message?: string | Error,
    ): void;
    ok(value: unknown, message?: string | Error): void;
    throws(
      fn: () => unknown,
      error?: unknown,
      message?: string | Error,
    ): void;
  }
  const assert: AssertStrict;
  export default assert;
}

declare module "node:test" {
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void): void;
}
