import { AbsoluteFill, interpolate, staticFile, useCurrentFrame } from "remotion";
import { Video } from "@remotion/media";
import { mediaExists } from "../mediaExists";
import { fontFamily } from "../fonts";
import { TitleCard } from "../TitleCard";
import { colors } from "../theme";

export const Footage: React.FC<{
  name: "sidebar" | "pipeline" | "pr";
  objectPosition: string;
  title?: string;
}> = ({ name, objectPosition, title }) => {
  const frame = useCurrentFrame();
  const src = `footage/${name}.mp4`;
  const hasFile = mediaExists(src);
  const scale = interpolate(frame, [0, 300], [1, 1.03], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ background: colors.bg }}>
      <AbsoluteFill
        style={{
          scale,
        }}
      >
        {hasFile ? (
          <Video
            src={staticFile(src)}
            muted
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              objectPosition,
            }}
          />
        ) : (
          <AbsoluteFill
            style={{
              background: colors.card,
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <div
              style={{
                fontFamily,
                fontSize: 32,
                color: colors.muted,
              }}
            >
              {src}
            </div>
          </AbsoluteFill>
        )}
      </AbsoluteFill>
      {title ? <TitleCard text={title} durationInFrames={300} /> : null}
    </AbsoluteFill>
  );
};
