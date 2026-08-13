export type TerminalSpec = {
  id: string;
  title: string;
  prompt: string;
  lines: [string, string];
  left: number;
  top: number;
  rotate: number;
};

export const TERMINAL_SIZE = { width: 560, height: 320 };

export const WINDOW_INSET_X = 48;
export const WINDOW_INSET_Y = 40;
export const WINDOW_W = 1824;
export const WINDOW_H = 1000;

export const TERMINALS: TerminalSpec[] = [
  {
    id: "claude",
    title: "claude",
    prompt: "$ claude",
    lines: ["Welcome to Claude Code", "Working in ~/acme/api"],
    left: 80,
    top: 70,
    rotate: -2.8,
  },
  {
    id: "codex",
    title: "codex",
    prompt: "$ codex",
    lines: ["OpenAI Codex", "resume session 7f3a"],
    left: 680,
    top: 120,
    rotate: 2.1,
  },
  {
    id: "kimi",
    title: "kimi",
    prompt: "$ kimi",
    lines: ["Kimi Code  ·  k3", "Reading src/runner.ts"],
    left: 1280,
    top: 80,
    rotate: -1.4,
  },
  {
    id: "grok",
    title: "grok",
    prompt: "$ grok",
    lines: ["Grok 4.5", "tool: apply_patch"],
    left: 220,
    top: 520,
    rotate: 2.6,
  },
  {
    id: "opencode",
    title: "opencode",
    prompt: "$ opencode",
    lines: ["OpenCode", "watching worktree"],
    left: 1100,
    top: 560,
    rotate: -2.0,
  },
];
