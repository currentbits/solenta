/**
 * Map canvas CSS points onto encoded device points and gate input until
 * a fresh stream generation has reported dimensions (#248).
 */

import type { SimulatorInput, SimulatorKey } from "./shared/ipc";

export type ClientPoint = { clientX: number; clientY: number };
export type CanvasRect = { left: number; top: number; width: number; height: number };
export type DeviceSize = { width: number; height: number };

const SPECIAL_KEYS: Record<string, SimulatorKey> = {
  Enter: "enter",
  Escape: "escape",
  Backspace: "backspace",
  Tab: "tab",
  " ": "space",
  Spacebar: "space",
  Delete: "delete",
  ArrowUp: "arrowUp",
  ArrowDown: "arrowDown",
  ArrowLeft: "arrowLeft",
  ArrowRight: "arrowRight",
  Home: "home",
  End: "end",
  PageUp: "pageUp",
  PageDown: "pageDown",
};

export function canvasPointToDevice(
  point: ClientPoint,
  canvasRect: CanvasRect,
  device: DeviceSize,
): { x: number; y: number } | null {
  if (!(device.width > 0) || !(device.height > 0)) return null;
  if (!(canvasRect.width > 0) || !(canvasRect.height > 0)) return null;
  const nx = clamp((point.clientX - canvasRect.left) / canvasRect.width, 0, 1);
  const ny = clamp((point.clientY - canvasRect.top) / canvasRect.height, 0, 1);
  return { x: nx * device.width, y: ny * device.height };
}

export function inputAllowed(opts: {
  generation: number | null | undefined;
  streamGeneration?: number | null;
  dimensions: DeviceSize | null | undefined;
}): boolean {
  if (opts.generation == null) return false;
  if (opts.streamGeneration == null || opts.streamGeneration !== opts.generation) {
    return false;
  }
  const dim = opts.dimensions;
  if (!dim) return false;
  return dim.width > 0 && dim.height > 0;
}

export function mapKeyboardInput(event: {
  key: string;
  type?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}): SimulatorInput | null {
  const special = SPECIAL_KEYS[event.key];
  if (special) {
    const phase = event.type === "keyup" ? "up" : "down";
    return { kind: "key", key: special, phase };
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (event.type === "keyup") return null;
  if (event.key.length !== 1) return null;
  return { kind: "text", text: event.key };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
