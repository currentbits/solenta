import type { HostTag } from "../../shared/ipc";
import styles from "../Sidebar.module.css";

/** Which other machine a project or thread lives on (#1819). */
export function HostChip({ host }: { host?: HostTag }) {
  if (!host) return null;
  const state = host.status === "online" ? "" : ` (${host.status})`;
  return (
    <span
      className={styles.hostChip}
      data-host-chip={host.key}
      data-host-status={host.status}
      title={`Runs on ${host.label}${state}`}
    >
      {host.label}
    </span>
  );
}
