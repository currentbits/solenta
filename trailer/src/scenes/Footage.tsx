import { AbsoluteFill, staticFile, useVideoConfig } from "remotion";
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
  const { durationInFrames } = useVideoConfig();
  const src = `footage/${name}.mp4`;
  const hasFile = mediaExists(src);

  return (
    <AbsoluteFill style={{ background: colors.bg }}>
      {hasFile ? (
        <Video
          src={staticFile(src)}
          muted
          objectFit="contain"
          style={{
            width: "100%",
            height: "100%",
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
      {title ? (
        <TitleCard text={title} durationInFrames={durationInFrames} />
      ) : null}
    </AbsoluteFill>
  );
};
