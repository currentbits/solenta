import { AbsoluteFill, interpolate, Sequence, staticFile } from "remotion";
import { Audio } from "@remotion/media";
import { BEATS } from "./beats";
import { Collapse } from "./scenes/Collapse";
import { EndCard } from "./scenes/EndCard";
import { Footage } from "./scenes/Footage";
import { Terminals } from "./scenes/Terminals";
import { colors, COPY } from "./theme";

function titleDuck(frame: number): number {
  const fadeIn = interpolate(frame, [0, 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const fadeOut = interpolate(frame, [930, 960], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const onTitle =
    (frame >= BEATS.terminals.from &&
      frame < BEATS.terminals.from + BEATS.terminals.durationInFrames) ||
    (frame >= BEATS.sidebar.from &&
      frame < BEATS.sidebar.from + BEATS.sidebar.durationInFrames) ||
    (frame >= BEATS.pipeline.from &&
      frame < BEATS.pipeline.from + BEATS.pipeline.durationInFrames);
  const level = onTitle ? 0.55 : 0.75;
  return fadeIn * fadeOut * level;
}

export const Launch: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: colors.bg }}>
      <Sequence
        premountFor={30}
        from={BEATS.terminals.from}
        durationInFrames={BEATS.terminals.durationInFrames}
      >
        <Terminals />
      </Sequence>
      <Sequence
        premountFor={30}
        from={BEATS.collapse.from}
        durationInFrames={BEATS.collapse.durationInFrames}
      >
        <Collapse />
      </Sequence>
      <Sequence
        premountFor={30}
        from={BEATS.sidebar.from}
        durationInFrames={BEATS.sidebar.durationInFrames}
      >
        <Footage
          name="sidebar"
          objectPosition="left center"
          title={COPY.window}
        />
      </Sequence>
      <Sequence
        premountFor={30}
        from={BEATS.pipeline.from}
        durationInFrames={BEATS.pipeline.durationInFrames}
      >
        <Footage
          name="pipeline"
          objectPosition="center center"
          title={COPY.agents}
        />
      </Sequence>
      <Sequence
        premountFor={30}
        from={BEATS.pr.from}
        durationInFrames={BEATS.pr.durationInFrames}
      >
        <Footage name="pr" objectPosition="left center" />
      </Sequence>
      <Sequence
        premountFor={30}
        from={BEATS.end.from}
        durationInFrames={BEATS.end.durationInFrames}
      >
        <EndCard />
      </Sequence>
      <Audio src={staticFile("audio/bed.wav")} volume={(f) => titleDuck(f)} />
      <Sequence from={BEATS.collapse.from} durationInFrames={30} layout="none">
        <Audio src="https://remotion.media/whoosh.wav" volume={0.45} />
      </Sequence>
      <Sequence from={BEATS.sidebar.from + 45} durationInFrames={15} layout="none">
        <Audio src="https://remotion.media/mouse-click.wav" volume={0.35} />
      </Sequence>
    </AbsoluteFill>
  );
};
