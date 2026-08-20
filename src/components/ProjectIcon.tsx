import styles from "./ProjectIcon.module.css";

/**
 * Tiny glyph for a project's resolved icon (#610). Renders nothing when
 * the repo has no icon, so text-only rows stay unchanged.
 */
export function ProjectIcon({
  url,
  size = 16,
}: {
  url?: string | null;
  size?: number;
}) {
  if (!url) return null;
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
