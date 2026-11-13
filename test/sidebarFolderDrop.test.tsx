/**
 * Dropping folders from the OS onto the sidebar thread list adds each as a
 * project through projects.add; dropped files are ignored with a notice.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inAct, mount } from "./support/dom.ts";
import {
  createFakeCoder,
  installFakeCoder,
  project,
  type FakeCoder,
} from "./support/fakeCoder.ts";
import App from "../src/App";

function osDrag(type: string, entries: { name: string; dir: boolean }[]) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  const items = entries.map(({ name, dir }) => {
    const file = new File([], name);
    return {
      kind: "file" as const,
      type: "",
      getAsFile: () => file,
      webkitGetAsEntry: () => ({ isDirectory: dir, isFile: !dir, name }),
    };
  });
  Object.defineProperty(ev, "dataTransfer", {
    value: { files: [], items, types: ["Files"], dropEffect: "none" },
  });
  return ev;
}

async function boot(fake: FakeCoder) {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  const m = await mount(<App />);
  await m.flush();
  return m;
}

describe("sidebar folder drop", () => {
  it("adds each dropped folder as a project and notes ignored files", async () => {
    const fake = createFakeCoder({
      projects: [project({ id: "p1", path: "/repos/existing" })],
      droppedFilePath: (f: File) => `/repos/${f.name}`,
    });
    const m = await boot(fake);
    try {
      const list = m.query("[data-sidebar-list]")!;
      assert.ok(list);
      await inAct(() => {
        list.dispatchEvent(osDrag("dragover", [{ name: "x", dir: true }]));
      });
      assert.equal(list.getAttribute("data-folder-drop"), "true", "highlight while dragging");

      await inAct(() => {
        list.dispatchEvent(
          osDrag("drop", [
            { name: "alpha", dir: true },
            { name: "notes.md", dir: false },
            { name: "existing", dir: true },
          ]),
        );
      });
      await m.flush();
      assert.equal(list.getAttribute("data-folder-drop"), null, "highlight cleared on drop");
      assert.deepEqual(
        fake.of("projects.add").map((c) => c.args[0]),
        ["/repos/alpha", "/repos/existing"],
      );
      assert.match(
        document.querySelector('[data-toast="error"]')?.textContent ?? "",
        /Ignored 1 file: drop folders to add projects/,
      );
    } finally {
      m.unmount();
    }
  });

  it("has no drop target without a dropped-path bridge (web mode)", async () => {
    const fake = createFakeCoder({ projects: [project({ id: "p1" })] });
    const m = await boot(fake);
    try {
      const list = m.query("[data-sidebar-list]")!;
      const ev = osDrag("dragover", [{ name: "x", dir: true }]);
      await inAct(() => {
        list.dispatchEvent(ev);
      });
      assert.equal(ev.defaultPrevented, false);
      assert.equal(list.getAttribute("data-folder-drop"), null);
    } finally {
      m.unmount();
    }
  });
});
