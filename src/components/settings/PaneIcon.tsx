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
          <path d="M8 7h3v3H8zM13 14h3v3h-3z" />
          <path d="M11 8.5h2.5A2.5 2.5 0 0 1 16 11M13 15.5h-2.5A2.5 2.5 0 0 1 8 13" />
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
          <circle cx="12" cy="12" r="3" />
          <path d="M4.5 12H8M16 12h3.5M12 4.5V8M12 16v3.5" />
          <path d="m7 7 2.2 2.2M14.8 14.8 17 17M17 7l-2.2 2.2M9.2 14.8 7 17" />
        </>
      )}
    </svg>
  );
}
