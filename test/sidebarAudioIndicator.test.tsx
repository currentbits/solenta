/**
 * Sidebar audio indicator (#1807): ThreadCard shows a speaker icon while
 * the thread's Browser pane is audible, and clicking it toggles mute.
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { mount, unmountAll } from "./support/dom.ts";
import { ThreadCard } from "../src/components/Sidebar";
import { thread } from "./support/fakeCoder.ts";
import type { ProviderInfo } from "../src/shared/ipc";

const PROVIDERS: ProviderInfo[] = [
  {
    id: "claude",
    name: "Claude Code",
    available: true,
    supportsResume: true,
    models: [],
    modelInfo: [],
    efforts: [],
  },
];

afterEach(() => {
  unmountAll();
});

function cardFor(
  audio: { audible: boolean; muted: boolean } | null,
  onSetAudioMuted?: (threadId: string, muted: boolean) => void,
) {
  return mount(
    <ThreadCard
      thread={thread({ id: "t1", title: "playing a video" })}
      slug="acme/ledger"
      providers={PROVIDERS}
      active={false}
      now={Date.now()}
      onSelect={() => {}}
      audio={audio}
      onSetAudioMuted={onSetAudioMuted}
    />,
  );
}

describe("sidebar audio indicator (#1807)", () => {
  it("is absent when nothing is audible", async () => {
    const card = await cardFor(null);
    assert.equal(card.query("[data-audio-indicator]"), null);
    card.unmount();
  });

  it("shows a speaker icon while audible, not struck when unmuted", async () => {
    const card = await cardFor({ audible: true, muted: false });
    const icon = card.query("[data-audio-indicator]");
    assert.ok(icon, "icon shows while audible");
    assert.equal(icon!.getAttribute("data-audio-muted"), null);
    assert.equal(icon!.getAttribute("aria-label"), "Mute thread audio");
    card.unmount();
  });

  it("shows struck when muted", async () => {
    const card = await cardFor({ audible: true, muted: true });
    const icon = card.query("[data-audio-indicator]");
    assert.ok(icon);
    assert.equal(icon!.getAttribute("data-audio-muted"), "true");
    assert.equal(icon!.getAttribute("aria-label"), "Unmute thread audio");
    card.unmount();
  });

  it("clicking the icon calls onSetAudioMuted with the toggled value", async () => {
    const calls: Array<[string, boolean]> = [];
    const card = await cardFor({ audible: true, muted: false }, (id, muted) => {
      calls.push([id, muted]);
    });
    const icon = card.query("[data-audio-indicator]") as HTMLButtonElement;
    assert.ok(icon);
    await card.click(icon);
    assert.deepEqual(calls, [["t1", true]]);
    card.unmount();
  });

  it("clicking a muted icon unmutes", async () => {
    const calls: Array<[string, boolean]> = [];
    const card = await cardFor({ audible: true, muted: true }, (id, muted) => {
      calls.push([id, muted]);
    });
    const icon = card.query("[data-audio-indicator]") as HTMLButtonElement;
    await card.click(icon);
    assert.deepEqual(calls, [["t1", false]]);
    card.unmount();
  });
});
