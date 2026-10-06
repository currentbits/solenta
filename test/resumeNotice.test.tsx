/**
 * ResumeNotice: what was auto-resumed after a restart (issue #1512 I3).
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { mount } from "./support/dom";
import { ResumeNotice, resumedBatch } from "../src/components/ResumeNotice";
import type { ThreadInfo } from "../src/shared/ipc";

const t = (id: string, autoResumedAt?: number) =>
  ({ id, title: `T ${id}`, autoResumedAt }) as ThreadInfo;

describe("ResumeNotice", () => {
  it("picks the newest batch, and only if it is from this launch", () => {
    const threads = [t("a", 200), t("b", 200), t("c", 100), t("d")];
    assert.deepEqual(
      resumedBatch(threads, 150)?.threads.map((x) => x.id),
      ["a", "b"],
    );
    assert.equal(resumedBatch(threads, 300), null);
    assert.equal(resumedBatch([t("d")], 0), null);
  });

  it("lists the resumed threads, stops them all, and dismisses", async () => {
    const stopped: string[][] = [];
    const threads = [t("a", 200), t("b", 200), t("c", 200), t("d", 200)];
    const m = await mount(
      <ResumeNotice
        threads={threads}
        since={0}
        onStopAll={(ids) => stopped.push(ids)}
      />,
    );
    assert.ok(m.text().includes("Resumed after restart: T a, T b, T c and 1 more"));
    await m.click(m.byText("Stop all")!);
    assert.deepEqual(stopped, [["a", "b", "c", "d"]]);
    assert.equal(m.query("[data-toast=resume]"), null);
    m.unmount();
  });

  it("the close button dismisses without stopping", async () => {
    let stops = 0;
    const m = await mount(
      <ResumeNotice threads={[t("a", 5)]} since={0} onStopAll={() => stops++} />,
    );
    await m.click(m.query("[aria-label=Dismiss]") as HTMLElement);
    assert.equal(m.query("[data-toast=resume]"), null);
    assert.equal(stops, 0);
    m.unmount();
  });
});
