/**
 * T3 thread-action item list: Snooze is a parent with children, not a
 * first-level dump of presets.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildThreadActionMenuItems } from "../src/threadActionMenu";
import type { ProviderInfo, ThreadInfo } from "../src/shared/ipc";

const thread = {
  id: "t1",
  title: "one",
  provider: "claude",
  status: "idle",
} as ThreadInfo;

const providers: ProviderInfo[] = [
  {
    id: "claude",
    name: "Claude Code",
    available: true,
    supportsResume: true,
    models: [],
    modelInfo: [],
    efforts: [],
  },
  {
    id: "grok",
    name: "Grok",
    available: true,
    supportsResume: true,
    models: [],
    modelInfo: [],
    efforts: [],
  },
];

const presets = [
  { id: "hour", label: "In 1 hour", whenLabel: "3:04pm", until: 1 },
];

describe("buildThreadActionMenuItems (T3 contract)", () => {
  it("puts snooze presets on Snooze children, not the first level", () => {
    const items = buildThreadActionMenuItems({
      thread,
      providers,
      snoozePresets: presets,
      isSettled: false,
      canSettle: true,
      showSnooze: true,
      showFork: true,
      showRename: true,
      showMute: true,
      showSettle: true,
    });
    const snooze = items.find((i) => i.id === "snooze");
    assert.ok(snooze, "Snooze parent");
    assert.equal(
      items.some((i) => i.id.startsWith("snooze:")),
      false,
      "presets must not sit on the first level",
    );
    assert.ok(snooze.children?.some((c) => c.id === "snooze:hour"));
    assert.ok(items.some((i) => i.id === "fork"));
    assert.ok(items.some((i) => i.id === "handoff:grok"));
  });

  it("already-snoozed threads show Wake, not a Snooze submenu", () => {
    const items = buildThreadActionMenuItems({
      thread: { ...thread, snoozedUntil: Date.now() + 1000 } as ThreadInfo,
      providers,
      snoozePresets: presets,
      isSettled: false,
      canSettle: true,
      showSnooze: true,
      showFork: false,
      showRename: false,
      showMute: false,
      showSettle: false,
    });
    assert.ok(items.some((i) => i.id === "unsnooze"));
    assert.equal(items.some((i) => i.id === "snooze"), false);
  });
});
