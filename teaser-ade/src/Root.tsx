import "./index.css";
import { Composition } from "remotion";
import { Teaser } from "./Teaser";
import { Teaser2 } from "./Teaser2";
import { Reel, REEL_FRAMES } from "./Reel";

export const RemotionRoot = () => {
  return (
    <>
      <Composition
        id="SolentaTeaser"
        component={Teaser}
        durationInFrames={750}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="SolentaTeaser2"
        component={Teaser2}
        durationInFrames={1200}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="SolentaReel"
        component={Reel}
        durationInFrames={REEL_FRAMES}
        fps={30}
        width={1920}
        height={1080}
      />
    </>
  );
};
