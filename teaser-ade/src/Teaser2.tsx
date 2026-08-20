import { loadFont } from "@remotion/google-fonts/Inter";
import { Audio } from "@remotion/media";
import type { ReactNode } from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

const { fontFamily } = loadFont("normal", {
  weights: ["500", "600", "700"],
  subsets: ["latin"],
});

const BG = "#0b0e14";
const TEXT = "#e8ecf4";
const BLUE = "#3b82f6";
const TOTAL = 1200;
const LOCKUP_START = 1072;

type Plate =
  | "main"
  | "agents"
  | "pulse"
  | "fleet"
  | "usage"
  | "insights"
  | "memory"
  | "planboard"
  | "git";

type Beat = {
  from: number;
  to: number;
  plate: Plate;
  scale: [number, number];
  rotY: [number, number];
  rotX: [number, number];
  tx: [number, number];
  ty: [number, number];
  copy?: string;
};

// Cuts on the score's 128 BPM bar grid (bar 0 at 2.0s, bar = 1.875s = 56.25
// frames). Two bars per scene, one bar each for planboard/git so the editing
// accelerates into the finale downbeat at bar 18 (35.75s).
const BEATS: Beat[] = [
  {
    from: 60,
    to: 172,
    plate: "main",
    scale: [2.55, 1.06],
    rotY: [24, -5],
    rotX: [12, 2],
    tx: [40, 0],
    ty: [90, 8],
  },
  {
    from: 172,
    to: 285,
    plate: "main",
    scale: [1.06, 1.8],
    rotY: [-5, 9],
    rotX: [2, 1],
    tx: [0, 380],
    ty: [8, 60],
    copy: "One window. Every agent.",
  },
  {
    from: 285,
    to: 398,
    plate: "agents",
    scale: [1.55, 1.85],
    rotY: [-14, -8],
    rotX: [3, 1],
    tx: [-460, -520],
    ty: [0, -20],
    copy: "Watch the work.",
  },
  {
    from: 398,
    to: 510,
    plate: "pulse",
    scale: [1.5, 1.8],
    rotY: [-12, -5],
    rotX: [3, 1],
    tx: [-700, -850],
    ty: [350, 430],
    copy: "Take the pulse.",
  },
  {
    from: 510,
    to: 622,
    plate: "fleet",
    // deep zoom: keeps the felt-vs-actual headline + tables, crops the
    // "no reviewed PRs" banner above them out of frame
    scale: [1.95, 2.2],
    rotY: [10, 4],
    rotX: [2, 1],
    tx: [270, 310],
    ty: [8, 12],
    copy: "Measure the fleet.",
  },
  {
    from: 622,
    to: 735,
    plate: "usage",
    scale: [1.4, 1.65],
    rotY: [-8, -2],
    rotX: [2, 1],
    tx: [560, 680],
    ty: [420, 520],
    copy: "Every token accounted.",
  },
  {
    from: 735,
    to: 848,
    plate: "insights",
    scale: [1.3, 1.55],
    rotY: [7, 2],
    rotX: [2, 1],
    tx: [40, 70],
    ty: [280, 350],
    copy: "Failure modes, surfaced.",
  },
  {
    from: 848,
    to: 960,
    plate: "memory",
    scale: [1.45, 1.7],
    rotY: [-10, -4],
    rotX: [2, 1],
    tx: [-650, -780],
    ty: [340, 420],
    copy: "Memory that carries over.",
  },
  {
    from: 960,
    to: 1016,
    plate: "planboard",
    scale: [1.22, 1.42],
    rotY: [8, -2],
    rotX: [2, 1],
    tx: [40, 0],
    ty: [20, 0],
    copy: "The plan is the board.",
  },
  {
    from: 1016,
    to: 1072,
    plate: "git",
    scale: [1.38, 1.58],
    rotY: [-6, 4],
    rotX: [2, 1],
    tx: [-40, 20],
    ty: [-10, 0],
    copy: "Land it.",
  },
  {
    from: 1072,
    to: TOTAL,
    plate: "main",
    scale: [1.42, 0.82],
    rotY: [4, -8],
    rotX: [1, 6],
    tx: [20, 0],
    ty: [0, 20],
  },
];

const ease = Easing.bezier(0.16, 1, 0.3, 1);

function lerp(
  frame: number,
  from: number,
  to: number,
  a: number,
  b: number,
): number {
  return interpolate(frame, [from, to], [a, b], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });
}

