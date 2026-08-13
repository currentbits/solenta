import { AbsoluteFill, useCurrentFrame } from "remotion";
import { TitleCard } from "../TitleCard";
import { colors, COPY } from "../theme";
import { TerminalWindow } from "./TerminalWindow";
import { TERMINALS, TERMINAL_SIZE } from "./terminalsData";

export const Terminals: React.FC = () => {
  const frame = useCurrentFrame();
  const cursorOn = frame % 20 < 12;

  return (
    <AbsoluteFill style={{ background: colors.bg }}>
      {TERMINALS.map((term) => (
        <div
          key={term.id}
          style={{
            position: "absolute",
            left: term.left,
            top: term.top,
            rotate: `${term.rotate}deg`,
          }}
        >
          <TerminalWindow
            title={term.title}
            prompt={term.prompt}
            lines={term.lines}
            cursorOn={cursorOn}
            width={TERMINAL_SIZE.width}
            height={TERMINAL_SIZE.height}
          />
        </div>
      ))}
      <TitleCard text={COPY.terminals} durationInFrames={90} />
    </AbsoluteFill>
  );
};
