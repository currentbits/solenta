import { loadFont } from "@remotion/google-fonts/Geist";
import { loadFont as loadMono } from "@remotion/google-fonts/GeistMono";
import { Audio } from "@remotion/media";
import {
  Brain,
  CheckCircle,
  GitCommit,
  GitFork,
  GitMerge,
  Kanban,
  Lightning,
  RocketLaunch,
} from "@phosphor-icons/react";
import type { CSSProperties, ReactNode } from "react";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
} from "remotion";

const { fontFamily: SANS } = loadFont("normal", {
  weights: ["400", "500", "600", "700", "800"],
  subsets: ["latin"],
});
const { fontFamily: MONO } = loadMono("normal", {
  weights: ["400", "500", "600"],
  subsets: ["latin"],
});

// Brand: paper and ink with one yellow accent (site/style.css). Dark surfaces
// only appear as product artifacts, rebuilt here from the app's own tokens.
const PAPER = "#f5f5f2";
const INK = "#191918";
const YEL = "#f2e51f";
const APP = "#0b0e14";
const SURF = "#111722";
const LINE = "#232a38";
const TXT = "#e8ecf4";
const MUTED = "#8b93a5";
const BLUE = "#3b82f6";
const GREEN = "#34d399";
const AMBER = "#fbbf24";

// Music grid: 112 BPM at 30 fps. 14 bars = 900 frames = 30s exactly.
// scripts/make-reel-score.py builds the score on the same grid.
export const REEL_FRAMES = 900;
const FPS = 30;
const BAR = (30 * 60 * 4) / 112;
const BEAT = BAR / 4;
const at = (bar: number, beat = 0) => bar * BAR + beat * BEAT;

const EXPO = Easing.bezier(0.16, 1, 0.3, 1);
const IN = Easing.bezier(0.7, 0, 0.84, 0);
const INOUT = Easing.bezier(0.65, 0, 0.35, 1);

function ramp(
  f: number,
  a: number,
  b: number,
  from = 0,
  to = 1,
  easing: (t: number) => number = EXPO,
) {
  return interpolate(f, [a, b], [from, to], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing,
  });
}

function pop(f: number, start: number, damping = 11, stiffness = 180, mass = 0.7) {
  if (f < start) return 0;
  return spring({ frame: f - start, fps: FPS, config: { damping, stiffness, mass } });
}

// Kick envelope: 1 on every beat while drums play, decaying in ~4 frames.
function kick(f: number) {
  const drums = (f >= at(2) && f < at(8)) || (f >= at(10) && f < at(12));
  if (!drums) return 0;
  const local = (f - at(2)) % BEAT;
  return Math.exp(-local / 3.2);
}

function shake(f: number, t0: number, amp: number) {
  if (f < t0) return { x: 0, y: 0, r: 0 };
  const d = f - t0;
  const a = amp * Math.exp(-d / 5);
  return { x: a * Math.sin(d * 2.3), y: a * Math.cos(d * 3.1), r: a * 0.04 * Math.sin(d * 1.7) };
}

const SHAKES: [number, number][] = [
  [at(2), 26],
  [at(6), 12],
  [at(10), 30],
  [at(12), 22],
];

// ---------- shared pieces ----------

const DotGrid = ({ f, color, k }: { f: number; color: string; k: number }) => (
  <AbsoluteFill
    style={{
      backgroundImage: `radial-gradient(${color} ${1.4 + k * 0.9}px, transparent 1.6px)`,
      backgroundSize: "48px 48px",
      backgroundPosition: `0 ${-(f * 0.6) % 48}px`,
      opacity: 0.55 + k * 0.35,
      maskImage: "radial-gradient(ellipse at center, #000 30%, transparent 80%)",
    }}
  />
);

const Logo = ({ size, draw = 1 }: { size: number; draw?: number }) => {
  const len = 1560;
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024">
      <rect x="32" y="32" width="960" height="960" rx="180" fill={APP} />
      <rect x="56" y="56" width="912" height="912" rx="164" fill="none" stroke={LINE} strokeWidth="8" />
      <path
        d="M512 236 L788 512 L512 788 L236 512 Z"
        fill="none"
        stroke={BLUE}
        strokeWidth="56"
        strokeLinejoin="round"
        strokeDasharray={len}
        strokeDashoffset={len * (1 - draw)}
        style={{ filter: `drop-shadow(0 0 ${24 * draw}px rgba(59,130,246,0.9))` }}
      />
    </svg>
  );
};

// Yellow marker stripe behind a word, the site's .em highlight.
const Mark = ({ p, children, color = YEL, text }: { p: number; children: ReactNode; color?: string; text?: string }) => (
  <span style={{ position: "relative", display: "inline-block", whiteSpace: "nowrap" }}>
    <span
      style={{
        position: "absolute",
        left: "-0.08em",
        right: "-0.08em",
        top: "0.52em",
        bottom: "0.02em",
        background: color,
        scale: `${p} 1`,
        transformOrigin: "left center",
        borderRadius: 4,
      }}
    />
    <span style={{ position: "relative", color: p > 0.5 && text ? text : undefined }}>{children}</span>
  </span>
);

// Words that land one after another, each with a spring and a blur-in.
const Words = ({
  f,
  words,
  start,
  step,
  style,
}: {
  f: number;
  words: ReactNode[];
  start: number;
  step: number;
  style?: CSSProperties;
}) => (
  <div style={{ display: "flex", flexWrap: "wrap", gap: "0 0.26em", ...style }}>
    {words.map((w, i) => {
      const s = start + i * step;
      const p = pop(f, s, 12, 200, 0.6);
      return (
        <span
          key={i}
          style={{
            display: "inline-block",
            opacity: ramp(f, s, s + 3),
            translate: `0 ${(1 - p) * 60}px`,
            rotate: `${(1 - p) * 6}deg`,
            filter: `blur(${ramp(f, s, s + 5, 10, 0)}px)`,
          }}
        >
          {w}
        </span>
      );
    })}
  </div>
);

const Chip = ({ children, color = MUTED, bg = "rgba(255,255,255,0.04)", style }: { children: ReactNode; color?: string; bg?: string; style?: CSSProperties }) => (
  <span
    style={{
      fontFamily: MONO,
      fontSize: 15,
      color,
      background: bg,
      border: `1px solid ${LINE}`,
      borderRadius: 7,
      padding: "3px 9px",
      ...style,
    }}
  >
    {children}
  </span>
);

