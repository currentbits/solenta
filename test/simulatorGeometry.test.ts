/**
 * Device-point mapping and canvas input gating for the iOS Simulator pane.
 * Run: node --import=./test/support/render.mjs --experimental-strip-types --test test/simulatorGeometry.test.ts
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { afterEach, describe, it } from "node:test";
import { inAct, mount, unmountAll } from "./support/dom.ts";
import {
  canvasPointToDevice,
  inputAllowed,
} from "../src/simulatorGeometry.ts";
import { SimulatorCanvas } from "../src/components/SimulatorCanvas.tsx";
import type { SimulatorInput } from "../src/shared/ipc";

afterEach(unmountAll);

const RECT = { left: 10, top: 20, width: 100, height: 200 };
const PORTRAIT = { width: 1179, height: 2556 };

function stubRect(el: Element, rect: typeof RECT): void {
  (el as HTMLElement).getBoundingClientRect = () =>
    ({
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      toJSON() {
        return {};
      },
    }) as DOMRect;
}

function pointer(
  type: string,
  over: { clientX?: number; clientY?: number; pointerId?: number } = {},
): Event {
  const Ctor = (window.PointerEvent ??
    window.MouseEvent) as typeof PointerEvent;
  const event = new Ctor(type, {
    bubbles: true,
    cancelable: true,
    pointerId: over.pointerId ?? 1,
    clientX: over.clientX ?? 60,
    clientY: over.clientY ?? 120,
  });
  if ((event as PointerEvent).pointerId == null) {
    Object.defineProperty(event, "pointerId", {
      value: over.pointerId ?? 1,
    });
  }
  return event;
}

describe("canvasPointToDevice", () => {
  it("maps CSS canvas coordinates onto encoded device points", () => {
    assert.deepEqual(
      canvasPointToDevice(
        { clientX: 60, clientY: 120 },
        { left: 10, top: 20, width: 100, height: 200 },
        { width: 1179, height: 2556 },
      ),
      { x: 589.5, y: 1278 },
    );
  });

  it("clamps points that fall outside the canvas", () => {
    assert.deepEqual(
      canvasPointToDevice({ clientX: -50, clientY: 20 }, RECT, PORTRAIT),
      { x: 0, y: 0 },
    );
    assert.deepEqual(
      canvasPointToDevice({ clientX: 999, clientY: 999 }, RECT, PORTRAIT),
      { x: 1179, y: 2556 },
    );
  });

  it("uses current encoded dimensions after rotation", () => {
    assert.deepEqual(
      canvasPointToDevice(
        { clientX: 60, clientY: 120 },
        RECT,
        { width: 2556, height: 1179 },
      ),
      { x: 1278, y: 589.5 },
    );
  });

  it("refuses mapping when canvas or device dimensions are zero", () => {
    assert.equal(
      canvasPointToDevice({ clientX: 60, clientY: 120 }, RECT, {
        width: 0,
        height: 2556,
      }),
      null,
    );
    assert.equal(
      canvasPointToDevice(
        { clientX: 60, clientY: 120 },
        { ...RECT, width: 0 },
        PORTRAIT,
      ),
      null,
    );
  });
});

describe("inputAllowed", () => {
  it("refuses input until fresh encoded dimensions are known", () => {
    assert.equal(
      inputAllowed({
        generation: 3,
        streamGeneration: 3,
        dimensions: null,
      }),
      false,
    );
    assert.equal(
      inputAllowed({
        generation: 3,
        streamGeneration: 3,
        dimensions: { width: 0, height: 2556 },
      }),
      false,
    );
    assert.equal(
      inputAllowed({
        generation: 3,
        streamGeneration: 3,
        dimensions: PORTRAIT,
      }),
      true,
    );
  });

  it("refuses input after attach/reconnect/takeover until the stream generation matches", () => {
    assert.equal(
      inputAllowed({
        generation: 4,
        streamGeneration: 3,
        dimensions: PORTRAIT,
      }),
      false,
    );
    assert.equal(
      inputAllowed({
        generation: 4,
        streamGeneration: null,
        dimensions: PORTRAIT,
      }),
      false,
    );
  });
});

describe("SimulatorCanvas input", () => {
  it("captures the pointer on down and sends bounded device-point events", async () => {
    const sent: SimulatorInput[] = [];
    const m = await mount(
      createElement(SimulatorCanvas, {
        generation: 3,
        streamGeneration: 3,
        dimensions: PORTRAIT,
        onInput: (input) => sent.push(input),
      }),
    );
    const canvas = m.query("[data-simulator-canvas]") as HTMLCanvasElement;
    assert.ok(canvas);
    assert.equal(canvas.tabIndex, 0);
    stubRect(canvas, RECT);

    await inAct(() => {
      canvas.dispatchEvent(pointer("pointerdown"));
    });
    await inAct(() => {
      canvas.dispatchEvent(pointer("pointermove", { clientX: 60, clientY: 120 }));
    });
    await inAct(() => {
      canvas.dispatchEvent(pointer("pointerup"));
    });

    assert.deepEqual(sent, [
      { kind: "touch", phase: "down", pointerId: 1, x: 589.5, y: 1278 },
      { kind: "touch", phase: "move", pointerId: 1, x: 589.5, y: 1278 },
      { kind: "touch", phase: "up", pointerId: 1, x: 589.5, y: 1278 },
    ]);
    m.unmount();
  });

  it("sends up when pointer capture is lost", async () => {
    const sent: SimulatorInput[] = [];
    const m = await mount(
      createElement(SimulatorCanvas, {
        generation: 3,
        streamGeneration: 3,
        dimensions: PORTRAIT,
        onInput: (input) => sent.push(input),
      }),
    );
    const canvas = m.query("[data-simulator-canvas]") as HTMLCanvasElement;
    stubRect(canvas, RECT);
    await inAct(() => {
      canvas.dispatchEvent(pointer("pointerdown"));
    });
    await inAct(() => {
      canvas.dispatchEvent(pointer("lostpointercapture"));
    });
    assert.equal(sent.at(-1)?.kind, "touch");
    if (sent.at(-1)?.kind === "touch") {
      assert.equal(sent.at(-1).phase, "up");
    }
    m.unmount();
  });

  it("refuses pointer and keyboard input before fresh dimensions", async () => {
    const sent: SimulatorInput[] = [];
    const m = await mount(
      createElement(SimulatorCanvas, {
        generation: 3,
        streamGeneration: 3,
        dimensions: null,
        onInput: (input) => sent.push(input),
      }),
    );
    const canvas = m.query("[data-simulator-canvas]") as HTMLCanvasElement;
    stubRect(canvas, RECT);
    await inAct(() => {
      canvas.dispatchEvent(pointer("pointerdown"));
      canvas.dispatchEvent(
        new KeyboardEvent("keydown", { key: "a", bubbles: true }),
      );
    });
    assert.deepEqual(sent, []);
    m.unmount();
  });

  it("refuses input for a stale stream generation", async () => {
    const sent: SimulatorInput[] = [];
    const m = await mount(
      createElement(SimulatorCanvas, {
        generation: 5,
        streamGeneration: 4,
        dimensions: PORTRAIT,
        onInput: (input) => sent.push(input),
      }),
    );
    const canvas = m.query("[data-simulator-canvas]") as HTMLCanvasElement;
    stubRect(canvas, RECT);
    await inAct(() => {
      canvas.dispatchEvent(pointer("pointerdown"));
    });
    assert.deepEqual(sent, []);
    m.unmount();
  });

  it("maps printable keys to text and the closed special-key enum to key events", async () => {
    const sent: SimulatorInput[] = [];
    const m = await mount(
      createElement(SimulatorCanvas, {
        generation: 3,
        streamGeneration: 3,
        dimensions: PORTRAIT,
        onInput: (input) => sent.push(input),
      }),
    );
    const canvas = m.query("[data-simulator-canvas]") as HTMLCanvasElement;
    canvas.focus();
    await inAct(() => {
      canvas.dispatchEvent(
        new KeyboardEvent("keydown", { key: "h", bubbles: true }),
      );
      canvas.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      canvas.dispatchEvent(
        new KeyboardEvent("keyup", { key: "Enter", bubbles: true }),
      );
      canvas.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Shift", bubbles: true }),
      );
    });
    assert.deepEqual(sent, [
      { kind: "text", text: "h" },
      { kind: "key", key: "enter", phase: "down" },
      { kind: "key", key: "enter", phase: "up" },
    ]);
    m.unmount();
  });
});
