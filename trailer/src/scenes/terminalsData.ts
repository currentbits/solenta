export type TerminalSpec = {
  id: string;
  title: string;
  prompt: string;
  lines: [string, string];
  left: number;
  top: number;
  rotate: number;
};

export const TERMINAL_SIZE = { width: 620, height: 360 };

export const WINDOW_INSET = 64;
export const WINDOW_SIZE = 952;

export const TERMINALS: TerminalSpec[] = [
  {
    id: "claude",
    title: "claude",
    prompt: "$ claude",
    lines: ["Welcome to Claude Code", "Working in ~/acme/api"],
    left: 40,
    top: 80,
    rotate: -3.2,
  },
  {
    id: "codex",
    title: "codex",
    prompt: "$ codex",
    lines: ["OpenAI Codex", "resume session 7f3a"],
    left: 280,
    top: 200,
    rotate: 2.4,
  },
  {
    id: "kimi",
    title: "kimi",
    prompt: "$ kimi",
    lines: ["Kimi Code  ·  k3", "Reading src/runner.ts"],
    left: 140,
    top: 360,
    rotate: -1.6,
  },
  {
    id: "grok",
    title: "grok",
    prompt: "$ grok",
    lines: ["Grok 4.5", "tool: apply_patch"],
    left: 420,
    top: 480,
    rotate: 3.1,
  },
  {
    id: "opencode",
    title: "opencode",
    prompt: "$ opencode",
    lines: ["OpenCode", "watching worktree"],
    left: 80,
    top: 620,
    rotate: -2.2,
  },
];
