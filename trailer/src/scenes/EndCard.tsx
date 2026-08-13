import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { fontFamily } from "../fonts";
import { colors, COPY, EASE } from "../theme";

export const EndCard: React.FC = () => {
  const frame = useCurrentFrame();
  const enter = interpolate(frame, [0, 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(...EASE),
  });

  return (
    <AbsoluteFill
      style={{
        background: colors.bg,
        justifyContent: "center",
        alignItems: "center",
        opacity: enter,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 28,
        }}
      >
        <Img src={staticFile("icon.svg")} style={{ width: 180, height: 180 }} />
        <div
          style={{
            fontFamily,
            fontSize: 88,
            fontWeight: 600,
            color: colors.text,
            letterSpacing: "-0.04em",
          }}
        >
          {COPY.name}
        </div>
        <div
          style={{
            width: 64,
            height: 2,
            background: colors.blue,
            borderRadius: 2,
          }}
        />
        <div
          style={{
            fontFamily,
            fontSize: 28,
            fontWeight: 500,
            color: colors.muted,
            letterSpacing: "-0.01em",
          }}
        >
          {COPY.tag}
        </div>
      </div>
    </AbsoluteFill>
  );
};
