import styles from "../SettingsModal.module.css";
import type { SettingsPane } from "../SettingsModal";

export function PaneIcon({ id }: { id: SettingsPane }) {
  return (
    <svg
      className={styles.navIcon}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {id === "general" ? (
        <>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1" />
        </>
      ) : id === "keyboard" ? (
        <>
          <rect x="3" y="6" width="18" height="12" rx="2" />
          <path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" />
        </>
      ) : id === "threads" ? (
        <>
          <path d="M8 6h13M8 12h13M8 18h13" />
          <path d="M3 6h.01M3 12h.01M3 18h.01" />
        </>
      ) : id === "spending" ? (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M14.5 9.5a2.5 2.5 0 0 0-5 0c0 3.5 5 1.5 5 5a2.5 2.5 0 0 1-5 0M12 7v1.5M12 15.5V17" />
        </>
      ) : id === "git" ? (
        <>
          <circle cx="6" cy="6" r="2.2" />
          <circle cx="18" cy="6" r="2.2" />
          <circle cx="12" cy="18" r="2.2" />
          <path d="M8 7.5v3.2A6 6 0 0 0 12 16M16 7.5v3.2A6 6 0 0 1 12 16" />
        </>
      ) : id === "providers" ? (
        <>
          <rect x="4" y="4" width="16" height="6" rx="1.5" />
          <rect x="4" y="14" width="16" height="6" rx="1.5" />
          <path d="M8 7h.01M8 17h.01" />
        </>
      ) : id === "agents" ? (
        <>
          <circle cx="8" cy="9" r="2.4" />
          <circle cx="16" cy="9" r="2.4" />
          <path d="M4 18c.4-2.4 2.4-4 4-4s3.6 1.6 4 4M12 18c.4-2.4 2.4-4 4-4s3.6 1.6 4 4" />
        </>
      ) : id === "memory" ? (
        <>
          <rect x="4" y="5" width="16" height="14" rx="2" />
          <path d="M8 9h8M8 13h5" />
        </>
      ) : id === "integrations" ? (
        <>
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" />
          <path d="M10 6.5h4a3.5 3.5 0 0 1 3.5 3.5v4M14 17.5h-4A3.5 3.5 0 0 1 6.5 14v-4" />
        </>
      ) : id === "connections" ? (
        <>
          <rect x="3" y="5" width="8" height="6" rx="1" />
          <rect x="13" y="13" width="8" height="6" rx="1" />
          <path d="M11 8h3a3 3 0 0 1 3 3v2" />
        </>
      ) : id === "skills" ? (
        <>
          <path d="M9 3v4M15 3v4" />
          <path d="M7 7h10v4a5 5 0 0 1-10 0V7Z" />
          <path d="M12 16v5" />
        </>
      ) : (
        <>
          <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
          <circle cx="15" cy="6" r="2" />
          <circle cx="9" cy="12" r="2" />
          <circle cx="17" cy="18" r="2" />
        </>
      )}
    </svg>
  );
}
