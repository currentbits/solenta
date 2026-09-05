import type { ReactNode } from "react";
import { providerDisplayName } from "../format";
import type { ProviderInfo } from "../shared/ipc";
import styles from "./ProviderMark.module.css";

/**
 * Tiny currentColor harness mark (#893, #902).
 *
 * Silhouettes identify the CLI at 12–16px: Anthropic A, Codex prompt,
 * Grok G, Cursor diamond, Kimi K, OpenCode window. Unknown ids fall
 * back to the first letter so a future harness still has a glyph.
 *
 * Standalone (thread cards) exposes the display name via aria-label.
 * Next to a visible name (filter chips, picker rows) pass decorative
 * so the parent keeps a single accessible name.
 *
 * Paths: simple-icons (CC0) for anthropic + cursor; lobe-icons (MIT)
 * for grok, kimi, opencode. Codex is a prompt glyph (the official blob
 * collapses at 13px). Muse and simulate are original.
 */
export function ProviderMark({
  providerId,
  providers = [],
  size = 14,
  className,
  decorative = false,
}: {
  providerId: string;
  providers?: readonly ProviderInfo[];
  size?: number;
  className?: string;
  /** Hide from AT when a sibling already names the harness. */
  decorative?: boolean;
}) {
  const name = providerDisplayName(providerId, providers);
  const glyph = markFor(providerId, size);
  return (
    <span
      className={[styles.mark, className].filter(Boolean).join(" ")}
      data-provider-mark={providerId}
      title={decorative ? undefined : name}
      aria-label={decorative ? undefined : name}
      aria-hidden={decorative ? true : undefined}
      role={decorative ? undefined : "img"}
    >
      {glyph}
    </span>
  );
}

function Svg({
  size,
  children,
  evenodd = false,
}: {
  size: number;
  children: ReactNode;
  evenodd?: boolean;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule={evenodd ? "evenodd" : undefined}
      clipRule={evenodd ? "evenodd" : undefined}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function markFor(id: string, size: number): ReactNode {
  switch (id) {
    case "claude":
      return (
        <Svg size={size}>
          <path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" />
        </Svg>
      );
    case "codex":
      // Filled window with a >_ cutout. Stroke-only prompts vanish at 13px;
      // the official Codex blob turns to a smudge.
      return (
        <Svg size={size} evenodd>
          <path d="M6 4.5A3.5 3.5 0 0 0 2.5 8v8A3.5 3.5 0 0 0 6 19.5h12a3.5 3.5 0 0 0 3.5-3.5V8A3.5 3.5 0 0 0 18 4.5H6Zm2.45 4.55a.85.85 0 0 1 1.16-.18l3.5 2.45c.4.28.4.9 0 1.18l-3.5 2.45a.85.85 0 1 1-.98-1.39L11.15 12 8.63 10.24a.85.85 0 0 1-.18-1.19ZM13.15 13.4h3.25a.85.85 0 0 1 0 1.7h-3.25a.85.85 0 1 1 0-1.7Z" />
        </Svg>
      );
    case "grok":
      return (
        <Svg size={size} evenodd>
          <path d="M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815" />
        </Svg>
      );
    case "cursor":
      return (
        <Svg size={size}>
          <path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" />
        </Svg>
      );
    case "kimi":
      return (
        <Svg size={size} evenodd>
          <path d="M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z" />
          <path d="M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z" />
        </Svg>
      );
    case "opencode":
      return (
        <Svg size={size} evenodd>
          <path d="M16 6H8v12h8V6zm4 16H4V2h16v20z" />
        </Svg>
      );
    case "muse":
      return (
        <Svg size={size}>
          <path d="M12 1.8 13.35 9.2 21 10.2 13.35 11.2 12 22.2 10.65 11.2 3 10.2 10.65 9.2Z" />
        </Svg>
      );
    case "simulate":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <circle
            cx="12"
            cy="12"
            r="8.25"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
          />
          <path d="M10 8.6 16.4 12 10 15.4Z" fill="currentColor" />
        </svg>
      );
    default:
      return (
        <span
          className={styles.letter}
          style={{ width: size, height: size, fontSize: Math.round(size * 0.72) }}
          aria-hidden="true"
        >
          {(id[0] || "?").toUpperCase()}
        </span>
      );
  }
}
