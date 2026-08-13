import { Composition } from "remotion";
import { Launch } from "./Launch";
import { FPS, HEIGHT, TOTAL_FRAMES, WIDTH } from "./beats";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Launch"
      component={Launch}
      durationInFrames={TOTAL_FRAMES}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
    />
  );
};
