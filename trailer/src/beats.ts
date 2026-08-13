export const FPS = 30;
export const WIDTH = 1080;
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
  terminals: { name: "terminals", from: 0, durationInFrames: 90 },
  collapse: { name: "collapse", from: 90, durationInFrames: 90 },
  sidebar: { name: "sidebar", from: 180, durationInFrames: 210 },
  pipeline: { name: "pipeline", from: 390, durationInFrames: 300 },
  pr: { name: "pr", from: 690, durationInFrames: 150 },
  end: { name: "end", from: 840, durationInFrames: 120 },
};
