export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;
export const TOTAL_FRAMES = 960;

export type BeatName =
  | "terminals"
  | "collapse"
  | "sidebar"
  | "pipeline"
  | "pr"
  | "end";

export type Beat = {
  name: BeatName;
  from: number;
  durationInFrames: number;
};

export const BEATS: Record<BeatName, Beat> = {
  terminals: { name: "terminals", from: 0, durationInFrames: 75 },
  collapse: { name: "collapse", from: 75, durationInFrames: 75 },
  sidebar: { name: "sidebar", from: 150, durationInFrames: 180 },
  pipeline: { name: "pipeline", from: 330, durationInFrames: 420 },
  pr: { name: "pr", from: 750, durationInFrames: 120 },
  end: { name: "end", from: 870, durationInFrames: 90 },
};
