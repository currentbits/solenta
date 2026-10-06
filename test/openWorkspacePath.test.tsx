/**
 * Path links open in the "Open in" editor picked in Thread details, at the
 * linked line (#1506); without a pick they keep using the default app.
 *
 * Run: node --import=./test/support/render.mjs --test test/openWorkspacePath.test.tsx
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { useRef } from "react";
import { mount, unmountAll } from "./support/dom.ts";
import { createFakeCoder, type FakeCoder } from "./support/fakeCoder";
import { useCoderWorkspace } from "../src/coder/useCoderWorkspace";
import { EDITOR_PREF_KEY } from "../src/shared/ipc";

type Open = ReturnType<typeof useCoderWorkspace>["openWorkspacePath"];

async function hook(fake: FakeCoder): Promise<Open> {
  let open: Open | null = null;
  function Harness() {
    const selectedRef = useRef<string | null>("t1");
    const stagedPathsRef = useRef<string[] | null>(null);
    open = useCoderWorkspace({
      api: fake.api,
      selectedThreadId: "t1",
      setDetail: () => {},
      selectedRef,
      stagedPathsRef,
      applyThreadUpdate: () => {},
    }).openWorkspacePath;
    return null;
  }
  await mount(<Harness />);
  return open!;
}

describe("openWorkspacePath editor routing (#1506)", () => {
  afterEach(() => {
    window.localStorage.removeItem(EDITOR_PREF_KEY);
    unmountAll();
  });

  it("opens in the picked editor at line/col", async () => {
    const fake = createFakeCoder();
    const open = await hook(fake);
    window.localStorage.setItem(EDITOR_PREF_KEY, "webstorm");
    await open("/wt/src/a.ts", { line: 12, col: 3 });
    assert.deepEqual(fake.only("shell.openIn").args[0], {
      threadId: "t1",
      path: "/wt/src/a.ts",
      editor: "webstorm",
      line: 12,
      column: 3,
    });
    assert.equal(fake.of("shell.openPath").length, 0);
  });

  it("uses the default app with no pick, Finder or Terminal", async () => {
    for (const pref of [null, "finder", "terminal"]) {
      const fake = createFakeCoder();
      const open = await hook(fake);
      if (pref) window.localStorage.setItem(EDITOR_PREF_KEY, pref);
      await open("/wt/src/a.ts", { line: 12 });
      assert.equal(fake.of("shell.openIn").length, 0, String(pref));
      assert.equal(fake.of("shell.openPath").length, 1, String(pref));
      unmountAll();
    }
  });

  it("falls back to the default app when the editor fails", async () => {
    const fake = createFakeCoder();
    fake.api.shell.openIn = async () => {
      throw new Error("spawn zed ENOENT");
    };
    const open = await hook(fake);
    window.localStorage.setItem(EDITOR_PREF_KEY, "zed");
    await open("/wt/src/a.ts");
    assert.equal(fake.of("shell.openPath").length, 1);
  });
});
