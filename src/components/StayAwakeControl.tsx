import type { ReactNode } from "react";
import type { StayAwakeMode, StayAwakeStatus } from "../shared/ipc";
import styles from "./StayAwakeControl.module.css";

/**
 * Three-state stay-awake control (issue #364, item 5), living in the sidebar
 * footer so it is always reachable — the question "I'm about to close the
 * lid, is anything running?" is situational, not a Settings-pane concern.
 *
 * Click cycles agent → on → off → agent. The tooltip carries the live
 * state: whether the Mac is currently kept awake, or suspended because it
 * is on battery power.
 */

const ORDER: StayAwakeMode[] = ["agent", "on", "off"];

const MODE_LABEL: Record<StayAwakeMode, string> = {
  agent: "Agent",
  on: "On",
  off: "Off",
};

const MODE_HINT: Record<StayAwakeMode, string> = {
  agent: "Stay awake while agents run",
  on: "Always stay awake",
  off: "Never stay awake",
};

function nextMode(mode: StayAwakeMode): StayAwakeMode {
  const i = ORDER.indexOf(mode);
  return ORDER[(i + 1) % ORDER.length];
}

function Icon({ children, size = 14 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function StayAwakeControl({
  state,
  onSetMode,
}: {
  state: StayAwakeStatus;
  onSetMode: (mode: StayAwakeMode) => void;
}) {
  const status = state.blocking
    ? "Keeping this Mac awake"
    : state.onBattery
      ? "Suspended on battery power"
      : "Sleep allowed";
  const title = `${MODE_HINT[state.mode]} · ${status}`;
  return (
    <button
      type="button"
      className={styles.stayAwake}
      data-stay-awake=""
      data-stay-awake-mode={state.mode}
      data-stay-awake-blocking={state.blocking ? "" : undefined}
      title={title}
      aria-label={`Stay awake: ${MODE_LABEL[state.mode]}. ${status}`}
      onClick={() => onSetMode(nextMode(state.mode))}
    >
      <span
        className={`${styles.dot} ${state.blocking ? styles.dotBlocking : ""}`}
        aria-hidden
      />
      <Icon size={14}>
        {/* coffee cup */}
        <path d="M17 8h1a3 3 0 0 1 0 6h-1" />
        <path d="M4 8h13v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8z" />
        {state.mode !== "off" && (
          <>
            <path d="M8 2v2" />
            <path d="M12 2v2" />
          </>
        )}
      </Icon>
      <span className={styles.label}>{MODE_LABEL[state.mode]}</span>
    </button>
  );
}
