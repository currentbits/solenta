export function loadStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function saveStored(key: string, value: string | null): void {
  try {
    if (value == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Quota/private mode: UI state just stops persisting.
  }
}

export function loadFlag(key: string, fallback: boolean): boolean {
  const raw = loadStored(key);
  if (raw == null) return fallback;
  return raw === "1" || raw === "true";
}

export function saveFlag(key: string, value: boolean): void {
  saveStored(key, value ? "1" : "0");
}

export function loadOpenSet(key: string): Set<string> {
  try {
    const raw = JSON.parse(loadStored(key) || "[]") as unknown;
    if (!Array.isArray(raw)) return new Set();
    return new Set(raw.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

export function saveOpenSet(key: string, ids: ReadonlySet<string>): void {
  saveStored(key, JSON.stringify([...ids]));
}