const Panel = ({ children, style }: { children: ReactNode; style?: CSSProperties }) => (
  <div
    style={{
      background: SURF,
      border: `1px solid ${LINE}`,
      borderRadius: 14,
      ...style,
    }}
  >
    {children}
  </div>
);

// ---------- scene 1: intro (bars 0-2) ----------

const PROVIDERS = ["claude", "codex", "grok", "kimi"];

const Intro = ({ f }: { f: number }) => {
  const zoom = ramp(f, at(1, 3), at(2), 1, 4.2, IN);
  const blur = ramp(f, at(1, 3.2), at(2), 0, 14, IN);
  const beat = Math.floor(f / BEAT);
  return (
    <AbsoluteFill style={{ background: PAPER }}>
      <DotGrid f={f} color="rgba(25,25,24,0.22)" k={0} />
      <AbsoluteFill style={{ scale: zoom, filter: `blur(${blur}px)`, alignItems: "center", justifyContent: "center" }}>
        {beat < 4 ? (
          <ProviderSlam f={f} i={beat} />
        ) : (
          <Forgets f={f} />
        )}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const ProviderSlam = ({ f, i }: { f: number; i: number }) => {
  const s = i * BEAT;
  const p = pop(f, s, 10, 260, 0.5);
  const mark = ramp(f, s + 2, s + 8);
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontFamily: MONO, fontSize: 28, color: "#6b6b66", letterSpacing: "0.2em", marginBottom: 18, opacity: ramp(f, s + 1, s + 4) }}>
        AGENT 0{i + 1}
      </div>
      <div
        style={{
          fontFamily: MONO,
          fontWeight: 600,
          fontSize: 230,
          color: INK,
          letterSpacing: "-0.06em",
          scale: 1.5 - 0.5 * p,
          filter: `blur(${ramp(f, s, s + 4, 12, 0)}px)`,
        }}
      >
        <Mark p={mark}>{PROVIDERS[i]}</Mark>
      </div>
    </div>
  );
};

const Forgets = ({ f }: { f: number }) => {
  const strike = ramp(f, at(1, 3), at(1, 3.6), 0, 1, INOUT);
  return (
    <div style={{ fontFamily: SANS, fontWeight: 800, color: INK, letterSpacing: "-0.055em", lineHeight: 0.95, textAlign: "center" }}>
      <Words f={f} words={["Every", "agent"]} start={at(1, 0)} step={BEAT} style={{ fontSize: 170, justifyContent: "center" }} />
      <div style={{ position: "relative", display: "inline-block", fontSize: 250 }}>
        <Words f={f} words={["forgets."]} start={at(1, 2)} step={BEAT} />
        <div
          style={{
            position: "absolute",
            left: -20,
            right: -20,
            top: "54%",
            height: 26,
            background: YEL,
            mixBlendMode: "multiply",
            scale: `${strike} 1`,
            transformOrigin: "left",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: -20,
            right: -20,
            top: "52%",
            height: 14,
            background: INK,
            scale: `${strike} 1`,
            transformOrigin: "left",
          }}
        />
      </div>
    </div>
  );
};

// ---------- scene 2: drop A, brand + app assembles (bars 2-6) ----------

const THREADS = [
  { repo: "acme/nebula", title: "Modernize per-device provider settings", branch: "feat/provider-settings", pr: "#842", who: "claude", status: "Working", color: BLUE },
  { repo: "acme/nebula", title: "Fix worktree path resolution on Windows", branch: "fix/win-worktree", pr: "#839", who: "codex", status: "Done", color: GREEN },
  { repo: "acme/ledger", title: "Add INTEGER-SAFARI workflow runner", branch: "feat/integer-safari", pr: "#112", who: "kimi", status: "Stalled", color: AMBER },
  { repo: "acme/ledger", title: "Tighten CSP for Electron preload", branch: "chore/csp", pr: "", who: "grok", status: "Queued", color: MUTED },
];

const BrandSlam = ({ f }: { f: number }) => {
  const s = at(2);
  const p = pop(f, s, 9, 220, 0.8);
  const away = ramp(f, at(3), at(3, 1.2), 0, 1, INOUT);
  const letters = "Solenta".split("");
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: 1 - away, scale: 1 - away * 0.4, translate: `0 ${-away * 260}px` }}>
      {[0, 1, 2, 3].map((i) => {
        const r = ramp(f, s + i * BEAT, s + i * BEAT + 22, 0, 1);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              width: 300,
              height: 300,
              borderRadius: "50%",
              border: `${6 * (1 - r)}px solid ${i % 2 ? INK : YEL}`,
              scale: 1 + r * 4,
              opacity: (1 - r) * 0.7,
              translate: "0 -170px",
            }}
          />
        );
      })}
      <div style={{ translate: "0 -120px", scale: p, rotate: `${(1 - p) * -120}deg` }}>
        <Logo size={250} draw={ramp(f, s + 2, s + 18)} />
      </div>
      <div style={{ display: "flex", fontFamily: SANS, fontWeight: 800, fontSize: 190, letterSpacing: "-0.06em", color: INK, marginTop: 0, translate: "0 40px" }}>
        {letters.map((l, i) => {
          const lp = pop(f, s + 4 + i * 1.6, 11, 240, 0.55);
          return (
            <span key={i} style={{ display: "inline-block", translate: `0 ${(1 - lp) * 120}px`, opacity: ramp(f, s + 4 + i * 1.6, s + 7 + i * 1.6), rotate: `${(1 - lp) * 18}deg` }}>
              {l}
            </span>
          );
        })}
      </div>
      <div style={{ fontFamily: SANS, fontWeight: 500, fontSize: 44, color: "#55554f", letterSpacing: "-0.02em", translate: "0 44px" }}>
        <Words f={f} words={["Every", "coding", "agent,", "one", "desktop", "app."]} start={at(2, 2)} step={2.2} />
      </div>
    </AbsoluteFill>
  );
};

