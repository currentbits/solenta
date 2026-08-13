import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";
import { colors, EASE } from "../theme";
import { TerminalWindow } from "./TerminalWindow";
import {
  TERMINALS,
  TERMINAL_SIZE,
  WINDOW_INSET,
  WINDOW_SIZE,
} from "./terminalsData";

const HERO = 18;

export const Collapse: React.FC = () => {
  const frame = useCurrentFrame();
  const t = interpolate(frame, [0, HERO], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(...EASE),
  });
  const chrome = interpolate(frame, [14, 32], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(...EASE),
  });
  const termsFade = interpolate(frame, [10, 22], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ background: colors.bg }}>
      {TERMINALS.map((term) => {
        const left = interpolate(t, [0, 1], [term.left, WINDOW_INSET]);
        const top = interpolate(t, [0, 1], [term.top, WINDOW_INSET]);
        const width = interpolate(t, [0, 1], [TERMINAL_SIZE.width, WINDOW_SIZE]);
        const height = interpolate(t, [0, 1], [TERMINAL_SIZE.height, WINDOW_SIZE]);
        const rotate = interpolate(t, [0, 1], [term.rotate, 0]);
        return (
          <div
            key={term.id}
            style={{
              position: "absolute",
              left,
              top,
              opacity: termsFade,
              rotate: `${rotate}deg`,
            }}
          >
            <TerminalWindow
              title={term.title}
              prompt={term.prompt}
              lines={term.lines}
              cursorOn={false}
              width={width}
              height={height}
            />
          </div>
        );
      })}
      <div
        style={{
          position: "absolute",
          left: WINDOW_INSET,
          top: WINDOW_INSET,
          width: WINDOW_SIZE,
          height: WINDOW_SIZE,
          opacity: chrome,
          background: colors.bg,
          border: `1px solid ${colors.border}`,
          borderRadius: 10,
          overflow: "hidden",
          display: "grid",
          gridTemplateColumns: "300px minmax(0, 1fr) 380px",
          boxShadow: "0 18px 50px rgba(0,0,0,0.55)",
        }}
      >
        <div style={{ background: "#10151f", borderRight: `1px solid ${colors.border}` }} />
        <div style={{ background: colors.bg }} />
        <div style={{ background: "#10151f", borderLeft: `1px solid ${colors.border}` }} />
      </div>
    </AbsoluteFill>
  );
};
