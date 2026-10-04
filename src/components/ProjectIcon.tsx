import styles from "./ProjectIcon.module.css";

/** Tile colours for the initials fallback. No yellow: that is the brand accent. */
const AVATAR_COLORS = [
  "#6d4aff",
  "#0e9f6e",
  "#2563eb",
  "#d9480f",
  "#c2255c",
  "#0b7285",
  "#7048e8",
  "#5c940d",
];

/** "acme/nebula" → "NE", "my-cool-app" → "MC", "x" → "X". */
export function projectInitials(name: string): string {
  const last = name.trim().split(/[\\/]/).filter(Boolean).pop() ?? "";
  const words = last.split(/[-_.\s]+/).filter(Boolean);
  const raw =
    words.length >= 2 ? words[0][0] + words[1][0] : (words[0] ?? "").slice(0, 2);
  return raw.toUpperCase();
}

/** Stable colour per project: same seed, same tile, across launches. */
export function projectAvatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

/**
 * Tiny glyph for a project (#610). Shows the repo's resolved icon when there
 * is one; otherwise, when a `name` is given, a coloured initials tile (#1429).
 * Without either it renders nothing, so callers that pass only `url` keep
 * text-only rows.
 */
export function ProjectIcon({
  url,
  size = 16,
  name,
  seed,
}: {
  url?: string | null;
  size?: number;
  /** Project display name; enables the initials fallback. */
  name?: string | null;
  /** Colour seed (project id); defaults to the name. */
  seed?: string | null;
}) {
  if (url) {
    return (
      <img
        src={url}
        alt=""
        width={size}
        height={size}
        draggable={false}
        data-project-icon=""
        className={styles.icon}
      />
    );
  }
  const initials = name ? projectInitials(name) : "";
  if (!initials) return null;
  return (
    <span
      aria-hidden="true"
      data-project-avatar=""
      className={styles.avatar}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(7, Math.round(size * 0.5)),
        background: projectAvatarColor(seed || name || ""),
      }}
    >
      {initials}
    </span>
  );
}