const ThreadCard = ({ t, f, s, active }: { t: (typeof THREADS)[number]; f: number; s: number; active: boolean }) => {
  const p = pop(f, s, 12, 220, 0.6);
  const badge = pop(f, s + 5, 8, 300, 0.4);
  const working = t.status === "Working";
  return (
    <div
      style={{
        opacity: ramp(f, s, s + 3),
        translate: `${(1 - p) * -120}px 0`,
        scale: 0.9 + 0.1 * p,
        background: active ? "rgba(59,130,246,0.1)" : "transparent",
        borderLeft: `3px solid ${active ? BLUE : "transparent"}`,
        borderRadius: 8,
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 5,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", fontFamily: SANS, fontSize: 14, color: MUTED }}>
        <span>{t.repo}</span>
        <span style={{ color: t.color, fontWeight: 600, scale: badge, display: "inline-block" }}>
          {t.status}
          {working ? ` ${Math.floor(ramp(f, s, s + 120, 0, 2, Easing.linear))}m` : ""}
        </span>
      </div>
      <div style={{ fontFamily: SANS, fontSize: 18, fontWeight: 600, color: TXT, letterSpacing: "-0.01em" }}>{t.title}</div>
      <div style={{ display: "flex", justifyContent: "space-between", fontFamily: MONO, fontSize: 13, color: MUTED }}>
        <span>{t.branch}</span>
        <span>
          <span style={{ color: BLUE }}>{t.pr}</span> {t.who}
        </span>
      </div>
    </div>
  );
};

const PLAN = ["Read the provider settings store", "Move per-device overrides to the store", "Backfill the migration test"];
const TABS = ["Environment", "Agents", "Memory", "Skills", "Pulse"];
const SUBAGENTS = ["claude", "codex", "grok", "kimi", "claude"];
const SUBTASKS = ["map storage keys", "draft migration", "audit call sites", "write fixtures", "verify types"];

const AppAssembly = ({ f }: { f: number }) => {
  const k = kick(f);
  const sb = pop(f, at(3, 0), 13, 170, 0.7);
  const mn = pop(f, at(3, 1), 13, 170, 0.7);
  const ins = pop(f, at(3, 2), 13, 170, 0.7);
  const push = ramp(f, at(5), at(6), 0, 1, INOUT);
  const rotX = ramp(f, at(3), at(4, 2), 22, 8) - push * 4;
  const rotY = ramp(f, at(3), at(6), -14, 4, Easing.linear);
  const tab = Math.min(4, Math.max(0, Math.floor((f - at(4)) / BEAT)));
  const tabP = f < at(4) ? 0 : ramp(f, at(4) + tab * BEAT, at(4) + tab * BEAT + 8, 0, 1);
  const tabX = (i: number) => [0, 128, 212, 308, 378][i];
  const tabW = (i: number) => [108, 66, 78, 52, 50][i];
  const prev = Math.max(0, tab - 1);
  const ux = f < at(4) ? 0 : tabX(prev) + (tabX(tab) - tabX(prev)) * tabP;
  const uw = f < at(4) ? tabW(0) : tabW(prev) + (tabW(tab) - tabW(prev)) * tabP;
  const fan = f >= at(5);
  return (
    <AbsoluteFill style={{ perspective: 2200 }}>
      <div
        style={{
          position: "absolute",
          left: 190,
          top: 330,
          width: 1540,
          height: 820,
          display: "flex",
          gap: 14,
          transformStyle: "preserve-3d",
          rotate: `x ${rotX}deg`,
          transform: `rotateY(${rotY}deg) scale(${1 + push * 0.32 + k * 0.006})`,
          transformOrigin: "50% 30%",
          translate: `${-push * 120}px ${-push * 250}px`,
        }}
      >
        {/* sidebar */}
        <div
          style={{
            width: 360,
            background: APP,
            borderRadius: 18,
            border: `1px solid ${LINE}`,
            padding: 14,
            display: "flex",
            flexDirection: "column",
            gap: 6,
            opacity: ramp(f, at(3), at(3) + 4),
            translate: `${(1 - sb) * -300}px 0`,
            boxShadow: "0 40px 90px rgba(25,25,24,0.35)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: SANS, fontWeight: 600, fontSize: 19, color: TXT, padding: "4px 6px 10px" }}>
            <Logo size={26} /> Solenta
          </div>
          <div style={{ fontFamily: SANS, fontSize: 15, color: MUTED, border: `1px solid ${LINE}`, borderRadius: 9, padding: "9px 12px", marginBottom: 8 }}>Search threads...</div>
          {THREADS.map((t, i) => (
            <ThreadCard key={i} t={t} f={f} s={at(3, 2) + i * BEAT} active={i === 0} />
          ))}
        </div>
        {/* main */}
        <div
          style={{
            flex: 1,
            background: APP,
            borderRadius: 18,
            border: `1px solid ${LINE}`,
            padding: "22px 28px",
            opacity: ramp(f, at(3, 1), at(3, 1) + 4),
            translate: `0 ${(1 - mn) * 400}px`,
            display: "flex",
            flexDirection: "column",
            gap: 16,
            boxShadow: "0 40px 90px rgba(25,25,24,0.35)",
            overflow: "hidden",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12, fontFamily: SANS, fontSize: 19 }}>
            <span style={{ fontFamily: MONO, color: MUTED, fontSize: 16 }}>acme/nebula /</span>
            <span style={{ color: TXT, fontWeight: 600 }}>Modernize per-device provider settings</span>
            <span style={{ flex: 1 }} />
            <span style={{ background: "#1d4ed8", color: "#fff", fontWeight: 600, fontSize: 15, padding: "7px 13px", borderRadius: 8 }}>Commit 3 files</span>
          </div>
          <Panel style={{ padding: "16px 20px", opacity: ramp(f, at(4, 0), at(4, 0) + 5), translate: `0 ${ramp(f, at(4, 0), at(4, 0) + 10, 30, 0)}px` }}>
            <div style={{ fontFamily: SANS, fontWeight: 600, fontSize: 18, color: TXT, display: "flex", alignItems: "center", gap: 10 }}>
              <Lightning weight="fill" color={fan ? AMBER : MUTED} size={20} />
              {fan ? "Kicked off 5 subagents" : "Mapping the request against the worktree layout"}
            </div>
            {fan ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 14 }}>
                {SUBAGENTS.map((who, i) => {
                  const s = at(5) + i * (BEAT / 2);
                  const p = pop(f, s, 12, 260, 0.5);
                  const prog = ramp(f, s + 2, s + 40 + i * 9, 0, 1, Easing.bezier(0.3, 0, 0.2, 1));
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 14, opacity: ramp(f, s, s + 3), translate: `${(1 - p) * 90}px 0`, scale: 0.85 + p * 0.15 }}>
                      <Chip color={TXT} style={{ width: 74, textAlign: "center" }}>{who}</Chip>
                      <span style={{ fontFamily: SANS, color: TXT, fontSize: 16, width: 190 }}>{SUBTASKS[i]}</span>
                      <div style={{ flex: 1, height: 8, background: LINE, borderRadius: 9, overflow: "hidden" }}>
                        <div style={{ width: `${prog * 100}%`, height: "100%", background: prog >= 1 ? GREEN : BLUE, borderRadius: 9 }} />
                      </div>
                      <span style={{ fontFamily: MONO, color: prog >= 1 ? GREEN : MUTED, fontSize: 14, width: 44, textAlign: "right" }}>{Math.round(prog * 100)}%</span>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </Panel>
          {!fan ? (
            <Panel style={{ padding: "16px 20px", opacity: ramp(f, at(4, 2), at(4, 2) + 5), translate: `0 ${(1 - pop(f, at(4, 2))) * 50}px` }}>
              <div style={{ fontFamily: SANS, fontSize: 18, color: TXT, fontWeight: 600, marginBottom: 10 }}>
                Plan <span style={{ color: MUTED, fontWeight: 400, fontSize: 16, marginLeft: 8 }}>1/3 done</span>
              </div>
              {PLAN.map((t, i) => (
                <div key={t} style={{ display: "flex", alignItems: "center", gap: 12, padding: "5px 0", fontFamily: SANS, fontSize: 17, color: i ? TXT : MUTED }}>
                  <span style={{ width: 13, height: 13, borderRadius: 9, border: `2px solid ${i ? BLUE : GREEN}`, background: i ? "transparent" : GREEN }} />
                  {t}
                </div>
              ))}
            </Panel>
          ) : null}
          <div
            style={{
              marginTop: "auto",
              display: "flex",
              alignItems: "center",
              gap: 12,
              background: "rgba(59,130,246,0.1)",
              border: "1px solid rgba(59,130,246,0.4)",
              borderRadius: 12,
              padding: "13px 18px",
              fontFamily: SANS,
              fontSize: 17,
              color: TXT,
              opacity: ramp(f, at(5, 3), at(5, 3) + 4),
              scale: 0.9 + 0.1 * pop(f, at(5, 3), 10, 260, 0.5),
            }}
          >
            <span style={{ width: 11, height: 11, borderRadius: 9, background: BLUE, boxShadow: `0 0 ${8 + k * 14}px ${BLUE}` }} />
            4 agents working in the background
            <span style={{ flex: 1 }} />
            <span style={{ color: "#fca5a5", border: "1px solid rgba(248,113,113,0.5)", borderRadius: 8, padding: "5px 12px", fontSize: 15 }}>Stop</span>
          </div>
          <div style={{ border: `1px solid ${LINE}`, borderRadius: 14, padding: "16px 18px", color: MUTED, fontFamily: SANS, fontSize: 16 }}>
            Queue a follow-up, or /btw a side question...
          </div>
        </div>
        {/* inspector */}
        <div
          style={{
            width: 440,
            background: APP,
            borderRadius: 18,
            border: `1px solid ${LINE}`,
            padding: "16px 20px",
            opacity: ramp(f, at(3, 2), at(3, 2) + 4),
            translate: `${(1 - ins) * 300}px 0`,
            boxShadow: "0 40px 90px rgba(25,25,24,0.35)",
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          <div style={{ position: "relative", display: "flex", gap: 20, fontFamily: SANS, fontSize: 16, fontWeight: 600, paddingBottom: 12, borderBottom: `1px solid ${LINE}` }}>
            {TABS.map((t, i) => (
              <span key={t} style={{ color: i === tab && f >= at(4) ? TXT : MUTED }}>
                {t}
              </span>
            ))}
            <span style={{ position: "absolute", bottom: -1, left: ux, width: uw, height: 2, background: BLUE }} />
          </div>
          {[
            ["Repository", "acme/nebula"],
            ["Recap", "Once analyze settles, verify re-runs type checks against the proposed key schema."],
            ["Worktree", "feat/provider-settings, isolated from main"],
          ].map(([h, b], i) => {
            const s = at(4, 1) + i * BEAT;
            const p = pop(f, s, 12, 200, 0.6);
            return (
              <Panel key={h} style={{ padding: "14px 16px", opacity: ramp(f, s, s + 3), translate: `0 ${(1 - p) * 40}px` }}>
                <div style={{ fontFamily: SANS, fontSize: 14, color: MUTED, marginBottom: 6 }}>{h}</div>
                <div style={{ fontFamily: i === 0 ? MONO : SANS, fontSize: 16, color: TXT, lineHeight: 1.4 }}>{b}</div>
              </Panel>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};

const DropA = ({ f }: { f: number }) => {
  const k = kick(f);
  const headOut = ramp(f, at(5), at(5, 1), 0, 1, IN);
  return (
    <AbsoluteFill style={{ background: PAPER }}>
      <DotGrid f={f} color="rgba(25,25,24,0.22)" k={k} />
      {f < at(3, 2) ? <BrandSlam f={f} /> : null}
      {f >= at(3) ? <AppAssembly f={f} /> : null}
      {f >= at(3) ? (
        <div
          style={{
            position: "absolute",
            left: 190,
            top: 92,
            fontFamily: SANS,
            fontWeight: 800,
            fontSize: 120,
            letterSpacing: "-0.055em",
            color: INK,
            lineHeight: 1,
            opacity: 1 - headOut,
            translate: `0 ${-headOut * 80}px`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 18, fontSize: 30, fontWeight: 600, letterSpacing: "-0.02em", marginBottom: 16, opacity: ramp(f, at(3), at(3, 1)) }}>
            <Logo size={40} /> Solenta
          </div>
          <Words
            f={f}
            words={["Every", "agent.", <Mark key="m" p={ramp(f, at(4, 3), at(4, 3) + 8)}>One window.</Mark>]}
            start={at(4, 1)}
            step={BEAT}
          />
        </div>
      ) : null}
      {f >= at(5) ? (
        <div style={{ position: "absolute", right: 130, top: 120, textAlign: "right", fontFamily: SANS, fontWeight: 800, fontSize: 104, letterSpacing: "-0.055em", color: INK, lineHeight: 1, background: PAPER, padding: "26px 40px 34px", borderRadius: 22, boxShadow: `10px 10px 0 ${INK}`, border: `3px solid ${INK}`, scale: pop(f, at(5), 10, 220, 0.6), rotate: `${2 - pop(f, at(5), 10, 220, 0.6) * 4}deg` }}>
          <Words f={f} words={["Fan", "out."]} start={at(5, 0)} step={BEAT / 2} style={{ justifyContent: "flex-end" }} />
          <Words f={f} words={[<Mark key="m" p={ramp(f, at(5, 2.5), at(5, 3))}>In parallel.</Mark>]} start={at(5, 2)} step={BEAT} style={{ justifyContent: "flex-end" }} />
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

// ---------- scene 3: shared memory on the yellow band (bars 6-8) ----------

const MEMS = [
  ["convention", "Pass userDataPath to worktree fixtures"],
  ["gotcha", "grok auto mode cancels bash"],
  ["strategy", "Clean Windows cwd with async rm"],
  ["decision", "Planboard lives in GitHub issues"],
  ["knowledge", "Nightly predates the retention fix"],
];
const AGENT_Y = [200, 330, 460, 590, 720];

const Memory = ({ f }: { f: number }) => {
  const k = kick(f);
  const stackX = 960;
  const stackY = 560;
  const landed = MEMS.filter((_, i) => f >= at(6, 2) + i * (BEAT / 2) + 10).length;
  const lastLand = landed > 0 ? at(6, 2) + (landed - 1) * (BEAT / 2) + 10 : -99;
  const squash = f - lastLand < 10 ? Math.exp(-(f - lastLand) / 3) : 0;
  const a6 = pop(f, at(7, 1), 9, 200, 0.8);
  const beam = ramp(f, at(7, 2), at(7, 3), 0, 1, INOUT);
  const lit = f >= at(7, 3);
  return (
    <AbsoluteFill style={{ background: YEL }}>
      <DotGrid f={f} color="rgba(25,25,24,0.25)" k={k} />
      <div style={{ position: "absolute", left: 150, top: 80, fontFamily: SANS, fontWeight: 800, fontSize: 96, letterSpacing: "-0.055em", color: INK, lineHeight: 1.02 }}>
        <Words f={f} words={["Agent", "six", "starts", "knowing"]} start={at(6, 0)} step={BEAT / 2} />
        <Words
          f={f}
          words={[
            "what",
            "one",
            "through",
            "five",
            <span key="r" style={{ position: "relative", display: "inline-block" }}>
              <span style={{ position: "absolute", inset: "0.06em -0.1em -0.04em", background: INK, scale: `${ramp(f, at(7, 3), at(7, 3) + 7)} 1`, transformOrigin: "left", borderRadius: 6 }} />
              <span style={{ position: "relative", color: f >= at(7, 3) + 3 ? YEL : INK }}>ruled out.</span>
            </span>,
          ]}
          start={at(6, 2)}
          step={BEAT / 2}
        />
      </div>

      <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }}>
        {AGENT_Y.map((y, i) => {
          const s = at(6, 2) + i * (BEAT / 2);
          const p = ramp(f, s - 2, s + 8, 0, 1, INOUT);
          return (
            <path
              key={i}
              d={`M 330 ${y + 240} Q 640 ${y + 240} ${stackX - 250} ${stackY + 80}`}
              fill="none"
              stroke={INK}
              strokeWidth={3}
              strokeDasharray="6 10"
              opacity={0.35 * ramp(f, s - 4, s)}
              strokeDashoffset={-f * 2}
              pathLength={1}
              style={{ strokeDasharray: `${p} 1` }}
            />
          );
        })}
        <path
          d={`M ${stackX + 270} ${stackY + 80} L 1540 ${stackY + 80}`}
          stroke={INK}
          strokeWidth={6}
          strokeLinecap="round"
          pathLength={1}
          strokeDasharray={`${beam} 1`}
        />
      </svg>

      {AGENT_Y.map((y, i) => {
        const s = at(6, 0) + i * (BEAT / 2);
        const p = pop(f, s, 10, 240, 0.6);
        const fire = at(6, 2) + i * (BEAT / 2);
        const flash = f >= fire && f < fire + 6 ? 1 - (f - fire) / 6 : 0;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: 150,
              top: y + 212,
              display: "flex",
              alignItems: "center",
              gap: 14,
              scale: p * (1 + flash * 0.12),
              opacity: ramp(f, s, s + 3),
            }}
          >
            <div style={{ width: 56, height: 56, borderRadius: 16, background: INK, color: YEL, display: "grid", placeItems: "center", fontFamily: MONO, fontWeight: 600, fontSize: 22 }}>
              {i + 1}
            </div>
            <span style={{ fontFamily: MONO, fontSize: 24, fontWeight: 600, color: INK }}>{SUBAGENTS[i]}</span>
          </div>
        );
      })}

      {/* flying memory cards */}
      {MEMS.map(([type, title], i) => {
        const s = at(6, 2) + i * (BEAT / 2);
        const t = ramp(f, s, s + 10, 0, 1, Easing.bezier(0.5, 0, 0.2, 1));
        if (f < s || t >= 1) return null;
        const x0 = 330;
        const y0 = AGENT_Y[i] + 240;
        const x1 = stackX - 250;
        const y1 = stackY + 80;
        const cx = 640;
        const x = (1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * cx + t * t * x1;
        const y = (1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * y0 + t * t * y1;
        return (
          <div key={i} style={{ position: "absolute", left: x, top: y - 22, rotate: `${(1 - t) * -14}deg`, scale: 0.6 + t * 0.4 }}>
            <Chip color={TXT} bg={APP} style={{ fontSize: 16, padding: "8px 12px", borderRadius: 10 }}>
              {type}: {title}
            </Chip>
          </div>
        );
      })}

      {/* the shared memory panel */}
      <div
        style={{
          position: "absolute",
          left: stackX - 250,
          top: stackY - 150,
          width: 520,
          background: APP,
          borderRadius: 18,
          border: `1px solid ${LINE}`,
          padding: "18px 20px",
          boxShadow: "0 30px 70px rgba(25,25,24,0.35)",
          scale: `${1 + squash * 0.05} ${1 - squash * 0.04}`,
          opacity: ramp(f, at(6, 1), at(6, 1) + 5),
          translate: `0 ${(1 - pop(f, at(6, 1), 12, 200, 0.6)) * 80}px`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: SANS, fontWeight: 700, fontSize: 18, color: TXT, marginBottom: 14 }}>
          <Brain size={24} weight="duotone" color={YEL} /> Shared memory
          <span style={{ flex: 1 }} />
          <span style={{ fontFamily: MONO, fontSize: 15, color: MUTED }}>{landed} entries</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, minHeight: 280 }}>
          {MEMS.slice(0, landed).map(([type, title], i) => {
            const s = at(6, 2) + i * (BEAT / 2) + 10;
            const p = pop(f, s, 12, 260, 0.5);
            return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, background: SURF, border: `1px solid ${LINE}`, borderRadius: 10, padding: "10px 12px", scale: 0.9 + 0.1 * p, opacity: p }}>
                <Chip color={YEL} bg="rgba(242,229,31,0.08)" style={{ fontSize: 13 }}>{type}</Chip>
                <span style={{ fontFamily: SANS, fontSize: 15, color: TXT }}>{title}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* agent six */}
      <div
        style={{
          position: "absolute",
          left: 1540,
          top: stackY - 30,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 14,
          scale: a6,
        }}
      >
        <div
          style={{
            width: 220,
            height: 220,
            borderRadius: 48,
            background: INK,
            color: YEL,
            display: "grid",
            placeItems: "center",
            fontFamily: MONO,
            fontWeight: 600,
            fontSize: 110,
            boxShadow: lit ? `0 0 0 ${10 + k * 10}px rgba(25,25,24,0.18)` : "none",
          }}
        >
          6
        </div>
        <span style={{ fontFamily: MONO, fontSize: 26, fontWeight: 600, color: INK }}>
          {lit ? `knows ${Math.round(ramp(f, at(7, 3), at(7, 3) + 10, 0, 5))} things` : "new agent"}
        </span>
      </div>
      {/* pulses along the beam */}
      {lit
        ? [0, 1, 2].map((i) => {
            const t = ((f - at(7, 3)) / 12 + i / 3) % 1;
            return <div key={i} style={{ position: "absolute", left: stackX + 270 + t * 270 - 9, top: stackY + 71, width: 18, height: 18, borderRadius: 9, background: INK, opacity: 1 - t }} />;
          })
        : null}
    </AbsoluteFill>
  );
};

// ---------- scene 5: build, planboard (bars 10-12) ----------

const COLS = ["TODO", "IN PROGRESS", "DONE"];
const ISSUES = [
  { n: 1, t: "Ship the planboard", tag: "roadmap" },
  { n: 2, t: "Write the docs", tag: "task" },
  { n: 3, t: "Pick the label convention", tag: "task" },
  { n: 4, t: "Fix flaky reconnect test", tag: "bug" },
];
// Moves accelerate with the snare roll: [frame, issue, column].
const MOVES: [number, number, number][] = [
  [at(8, 3), 0, 1],
  [at(9, 0), 2, 1],
  [at(9, 1), 0, 2],
  [at(9, 2), 1, 1],
  [at(9, 2.5), 2, 2],
  [at(9, 3), 3, 1],
  [at(9, 3.25), 1, 2],
  [at(9, 3.5), 3, 2],
];

const Build = ({ f }: { f: number }) => {
  const suck = ramp(f, at(10) - BEAT / 2 - 7, at(10) - BEAT / 2, 0, 1, IN);
  const cam = ramp(f, at(8), at(10), 1, 1.12, Easing.linear);
  const colX = [0, 440, 880];
  const place = ISSUES.map((_, i) => {
    let col = 0;
    let from = 0;
    let t0 = -99;
    for (const [t, idx, c] of MOVES) {
      if (idx === i && f >= t) {
        from = col;
        col = c;
        t0 = t;
      }
    }
    const p = t0 < 0 ? 1 : pop(f, t0, 13, 320, 0.45);
    return { x: colX[from] + (colX[col] - colX[from]) * p, col, t0, moving: f - t0 < 6 };
  });
  const counts = COLS.map((_, c) => place.filter((p) => p.col === c).length);
  const rowIn = (i: number) => {
    const inCol = place.map((p, j) => ({ p, j })).filter(({ p }) => p.col === place[i].col);
    return inCol.findIndex(({ j }) => j === i);
  };
  return (
    <AbsoluteFill style={{ background: PAPER }}>
      <DotGrid f={f} color="rgba(25,25,24,0.22)" k={0} />
      <AbsoluteFill style={{ scale: cam * (1 - suck), rotate: `${suck * 25}deg`, filter: `blur(${suck * 8}px)` }}>
        <div style={{ position: "absolute", left: 150, top: 90, fontFamily: SANS, fontWeight: 800, fontSize: 104, letterSpacing: "-0.055em", color: INK, lineHeight: 1 }}>
          <Words f={f} words={["The", "plan", "is", "your"]} start={at(8, 0)} step={BEAT / 2} />
          <Words f={f} words={[<Mark key="m" p={ramp(f, at(8, 3), at(8, 3) + 8)}>GitHub issues.</Mark>]} start={at(8, 2)} step={BEAT} />
        </div>
        <div style={{ position: "absolute", left: 300, top: 400, width: 1320, height: 560, opacity: ramp(f, at(8, 1), at(8, 1) + 6), translate: `0 ${(1 - pop(f, at(8, 1), 13, 160, 0.8)) * 200}px` }}>
          {COLS.map((c, i) => (
            <div key={c} style={{ position: "absolute", left: colX[i], top: 0, width: 420, height: 560, background: APP, border: `1px solid ${LINE}`, borderRadius: 16, boxShadow: "0 30px 70px rgba(25,25,24,0.28)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "18px 20px", fontFamily: MONO, fontSize: 16, letterSpacing: "0.12em", color: MUTED, borderBottom: `1px solid ${LINE}` }}>
                <span>{c}</span>
                <span style={{ color: TXT }}>{counts[i]}</span>
              </div>
            </div>
          ))}
          {ISSUES.map((iss, i) => {
            const pl = place[i];
            const y = 76 + rowIn(i) * 96;
            const lift = pl.moving ? 1 : 0;
            return (
              <div
                key={iss.n}
                style={{
                  position: "absolute",
                  left: pl.x + 14,
                  top: y,
                  width: 392,
                  background: SURF,
                  border: `1px solid ${pl.col === 2 ? "rgba(52,211,153,0.45)" : LINE}`,
                  borderRadius: 12,
                  padding: "14px 16px",
                  rotate: `${lift * 3}deg`,
                  scale: 1 + lift * 0.05,
                  boxShadow: lift ? "0 20px 40px rgba(0,0,0,0.5)" : "none",
                  zIndex: lift ? 2 : 1,
                }}
              >
                <div style={{ fontFamily: SANS, fontSize: 18, color: TXT, fontWeight: 600 }}>
                  <span style={{ fontFamily: MONO, color: MUTED, fontWeight: 400, marginRight: 8 }}>#{iss.n}</span>
                  {iss.t}
                </div>
                <Chip style={{ fontSize: 13, marginTop: 8, display: "inline-block" }}>{iss.tag}</Chip>
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
      {f >= at(10) - BEAT / 2 ? <AbsoluteFill style={{ background: INK }} /> : null}
    </AbsoluteFill>
  );
};

// ---------- scene 6: drop B montage, one word per beat (bars 12-14) ----------

const ICON = { size: 190, weight: "bold" as const };
const MONTAGE: { w: string; bg: string; fg: string; icon: ReactNode }[] = [
  { w: "Plan.", bg: YEL, fg: INK, icon: <Kanban {...ICON} /> },
  { w: "Fork.", bg: INK, fg: PAPER, icon: <GitFork {...ICON} /> },
  { w: "Run.", bg: PAPER, fg: INK, icon: <Lightning {...ICON} /> },
  { w: "Verify.", bg: YEL, fg: INK, icon: <CheckCircle {...ICON} /> },
  { w: "Remember.", bg: INK, fg: YEL, icon: <Brain {...ICON} /> },
  { w: "Commit.", bg: PAPER, fg: INK, icon: <GitCommit {...ICON} /> },
  { w: "Merge.", bg: YEL, fg: INK, icon: <GitMerge {...ICON} /> },
  { w: "Ship.", bg: INK, fg: PAPER, icon: <RocketLaunch {...ICON} /> },
];

const Montage = ({ f }: { f: number }) => {
  const i = Math.min(7, Math.floor((f - at(10)) / BEAT));
  const s = at(10) + i * BEAT;
  const m = MONTAGE[i];
  const p = pop(f, s, 9, 320, 0.45);
  const ip = pop(f, s + 2, 8, 280, 0.5);
  const drift = ramp(f, s, s + BEAT, 0, 1, Easing.linear);
  const ca = ramp(f, s, s + 6, 18, 0);
  const dir = i % 2 ? 1 : -1;
  const ship = i === 7 ? ramp(f, s + 4, s + BEAT, 0, 1, IN) : 0;
  return (
    <AbsoluteFill style={{ background: m.bg, alignItems: "center", justifyContent: "center" }}>
      <DotGrid f={f} color={m.bg === INK ? "rgba(245,245,242,0.18)" : "rgba(25,25,24,0.22)"} k={kick(f)} />
      {/* speed bars */}
      {[0, 1, 2, 3, 4].map((j) => {
        const t = ramp(f, s + j * 0.6, s + 7 + j * 0.6, 0, 1, EXPO);
        return (
          <div
            key={j}
            style={{
              position: "absolute",
              left: dir > 0 ? `${-40 + t * 140}%` : undefined,
              right: dir < 0 ? `${-40 + t * 140}%` : undefined,
              top: 180 + j * 170,
              width: "40%",
              height: 10 + (j % 2) * 8,
              background: m.fg,
              opacity: 0.12 * (1 - t),
            }}
          />
        );
      })}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 60,
          color: m.fg,
          scale: (1.45 - 0.45 * p) * (1 + drift * 0.06) * (1 + ship * 2.5),
          translate: `${(1 - p) * dir * 220}px ${-ship * 900}px`,
          rotate: `${(1 - p) * dir * -8}deg`,
          filter: `blur(${ramp(f, s, s + 4, 14, 0) + ship * 10}px)`,
        }}
      >
        <div style={{ scale: ip, rotate: `${(1 - ip) * dir * 90}deg`, display: "flex" }}>{m.icon}</div>
        <div
          style={{
            fontFamily: SANS,
            fontWeight: 800,
            fontSize: m.w.length > 7 ? 230 : 290,
            letterSpacing: "-0.065em",
            textShadow: `${ca}px 0 ${BLUE}, ${-ca}px 0 ${m.bg === YEL ? PAPER : YEL}`,
          }}
        >
          {m.w}
        </div>
      </div>
      <div style={{ position: "absolute", bottom: 90, fontFamily: MONO, fontSize: 26, letterSpacing: "0.3em", color: m.fg, opacity: 0.6 }}>
        {String(i + 1).padStart(2, "0")} / 08
      </div>
    </AbsoluteFill>
  );
};

// ---------- scene 7: lockup (bars 14-16) ----------

const Lockup = ({ f }: { f: number }) => {
  const s = at(12);
  const p = pop(f, s, 9, 200, 0.8);
  const drift = ramp(f, s, REEL_FRAMES, 1, 1.04, Easing.linear);
  const letters = "Solenta".split("");
  return (
    <AbsoluteFill style={{ background: PAPER }}>
      <DotGrid f={f} color="rgba(25,25,24,0.2)" k={0} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", scale: drift }}>
        {[0, 1, 2].map((i) => {
          const r = ramp(f, s + i * 4, s + i * 4 + 30, 0, 1);
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                width: 260,
                height: 260,
                borderRadius: 70,
                border: `${8 * (1 - r)}px solid ${i === 1 ? INK : YEL}`,
                scale: 1 + r * 6,
                rotate: `${45 + r * 30 * (i % 2 ? -1 : 1)}deg`,
                opacity: 1 - r,
                translate: "0 -210px",
              }}
            />
          );
        })}
        <div style={{ scale: p, rotate: `${(1 - p) * 180}deg`, marginBottom: 10 }}>
          <Logo size={210} draw={ramp(f, s + 3, s + 20)} />
        </div>
        <div style={{ display: "flex", fontFamily: SANS, fontWeight: 800, fontSize: 170, letterSpacing: "-0.06em", color: INK, lineHeight: 1.05 }}>
          {letters.map((l, i) => {
            const lp = pop(f, s + 5 + i * 1.5, 11, 240, 0.55);
            return (
              <span key={i} style={{ display: "inline-block", translate: `0 ${(1 - lp) * 110}px`, opacity: ramp(f, s + 5 + i * 1.5, s + 8 + i * 1.5), rotate: `${(1 - lp) * -14}deg` }}>
                {l}
              </span>
            );
          })}
        </div>
        <div style={{ fontFamily: SANS, fontWeight: 700, fontSize: 60, letterSpacing: "-0.04em", color: INK, translate: "0 0px" }}>
          <Words
            f={f}
            words={["Every", "agent", "starts", "where", "the", <Mark key="m" p={ramp(f, at(13, 0), at(13, 0) + 10)}>last one stopped.</Mark>]}
            start={at(12, 2)}
            step={2.4}
            style={{ justifyContent: "center" }}
          />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 22, marginTop: 50, opacity: ramp(f, at(13, 1), at(13, 1) + 4), scale: 0.8 + 0.2 * pop(f, at(13, 1), 9, 260, 0.5) }}>
          <span style={{ background: YEL, color: INK, fontFamily: SANS, fontWeight: 700, fontSize: 38, padding: "16px 34px", borderRadius: 14, border: `2px solid ${INK}`, boxShadow: `5px 5px 0 ${INK}` }}>solenta.app</span>
          <span style={{ fontFamily: MONO, fontSize: 24, color: "#55554f" }}>Free and open source</span>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ---------- transitions + overlays ----------

// Yellow band wipes up into the memory scene, paper wipes it away again.
const Wipes = ({ f }: { f: number }) => {
  const up = ramp(f, at(5, 3), at(6), 0, 1, IN);
  const out = ramp(f, at(8) - 7, at(8), 0, 1, IN);
  return (
    <>
      {f >= at(5, 3) && f < at(6) ? (
        <div style={{ position: "absolute", left: -100, right: -100, bottom: 0, height: `${up * 110}%`, background: YEL, rotate: `${(1 - up) * -4}deg`, transformOrigin: "left bottom" }} />
      ) : null}
      {f >= at(8) - 7 && f < at(8) ? (
        <div style={{ position: "absolute", top: -100, bottom: -100, left: 0, width: `${out * 110}%`, background: PAPER, rotate: `${(1 - out) * 3}deg` }} />
      ) : null}
    </>
  );
};

const Flash = ({ f }: { f: number }) => {
  let v = 0;
  for (const [t, a] of [[at(2), 0.9], [at(6), 0.4], [at(10), 1], [at(12), 0.8]] as const) {
    if (f >= t && f < t + 6) v = Math.max(v, a * (1 - (f - t) / 6));
  }
  return <AbsoluteFill style={{ background: "#fffef0", opacity: v, pointerEvents: "none" }} />;
};

const Hud = ({ f }: { f: number }) => {
  const bar = Math.min(14, Math.floor(f / BAR) + 1);
  const sec = f / FPS;
  const tc = `00:${String(Math.floor(sec)).padStart(2, "0")}:${String(Math.floor(f % FPS)).padStart(2, "0")}`;
  const k = kick(f);
  const style: CSSProperties = { position: "absolute", fontFamily: MONO, fontSize: 20, letterSpacing: "0.18em", color: "#fff" };
  return (
    <AbsoluteFill style={{ mixBlendMode: "difference", opacity: ramp(f, 4, 14) * (1 - ramp(f, at(12), at(12) + 10)), pointerEvents: "none" }}>
      <div style={{ ...style, left: 56, top: 44 }}>SOLENTA / REEL</div>
      <div style={{ ...style, right: 56, top: 44, display: "flex", alignItems: "center", gap: 14 }}>
        <span style={{ width: 12, height: 12, background: "#fff", borderRadius: 2, rotate: "45deg", scale: 0.6 + k * 0.8 }} />
        BAR {String(bar).padStart(2, "0")}/14
      </div>
      <div style={{ ...style, left: 56, bottom: 44 }}>{tc}</div>
      <div style={{ ...style, right: 56, bottom: 44 }}>112 BPM</div>
      <div style={{ position: "absolute", left: 56, right: 56, bottom: 26, height: 2, background: "rgba(255,255,255,0.25)" }}>
        <div style={{ width: `${(f / REEL_FRAMES) * 100}%`, height: "100%", background: "#fff" }} />
      </div>
    </AbsoluteFill>
  );
};

const Grain = ({ f }: { f: number }) => (
  <AbsoluteFill style={{ opacity: 0.07, mixBlendMode: "multiply", pointerEvents: "none" }}>
    <svg width="1920" height="1080">
      <filter id="g">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed={f % 12} />
      </filter>
      <rect width="100%" height="100%" filter="url(#g)" />
    </svg>
  </AbsoluteFill>
);

export const Reel = () => {
  const f = useCurrentFrame();
  let sx = 0;
  let sy = 0;
  let sr = 0;
  for (const [t, a] of SHAKES) {
    const s = shake(f, t, a);
    sx += s.x;
    sy += s.y;
    sr += s.r;
  }
  let scene: ReactNode;
  if (f < at(2)) scene = <Intro f={f} />;
  else if (f < at(6)) scene = <DropA f={f} />;
  else if (f < at(8)) scene = <Memory f={f} />;
  else if (f < at(10)) scene = <Build f={f} />;
  else if (f < at(12)) scene = <Montage f={f} />;
  else scene = <Lockup f={f} />;

  return (
    <AbsoluteFill style={{ background: INK, overflow: "hidden" }}>
      <AbsoluteFill style={{ translate: `${sx}px ${sy}px`, rotate: `${sr}deg`, scale: 1 + Math.abs(sx) * 0.001 }}>
        {scene}
        <Wipes f={f} />
      </AbsoluteFill>
      <Flash f={f} />
      <Grain f={f} />
      <AbsoluteFill style={{ boxShadow: "inset 0 0 220px rgba(25,25,24,0.28)", pointerEvents: "none" }} />
      <Hud f={f} />
      <Audio src={staticFile("reel-score.mp3")} />
    </AbsoluteFill>
  );
};
