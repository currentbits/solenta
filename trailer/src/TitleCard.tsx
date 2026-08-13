import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { fontFamily } from "./fonts";
import { colors, EASE } from "./theme";

export const TitleCard: React.FC<{
  text: string;
  durationInFrames?: number;
}> = ({ text, durationInFrames: durationOverride }) => {
  const frame = useCurrentFrame();
  const { durationInFrames: compDuration } = useVideoConfig();
  const durationInFrames = durationOverride ?? compDuration;
  const fadeIn = interpolate(frame, [0, 8], [1, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(...EASE),
  });
  const fadeOut = interpolate(
    frame,
    [durationInFrames - 6, durationInFrames],
    [1, 0],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    },
  );
  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
        paddingBottom: 120,
        opacity: fadeIn * fadeOut,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          fontFamily,
          fontSize: 80,
          fontWeight: 600,
          color: colors.text,
          letterSpacing: "-0.03em",
          textAlign: "center",
          textShadow: "0 8px 40px rgba(0,0,0,0.65)",
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};
