/**
 * Windows doctor (#435): after a successful add, failed checks stay in
 * the add-project modal as a short list. Continue dismisses it. The
 * project is already added — the doctor is advisory.
 *
 * Run: node --import=./test/support/render.mjs --test test/windowsDoctor.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { createFakeCoder, installFakeCoder } from "./support/fakeCoder.ts";
import App from "../src/App";
import type { ProjectInfo } from "../src/shared/ipc";

describe("Windows doctor on project add", () => {
  it("keeps the modal open with the failed checks and closes on Continue", async () => {
    const fake = createFakeCoder({ projects: [], threads: [] });
    const origAdd = fake.api.projects.add.bind(fake.api.projects);
    fake.api.projects.add = async (path, opts) => {
      const added = await origAdd(path, opts);
      const withDoctor: ProjectInfo = {
        ...added,
        windowsDoctor: {
          checks: [
            {
              id: "longpaths",
              ok: false,
              message: "Git long paths are off",
              fix: "Run: git config --global core.longpaths true",
            },
            {
              id: "gitBash",
              ok: false,
              message: "No POSIX shell (Git Bash) on PATH",
              fix: "Install Git for Windows and keep Git Bash on PATH",
            },
            { id: "node22", ok: true, message: "Node 22 is available" },
            { id: "wslBoundary", ok: true, message: "Repo is on a Windows drive" },
          ],
        },
      };
      return withDoctor;
    };

    const shell = await mount(<div />);
    installFakeCoder(fake);
    shell.unmount();
    const m = await mount(<App />);

    await m.click(m.byText("Add project"));
    await m.type(m.query("[data-add-project-path-input]"), "C:\\\\repo");
    await m.click(m.query("[data-add-project-path-submit]"));

    assert.equal(fake.of("projects.add").length, 1, "add must still run");
    const list = m.query("[data-windows-doctor]");
    assert.ok(list, "failed checks must stay on the add modal");
    const longpaths = m.query('[data-windows-doctor-check="longpaths"]');
    assert.ok(longpaths);
    assert.match(longpaths.textContent || "", /Git long paths are off/);
    assert.match(list.textContent || "", /core\.longpaths true/);
    assert.ok(m.query('[data-windows-doctor-check="gitBash"]'));
    assert.equal(
      m.query('[data-windows-doctor-check="node22"]'),
      null,
      "green checks stay off the list",
    );

    await m.click(m.query("[data-windows-doctor-continue]"));
    assert.equal(
      m.query("[data-add-project-path]"),
      null,
      "Continue must close the modal",
    );
    m.unmount();
  });

  it("still closes the modal when the doctor reports nothing wrong", async () => {
    const fake = createFakeCoder({ projects: [], threads: [] });
    const shell = await mount(<div />);
    installFakeCoder(fake);
    shell.unmount();
    const m = await mount(<App />);

    await m.click(m.byText("Add project"));
    await m.type(m.query("[data-add-project-path-input]"), "/Users/demo/clean-repo");
    await m.click(m.query("[data-add-project-path-submit]"));

    assert.equal(m.query("[data-windows-doctor]"), null);
    assert.equal(
      m.query("[data-add-project-path]"),
      null,
      "clean add must still close the modal",
    );
    m.unmount();
  });
});
