import "./index.css";
import { Composition } from "remotion";
import { Teaser } from "./Teaser";

export const RemotionRoot = () => {
  return (
    <Composition
      id="SolentaTeaser"
      component={Teaser}
      durationInFrames={750}
      fps={30}
      width={1920}
      height={1080}
    />
  );
};
