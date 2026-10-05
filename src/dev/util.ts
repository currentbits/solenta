/** Shared helpers for the browser-dev fixture (src/devCoder.ts). */
import type { ThreadDetail } from "../shared/ipc";

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

export const TRAILER = import.meta.env?.VITE_TRAILER === "1";
export const TITLE_MAX = 60;
export function now() {
  return Date.now();
}

export function id(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function capitalize(name: string): string {
  if (!name) return name;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function cloneDetail(d: ThreadDetail): ThreadDetail {
  return structuredClone(d);
}
