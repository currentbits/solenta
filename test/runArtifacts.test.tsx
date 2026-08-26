/**
 * Run artifact URL helpers and transcript media cards.
 *
 * Run: node --import=./test/support/render.mjs --experimental-strip-types --test test/runArtifacts.test.tsx
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ArtifactGroup } from "../src/timeline.ts";
import type { CoderApi, RunArtifactInfo } from "../src/shared/ipc.ts";
import {
  artifactDurationLabel,
  artifactRunLabel,
  artifactSourceLabel,
  runArtifactMediaUrl,
} from "../src/runArtifacts.ts";
import { RunArtifacts } from "../src/components/RunArtifacts.tsx";
import { mount, inAct } from "./support/dom.ts";

const imageArtifact: RunArtifactInfo = {
  id: "img-1",
  threadId: "t1",
  runId: "run-1",
  toolCallId: "tool-1",
  source: "simulator",
  kind: "image",
  mimeType: "image/png",
  name: "home-screen.png",
  size: 1200,
  createdAt: "2026-08-25T12:00:00.000Z",
  width: 390,
  height: 844,
};

const videoArtifact: RunArtifactInfo = {
  id: "vid-1",
  threadId: "t1",
  runId: "run-1",
  toolCallId: "tool-1",
  source: "verification",
  kind: "video",
  mimeType: "video/mp4",
  name: "walkthrough.mp4",
  size: 4_000_000,
  createdAt: "2026-08-25T12:00:05.000Z",
  durationMs: 83_000,
  posterArtifactId: "poster-1",
};

const posterArtifact: RunArtifactInfo = {
  id: "poster-1",
  threadId: "t1",
  runId: "run-1",
  toolCallId: "tool-1",
  source: "verification",
  kind: "image",
  mimeType: "image/png",
  name: "walkthrough-poster.png",
  size: 800,
  createdAt: "2026-08-25T12:00:04.000Z",
};

const missingArtifact: RunArtifactInfo = {
  id: "gone-1",
  threadId: "t1",
  runId: null,
  source: "manual",
  kind: "image",
  mimeType: "image/png",
  name: "missing.png",
  size: 0,
  createdAt: "2026-08-25T12:00:10.000Z",
};

function artifactGroup(
  artifacts: RunArtifactInfo[],
  over: Partial<ArtifactGroup> = {},
): ArtifactGroup {
  const first = artifacts[0]!;
  return {
    kind: "artifacts",
    key: `${first.runId ?? "manual"}\0${first.toolCallId ?? ""}`,
    runId: first.runId,
    toolCallId: first.toolCallId,
    artifacts,
    timestamp: Date.parse(first.createdAt),
    ...over,
  };
}

afterEach(() => {
  if (typeof window === "undefined") return;
  delete (window as unknown as { coder?: CoderApi }).coder;
  window.localStorage.clear();
});

describe("artifactDurationLabel", () => {
  it("formats rounded seconds as m:ss", () => {
    assert.equal(artifactDurationLabel(83_000), "1:23");
    assert.equal(artifactDurationLabel(65_000), "1:05");
  });

  it("returns null for invalid durations", () => {
    assert.equal(artifactDurationLabel(undefined), null);
    assert.equal(artifactDurationLabel(Number.NaN), null);
    assert.equal(artifactDurationLabel(-1), null);
  });
});

describe("artifact labels", () => {
  it("maps source and run association for display", () => {
    assert.equal(artifactSourceLabel("simulator"), "Simulator");
    assert.equal(artifactSourceLabel("verification"), "Verification");
    assert.equal(artifactRunLabel(imageArtifact), "Run run-1");
    assert.equal(artifactRunLabel(missingArtifact), "Manual capture");
  });
});

describe("runArtifactMediaUrl", () => {
  it("uses the desktop media protocol when Electron is present", async () => {
    const m = await mount(<div />);
    (window as unknown as { coder: CoderApi }).coder = {} as CoderApi;
    assert.equal(
      runArtifactMediaUrl("t1", "img-1"),
      "solenta-media://artifact/img-1",
    );
    m.unmount();
  });

  it("uses the authenticated web route with the stored token", async () => {
    const m = await mount(<div />);
    window.localStorage.setItem("coder.web.token", "tok-abc");
    assert.equal(
      runArtifactMediaUrl("t1", "img-1"),
      "/api/run-artifacts/t1/img-1?token=tok-abc",
    );
    m.unmount();
  });
});

function withDesktopMediaUrl(): void {
  if (typeof window !== "undefined") {
    (window as unknown as { coder: CoderApi }).coder = {} as CoderApi;
  }
}

describe("RunArtifacts", () => {
  it("renders image alt/src, video controls with poster, download, and labels", () => {
    withDesktopMediaUrl();
    const html = renderToStaticMarkup(
      <RunArtifacts
        threadId="t1"
        group={artifactGroup([imageArtifact, videoArtifact, missingArtifact])}
        allArtifacts={[imageArtifact, videoArtifact, posterArtifact, missingArtifact]}
      />,
    );

    assert.match(html, /alt="home-screen\.png"/);
    assert.match(html, /src="solenta-media:\/\/artifact\/img-1"/);

    assert.match(html, /<video[^>]*controls[^>]*preload="metadata"/);
    assert.match(html, /poster="solenta-media:\/\/artifact\/poster-1"/);
    assert.match(html, /src="solenta-media:\/\/artifact\/vid-1"/);
    assert.match(
      html,
      /href="solenta-media:\/\/artifact\/vid-1"[^>]*download="walkthrough\.mp4"/,
    );
    assert.match(html, /1:23/);
    assert.match(html, /Verification/);
    assert.match(html, /Run run-1/);
    assert.match(html, /src="solenta-media:\/\/artifact\/gone-1"/);
    assert.ok(!html.includes("/Users/"), "must not expose host paths");
    assert.ok(!html.includes("userData"), "must not expose host paths");
  });

  it("uses ordinary img elements so ThreadView delegated lightbox can open them", () => {
    withDesktopMediaUrl();
    const html = renderToStaticMarkup(
      <RunArtifacts
        threadId="t1"
        group={artifactGroup([imageArtifact])}
        allArtifacts={[imageArtifact]}
      />,
    );
    assert.match(html, /<img[^>]*src="solenta-media:\/\/artifact\/img-1"/);
    assert.ok(!html.includes("data-image-lightbox"));
    assert.ok(!html.includes("onClick"));
  });
});

describe("RunArtifacts unavailable on media error", () => {
  it("shows the unavailable state after media fails to load", async () => {
    (window as unknown as { coder: CoderApi }).coder = {} as CoderApi;
    const m = await mount(
      <RunArtifacts
        threadId="t1"
        group={artifactGroup([missingArtifact])}
        allArtifacts={[missingArtifact]}
      />,
    );
    const img = m.query("img");
    assert.ok(img, "image must render before error");
    await inAct(() => {
      img!.dispatchEvent(new Event("error"));
    });
    await m.flush();
    assert.ok(m.html().includes("data-artifact-unavailable"));
    assert.ok(m.text().includes("Media unavailable"));
    m.unmount();
  });
});
