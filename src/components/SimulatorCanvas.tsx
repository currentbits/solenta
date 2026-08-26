import {
  forwardRef,
  useCallback,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  canvasPointToDevice,
  inputAllowed,
  mapKeyboardInput,
  type DeviceSize,
} from "../simulatorGeometry";
import type { SimulatorInput } from "../shared/ipc";
import styles from "./SimulatorPane.module.css";

type Props = {
  generation: number | null;
  streamGeneration?: number | null;
  dimensions: DeviceSize | null;
  onInput: (input: SimulatorInput) => void;
};

export const SimulatorCanvas = forwardRef<HTMLCanvasElement, Props>(
  function SimulatorCanvas(
    { generation, streamGeneration, dimensions, onInput },
    ref,
  ) {
    const activePointers = useRef(new Set<number>());

    const allowed = inputAllowed({
      generation,
      streamGeneration,
      dimensions,
    });

    const sendTouch = useCallback(
      (
        event: Pick<PointerEvent, "clientX" | "clientY" | "pointerId">,
        phase: "down" | "move" | "up",
        canvas: HTMLCanvasElement,
      ) => {
        if (!allowed || !dimensions) return;
        const mapped = canvasPointToDevice(
          event,
          canvas.getBoundingClientRect(),
          dimensions,
        );
        if (!mapped) return;
        onInput({
          kind: "touch",
          phase,
          pointerId: event.pointerId,
          x: mapped.x,
          y: mapped.y,
        });
      },
      [allowed, dimensions, onInput],
    );

    const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!allowed) return;
      event.preventDefault();
      event.currentTarget.focus();
      activePointers.current.add(event.pointerId);
      sendTouch(event, "down", event.currentTarget);
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // jsdom / non-pointer hosts
      }
    };

    const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!activePointers.current.has(event.pointerId)) return;
      sendTouch(event, "move", event.currentTarget);
    };

    const endPointer = (
      event: ReactPointerEvent<HTMLCanvasElement>,
      release: boolean,
    ) => {
      if (!activePointers.current.has(event.pointerId)) return;
      activePointers.current.delete(event.pointerId);
      sendTouch(event, "up", event.currentTarget);
      if (release) {
        try {
          if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        } catch {
          // jsdom
        }
      }
    };

    const onKey = (event: ReactKeyboardEvent<HTMLCanvasElement>) => {
      if (!allowed) return;
      const input = mapKeyboardInput({
        key: event.key,
        type: event.type,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
      });
      if (!input) return;
      event.preventDefault();
      onInput(input);
    };

    return (
      <canvas
        ref={ref}
        className={styles.canvas}
        tabIndex={0}
        data-simulator-canvas=""
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => endPointer(event, true)}
        onPointerCancel={(event) => endPointer(event, true)}
        onLostPointerCapture={(event) => endPointer(event, false)}
        onKeyDown={onKey}
        onKeyUp={onKey}
      />
    );
  },
);
