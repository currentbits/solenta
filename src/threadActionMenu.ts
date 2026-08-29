/**
 * Item list for the per-thread action menu. Same contract as T3's
 * buildThreadActionMenuItems: Snooze is a parent with children, not a
 * first-level dump of presets, and not an in-card drill-in panel.
 */

import type { ProviderInfo, ThreadInfo } from "./shared/ipc";
import type { ContextMenuItem } from "./contextMenu";
import type { SnoozePreset } from "./threadSnooze";

export type ThreadActionMenuId =
  | "settle"
  | "unsettle"
  | "snooze"
  | `snooze:${string}`
  | "unsnooze"
  | "pin"
  | "unpin"
  | "fork"
  | `handoff:${string}`
  | "rename"
  | "tags"
  | "mute"
  | "unmute";

export function buildThreadActionMenuItems(input: {
  thread: ThreadInfo;
  providers: ProviderInfo[];
  snoozePresets: ReadonlyArray<SnoozePreset>;
  isSettled: boolean;
  canSettle: boolean;
  showSnooze: boolean;
  /** Pin lives in the menu since the flat sidebar retired the hover pin. */
  showPin?: boolean;
  showFork: boolean;
  showRename: boolean;
  showTags?: boolean;
  showMute: boolean;
  showSettle: boolean;
}): ContextMenuItem[] {
  const { thread } = input;
  const items: ContextMenuItem[] = [];

  if (input.showSnooze) {
    if (thread.snoozedUntil != null) {
      items.push({
        id: "unsnooze",
        label: "Wake thread",
        attrs: { "data-snooze-clear": "" },
      });
    } else {
      items.push({
        id: "snooze",
        label: "Snooze",
        attrs: { "data-snooze-item": "" },
        children: input.snoozePresets.map((p) => ({
          id: `snooze:${p.id}`,
          label: p.label,
          whenLabel: p.whenLabel,
          attrs: { "data-snooze-preset": p.id },
        })),
      });
    }
  }

  if (input.showPin) {
    const pinned = thread.pinnedAt != null;
    items.push({
      id: pinned ? "unpin" : "pin",
      label: pinned ? "Unpin thread" : "Pin thread",
      attrs: { "data-pin-item": thread.id },
    });
  }

  if (input.showFork) {
    items.push({
      id: "fork",
      label: "Fork",
      separatorBefore: items.length > 0,
      attrs: { "data-fork-btn": thread.id },
    });
    for (const p of input.providers.filter((x) => x.id !== thread.provider)) {
      items.push({
        id: `handoff:${p.id}`,
        label: `Hand off · ${p.name}`,
        disabled: !p.available,
        attrs: { "data-handoff-provider": p.id },
      });
    }
  }

  if (input.showRename) {
    items.push({
      id: "rename",
      label: "Rename",
      separatorBefore: items.length > 0,
      attrs: { "data-rename-thread": thread.id },
    });
  }

  if (input.showTags) {
    items.push({
      id: "tags",
      label: "Edit tags",
      separatorBefore: !input.showRename && items.length > 0,
      attrs: { "data-edit-tags": thread.id },
    });
  }

  if (input.showMute) {
    items.push({
      id: thread.muted ? "unmute" : "mute",
      label: thread.muted ? "Unmute notifications" : "Mute notifications",
      separatorBefore: !input.showRename && items.length > 0,
      attrs: { "data-mute-toggle": thread.id },
    });
  }

  if (input.showSettle) {
    items.push({
      id: input.isSettled ? "unsettle" : "settle",
      label: input.isSettled ? "Keep thread active" : "Settle thread",
      disabled: !input.canSettle,
      separatorBefore: items.length > 0,
      attrs: { "data-settle-item": thread.id },
    });
  }

  return items;
}
