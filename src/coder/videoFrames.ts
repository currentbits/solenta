import type { AttachmentInfo } from "../shared/ipc";

/**
 * Screen-recording attachments (#266). Chromium's own <video> decodes the
 * clip; sampled frames become ordinary image attachments labelled
 * "clip.mov @ 0:03", so the runner's existing per-provider image routing
 * carries them. The clip itself stays a kind=file chip.
 */
const VIDEO_EXTS = new Set(["mp4", "m4v", "mov", "webm"]);
const MAX_FRAMES = 8;
const FRAME_WIDTH = 1280;
const WAIT_MS = 10_000;

export function isVideoName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot >= 0 && VIDEO_EXTS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * About one frame a second, capped, each centred in its slice so the first
 * frame is not the black pre-roll. Unknown duration (MediaRecorder webm
 * reports Infinity) takes the first frame only.
 */
export function frameTimes(duration: number, max = MAX_FRAMES): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return [0];
  const n = Math.min(max, Math.max(1, Math.ceil(duration)));
  return Array.from({ length: n }, (_, i) => ((i + 0.5) * duration) / n);
}

export function formatAt(t: number): string {
  const s = Math.floor(t);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Desktop: stream a picked/dropped path through the media protocol. */
export function localVideoUrl(path: string): string {
  return `solenta-media://local/?p=${encodeURIComponent(path)}`;
}

function waitFor(video: HTMLVideoElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (err?: Error) => {
      clearTimeout(timer);
      video.removeEventListener(event, ok);
      video.removeEventListener("error", fail);
      if (err) reject(err);
      else resolve();
    };
    const ok = () => done();
    const fail = () => done(new Error("video decode failed"));
    const timer = setTimeout(() => done(new Error("video timed out")), WAIT_MS);
    video.addEventListener(event, ok);
    video.addEventListener("error", fail);
  });
}

async function sampleFrames(
  src: string,
): Promise<{ at: string; dataUrl: string }[]> {
  const video = document.createElement("video");
  // solenta-media is cross-origin to the renderer; without CORS the canvas
  // taints and toDataURL throws.
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.preload = "auto";
  const loaded = waitFor(video, "loadeddata");
  video.src = src;
  try {
    await loaded;
    const scale = Math.min(1, FRAME_WIDTH / video.videoWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx || !canvas.width || !canvas.height) return [];
    const out: { at: string; dataUrl: string }[] = [];
    for (const t of frameTimes(video.duration)) {
      const seeked = waitFor(video, "seeked");
      video.currentTime = t;
      await seeked;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      out.push({ at: formatAt(t), dataUrl: canvas.toDataURL("image/jpeg", 0.85) });
    }
    return out;
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

/**
 * Sampled frames of one clip as saved, labelled image attachments. Never
 * throws: an undecodable clip (codec, timeout) just yields no frames.
 */
export async function videoFrameAttachments(
  name: string,
  src: string,
  saveImage: (dataUrl: string) => Promise<AttachmentInfo | null>,
): Promise<AttachmentInfo[]> {
  let frames: { at: string; dataUrl: string }[];
  try {
    frames = await sampleFrames(src);
  } catch {
    return [];
  }
  const out: AttachmentInfo[] = [];
  for (const frame of frames) {
    const saved = await saveImage(frame.dataUrl);
    if (saved) out.push({ ...saved, name: `${name} @ ${frame.at}` });
  }
  return out;
}

/** Desktop picks/drops: follow each video chip with its frames. */
export async function withVideoFrames(
  items: AttachmentInfo[],
  saveImage: (dataUrl: string) => Promise<AttachmentInfo | null>,
): Promise<AttachmentInfo[]> {
  const out: AttachmentInfo[] = [];
  for (const item of items) {
    out.push(item);
    if (item.kind !== "file" || !isVideoName(item.name)) continue;
    out.push(
      ...(await videoFrameAttachments(item.name, localVideoUrl(item.path), saveImage)),
    );
  }
  return out;
}
