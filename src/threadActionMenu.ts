/**
 * Item list for the per-thread action menu. Same contract as T3's
 * buildThreadActionMenuItems: Snooze is a parent with children, not a
 * first-level dump of presets, and not an in-card drill-in panel.
 */

import type { ProjectInfo, ProviderInfo, ThreadInfo } from "./shared/ipc";
import type { ContextMenuItem } from "./contextMenu";
import type { SnoozePreset } from "./threadSnooze";

/** Why Move to project… is disabled; null when the move is allowed. */
export function threadProjectMoveBlockReason(
  thread: Pick<
    ThreadInfo,
    "worktreePath" | "status" | "orchWorker" | "leadSnapshotSha"
  >,
): string | null {
  if (thread.worktreePath) return "Has a worktree in this project";
  if (thread.orchWorker) return "Crew worker";
  if (thread.leadSnapshotSha) return "Has a recorded start snapshot";
  if (thread.status === "working" || thread.status === "quota-wait") {
    return "Run is active";
  }
  return null;
}

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
  | "move"
  | `project:${string}`
  | "mute"
  | "unmute"
  | "eject"
  | "reclaim";

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
  /** Recategorize onto another project (issue #737). */
  showMove?: boolean;
  projects?: ReadonlyArray<ProjectInfo>;
  showMute: boolean;
  /** Eject the provider session so the raw CLI/Desktop can own it (#554). */
  showEject?: boolean;
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

  if (input.showMove) {
    const dests = (input.projects ?? []).filter(
      (p) => p.id !== thread.projectId,
    );
    if (dests.length > 0) {
      const block = threadProjectMoveBlockReason(thread);
      items.push({
        id: "move",
        label: "Move to project…",
        disabled: Boolean(block),
        whenLabel: block ?? undefined,
        separatorBefore: !input.showRename && !input.showTags && items.length > 0,
        attrs: { "data-move-project": thread.id },
        children: block
          ? undefined
          : dests.map((p) => ({
              id: `project:${p.id}`,
              label: p.slug || p.name,
              attrs: { "data-move-project-id": p.id },
            })),
      });
    }
  }

  if (input.showMute) {
    items.push({
      id: thread.muted ? "unmute" : "mute",
      label: thread.muted ? "Unmute notifications" : "Mute notifications",
      separatorBefore: !input.showRename && items.length > 0,
      attrs: { "data-mute-toggle": thread.id },
    });
  }

  if (input.showEject) {
    items.push({
      id: thread.ejected ? "reclaim" : "eject",
      label: thread.ejected ? "Reclaim in Solenta" : "Eject to terminal",
      separatorBefore: items.length > 0,
      attrs: { "data-eject-toggle": thread.id },
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