function currentBeat(frame: number): Beat {
  for (let i = BEATS.length - 1; i >= 0; i--) {
    if (frame >= BEATS[i].from) return BEATS[i];
  }
  return BEATS[0];
}

function cutFlash(frame: number): number {
  const cuts = [60, 172, 285, 398, 510, 622, 735, 848, 960, 1016, 1072];
  let v = 0;
  for (const c of cuts) {
    if (frame >= c && frame < c + 5) {
      v = Math.max(v, interpolate(frame, [c, c + 5], [0.55, 0], {
        extrapolateRight: "clamp",
      }));
    }
  }
  return v;
}

const Diamond = ({
  size,
  progress,
  glow,
}: {
  size: number;
  progress: number;
  glow: number;
}) => {
  const pad = 80;
  const vb = 1024;
  const path = "M512 236 L788 512 L512 788 L236 512 Z";
  const len = 1560;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${vb} ${vb}`}
      style={{
        filter: `drop-shadow(0 0 ${18 + glow * 40}px rgba(59,130,246,0.85))`,
      }}
    >
      <rect
        x={pad / 2}
        y={pad / 2}
        width={vb - pad}
        height={vb - pad}
        rx={164}
        fill="none"
        stroke="rgba(35,42,56,0.9)"
        strokeWidth={8}
        opacity={progress}
      />
      <path
        d={path}
        fill="none"
        stroke={BLUE}
        strokeWidth={56}
        strokeLinejoin="round"
        strokeDasharray={len}
        strokeDashoffset={len * (1 - progress)}
      />
    </svg>
  );
};

const MacChrome = ({ children }: { children: ReactNode }) => {
  return (
    <div
      style={{
        background: "#10151f",
        borderRadius: 14,
        border: "1px solid #2a3242",
        overflow: "hidden",
        boxShadow:
          "0 40px 120px rgba(0,0,0,0.62), 0 0 80px rgba(59,130,246,0.16)",
      }}
    >
      <div
        style={{
          height: 38,
          display: "flex",
          alignItems: "center",
          padding: "0 14px",
          gap: 10,
          borderBottom: "1px solid #2a3242",
          background: "#0d121b",
        }}
      >
        <span style={{ width: 10, height: 10, borderRadius: 99, background: "#f87171" }} />
        <span style={{ width: 10, height: 10, borderRadius: 99, background: "#fbbf24" }} />
        <span style={{ width: 10, height: 10, borderRadius: 99, background: "#34d399" }} />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginLeft: 8,
            color: TEXT,
            fontFamily,
            fontSize: 13,
            fontWeight: 600,
            letterSpacing: "-0.02em",
          }}
        >
          <Img src={staticFile("logo.svg")} style={{ width: 16, height: 16 }} />
          Solenta
        </div>
      </div>
      {children}
    </div>
  );
};

const Twin = ({ beat, frame }: { beat: Beat; frame: number }) => {
  const scale = lerp(frame, beat.from, beat.to, beat.scale[0], beat.scale[1]);
  const rotY = lerp(frame, beat.from, beat.to, beat.rotY[0], beat.rotY[1]);
  const rotX = lerp(frame, beat.from, beat.to, beat.rotX[0], beat.rotX[1]);
  const tx = lerp(frame, beat.from, beat.to, beat.tx[0], beat.tx[1]);
  const ty = lerp(frame, beat.from, beat.to, beat.ty[0], beat.ty[1]);
  const enter = interpolate(frame, [50, 72], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        perspective: 1600,
        opacity: enter,
      }}
    >
      <div
        style={{
          width: 1680,
          transform: `translate(${tx}px, ${ty}px) rotateX(${rotX}deg) rotateY(${rotY}deg) scale(${scale})`,
          transformStyle: "preserve-3d",
        }}
      >
        <MacChrome>
          <Img
            src={staticFile(`plates/${beat.plate}.png`)}
            style={{ width: 1680, height: "auto", display: "block" }}
          />
        </MacChrome>
      </div>
    </div>
  );
};

const CopyCard = ({ text, local }: { text: string; local: number }) => {
  const op = interpolate(local, [4, 14, 70], [0, 1, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const y = interpolate(local, [4, 16], [18, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });
  return (
    <div
      style={{
        position: "absolute",
        left: 80,
        right: 80,
        bottom: 72,
        display: "flex",
        justifyContent: "center",
        opacity: op,
        translate: `0 ${y}px`,
      }}
    >
      <div
        style={{
          fontFamily,
          fontSize: 56,
          fontWeight: 650,
          letterSpacing: "-0.04em",
          color: TEXT,
          background: "rgba(11,14,20,0.72)",
          border: "1px solid rgba(59,130,246,0.35)",
          padding: "16px 28px",
          borderRadius: 12,
          backdropFilter: "blur(10px)",
        }}
      >
        {text}
      </div>
    </div>
  );
};

const LogoScene = ({ frame }: { frame: number }) => {
  const draw = interpolate(frame, [0, 38], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });
  const word = interpolate(frame, [22, 40], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const hold = interpolate(frame, [52, 70], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const scale = interpolate(frame, [0, 40], [0.86, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });
  return (
    <AbsoluteFill
      style={{
        alignItems: "center",
        justifyContent: "center",
        opacity: hold,
        gap: 28,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ scale }}>
        <Diamond size={280} progress={draw} glow={draw} />
      </div>
      <div
        style={{
          fontFamily,
          fontSize: 72,
          fontWeight: 650,
          letterSpacing: "-0.06em",
          color: TEXT,
          opacity: word,
        }}
      >
        Solenta
      </div>
    </AbsoluteFill>
  );
};

const Lockup = ({ frame }: { frame: number }) => {
  const local = frame - LOCKUP_START;
  if (local < 0) return null;
  const op = interpolate(local, [18, 36], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const y = interpolate(local, [18, 40], [16, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });
  return (
    <AbsoluteFill
      style={{
        alignItems: "center",
        justifyContent: "center",
        display: "flex",
        flexDirection: "column",
        gap: 18,
        opacity: op,
        translate: `0 ${y}px`,
        background:
          "linear-gradient(180deg, rgba(11,14,20,0.15) 0%, rgba(11,14,20,0.55) 100%)",
      }}
    >
      <Diamond size={120} progress={1} glow={0.6} />
      <div
        style={{
          fontFamily,
          fontSize: 88,
          fontWeight: 650,
          letterSpacing: "-0.055em",
          color: TEXT,
        }}
      >
        Solenta
      </div>
      <div
        style={{
          fontFamily,
          fontSize: 36,
          fontWeight: 500,
          color: "#98a1b3",
          letterSpacing: "-0.03em",
          maxWidth: 980,
          textAlign: "center",
          lineHeight: 1.2,
        }}
      >
        Every agent starts where the last one stopped.
      </div>
      <div
        style={{
          fontFamily,
          fontSize: 28,
          fontWeight: 600,
          color: BLUE,
          marginTop: 8,
          letterSpacing: "-0.02em",
        }}
      >
        solenta.app
      </div>
    </AbsoluteFill>
  );
};

const Grid = ({ frame }: { frame: number }) => {
  const drift = interpolate(frame, [0, TOTAL], [0, -120]);
  return (
    <div
      style={{
        position: "absolute",
        inset: -240,
        backgroundImage:
          "linear-gradient(rgba(59,130,246,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(59,130,246,0.06) 1px, transparent 1px)",
        backgroundSize: "72px 72px",
        translate: `0 ${drift}px`,
        maskImage:
          "radial-gradient(ellipse at center, rgba(0,0,0,0.55), transparent 72%)",
      }}
    />
  );
};

export const Teaser2 = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const beat = currentBeat(frame);
  const flash = cutFlash(frame);
  const copyLocal = frame - beat.from;

  return (
    <AbsoluteFill style={{ background: BG, fontFamily }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(ellipse at 50% 42%, rgba(59,130,246,0.16), transparent 58%)",
        }}
      />
      <Grid frame={frame} />
      <Twin beat={beat} frame={frame} />
      <LogoScene frame={frame} />
      {beat.copy && frame >= beat.from && frame < beat.to ? (
        <CopyCard text={beat.copy} local={copyLocal} />
      ) : null}
      <Lockup frame={frame} />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `rgba(180, 210, 255, ${flash})`,
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          boxShadow: "inset 0 0 180px rgba(0,0,0,0.55)",
          pointerEvents: "none",
        }}
      />
      <Audio
        src={staticFile("score2.mp3")}
        volume={(f) =>
          interpolate(f, [0, 8, 39 * fps, 40 * fps], [1, 1, 1, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          })
        }
      />
    </AbsoluteFill>
  );
};
