/**
 * Add project: typed/browsable destination (#609). The path input is the
 * browse cursor: it seeds with ~/, lists directories via fs.browse, arrow
 * keys descend, and submitting a path that is already a project opens it.
 *
 * Run: node --import=./test/support/render.mjs --test test/addProjectBrowse.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import {
  createFakeCoder,
  installFakeCoder,
  project,
} from "./support/fakeCoder.ts";
import App from "../src/App";
import type { FsBrowseResult } from "../src/shared/ipc";

async function boot(fake: ReturnType<typeof createFakeCoder>) {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  return mount(<App />);
}

async function waitForBrowse(m: Awaited<ReturnType<typeof mount>>) {
  const start = Date.now();
  while (Date.now() - start < 800) {
    if (m.query("[data-browse-entry]")) return;
    await m.flush();
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("Add project: typed browse (#609)", () => {
  it("seeds the path with ~/ and lists directories from fs.browse", async () => {
    const fake = createFakeCoder({
      projects: [],
      threads: [],
      browse: () =>
        ({
          parentPath: "/Users/demo/",
          existed: true,
          entries: [
            { name: "Code", fullPath: "/Users/demo/Code" },
            { name: "Projects", fullPath: "/Users/demo/Projects" },
          ],
        }) satisfies FsBrowseResult,
    });
    const m = await boot(fake);

    await m.click(m.byText("Add project"));
    const input = m.query("[data-add-project-path-input]") as HTMLInputElement | null;
    assert.ok(input, "path input must be on screen");
    assert.equal(input.value, "~/");

    await waitForBrowse(m);
    assert.ok(
      fake.of("fs.browse").length > 0,
      "opening the modal must list the seeded path",
    );
    assert.ok(m.query('[data-browse-entry="Code"]'), "Code must be listed");
    assert.ok(
      m.query('[data-browse-entry="Projects"]'),
      "Projects must be listed",
    );
    m.unmount();
  });

  it("descends into a listed directory on click", async () => {
    const fake = createFakeCoder({
      projects: [],
      threads: [],
      browse: (input) => {
        const path = String((input as { path?: string }).path || "");
        if (path.includes("Code")) {
          return {
            parentPath: "/Users/demo/Code/",
            existed: true,
            entries: [{ name: "solenta", fullPath: "/Users/demo/Code/solenta" }],
          };
        }
        return {
          parentPath: "/Users/demo/",
          existed: true,
          entries: [{ name: "Code", fullPath: "/Users/demo/Code" }],
        };
      },
    });
    const m = await boot(fake);
    await m.click(m.byText("Add project"));
    await waitForBrowse(m);
    await m.click(m.query('[data-browse-entry="Code"]'));
    const input = m.query("[data-add-project-path-input]") as HTMLInputElement | null;
    assert.ok(input);
    assert.equal(input.value, "~/Code/");
    const start = Date.now();
    while (Date.now() - start < 800 && !m.query('[data-browse-entry="solenta"]')) {
      await m.flush();
    }
    assert.ok(
      m.query('[data-browse-entry="solenta"]'),
      "descending must list the child folder",
    );
    m.unmount();
  });

  it("keeps Browse as a local shortcut to pickDirectory", async () => {
    const fake = createFakeCoder({ projects: [], threads: [] });
    const m = await boot(fake);
    await m.click(m.byText("Add project"));
    const browse = m.query("[data-add-project-browse-path]");
    assert.ok(browse, "native modal must keep Browse…");
    await m.click(browse);
    assert.ok(
      fake.of("projects.pickDirectory").length > 0,
      "Browse must still call projects.pickDirectory",
    );
    m.unmount();
  });

  it("opens an already-added project instead of erroring", async () => {
    const existing = project({
      id: "p-existing",
      path: "/Users/demo/Code",
      name: "Code",
      slug: "Code",
    });
    const fake = createFakeCoder({
      projects: [existing],
      threads: [],
    });
    const m = await boot(fake);
    await m.click(m.query('[aria-label="Add project"]'));
    assert.ok(m.query("[data-add-project-path]"), "add-project modal must open");
    await m.type(m.query("[data-add-project-path-input]"), "/Users/demo/Code");
    await m.click(m.query("[data-add-project-path-submit]"));
    const adds = fake.of("projects.add");
    assert.equal(adds.length, 1);
    assert.equal(adds[0].args[0], "/Users/demo/Code");
    assert.equal(
      m.query("[data-add-project-path]"),
      null,
      "modal must close when the path is already a project",
    );
    m.unmount();
  });
});
