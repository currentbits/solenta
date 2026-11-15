import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { useState } from "react";
import { PathBrowser } from "../src/components/PathBrowser";
import type { FsBrowseInput, FsBrowseResult } from "../src/shared/ipc";
import { mount, unmountAll } from "./support/dom.ts";

afterEach(unmountAll);

const browse = async ({ path, environment }: FsBrowseInput): Promise<FsBrowseResult> => {
  if (environment === "other") throw "Permission denied";
  if (path === "/root/bad/") throw new Error("Permission denied");
  return { parentPath: "/root/", entries: [
    { name: "bad", fullPath: "/root/bad" },
    { name: "good", fullPath: "/root/good" },
  ] };
};

function Picker({ environment = "host", onBrowse = browse }: { environment?: string; onBrowse?: typeof browse }) {
  const [value, onChange] = useState("/root/");
  return <PathBrowser id="path" value={value} onChange={onChange} onBrowse={onBrowse} environment={environment} inputDataAttr="data-path" />;
}

it("keeps readable siblings and Up usable after a child folder fails", async () => {
  const m = await mount(<Picker />);
  await m.flush();
  await m.click(m.query('[data-browse-entry="bad"]'));
  await m.flush();
  assert.match(m.text(), /Permission denied/);
  assert.match(m.text(), /Showing \/root\//);
  assert.ok(m.query('[data-browse-up]'));
  assert.ok(m.query('[data-browse-entry="good"]'));
  await m.click(m.query('[data-browse-entry="good"]'));
  await m.flush();
  assert.equal(m.query('input')?.getAttribute('value'), "/root/good/");
  assert.doesNotMatch(m.text(), /Permission denied/);
});

it("never reuses a previous host's readable folders after a host switch", async () => {
  const m = await mount(<Picker />);
  await m.flush();
  assert.ok(m.query('[data-browse-entry="good"]'));
  await m.rerender(<Picker environment="other" />);
  await m.flush();
  assert.match(m.text(), /Permission denied/);
  assert.equal(m.query('[data-browse-entry="good"]'), null);
  assert.doesNotMatch(m.text(), /Showing/);
});

it("clears the readable listing when the browse connection changes with the same environment and cwd", async () => {
  const m = await mount(<Picker />);
  await m.flush();
  assert.ok(m.query('[data-browse-entry="good"]'));
  await m.rerender(<Picker onBrowse={async () => { throw new Error("New computer is offline"); }} />);
  await m.flush();
  assert.match(m.text(), /New computer is offline/);
  assert.equal(m.query('[data-browse-entry="good"]'), null);
  assert.doesNotMatch(m.text(), /Showing/);
});
