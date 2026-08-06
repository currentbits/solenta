/** Relative age like "3h", "1d", "12m" from a unix-ms timestamp. */
export function formatRelativeAge(updatedAt: number, now = Date.now()): string {
  const diff = Math.max(0, now - updatedAt);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/** Elapsed working label like "Working 2m" from updatedAt. */
export function formatWorkingLabel(updatedAt: number, now = Date.now()): string {
  const diff = Math.max(0, now - updatedAt);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "Working";
  if (minutes < 60) return `Working ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Working ${hours}h`;
  return `Working ${Math.floor(hours / 24)}d`;
}

/** Token sum like "Σ 52.0k". */
export function formatTokenSum(tokens: number): string {
  if (tokens >= 1000) {
    const k = tokens / 1000;
    const text = k >= 100 ? k.toFixed(0) : k.toFixed(1);
    return `Σ ${text}k`;
  }
  return `Σ ${tokens}`;
}

/** Split assistant text into paragraphs (blank-line separated). */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
}
