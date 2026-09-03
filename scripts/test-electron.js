#!/usr/bin/env node
// The electron suite on POSIX is `node --test electron/test/*.test.js`.
// On win32, CreateProcess cannot run a shebang. Agent-CLI fakes now go
// through writeFakeBin (electron/test/support/fakeBin.js) which emits a
// .cmd wrapper; cross-spawn (after #442) can launch those. gh/fm still
// use child_process.execFile, which cannot run .cmd — those files stay
// off this list. #450
"use strict";

const { spawnSync } = require("node:child_process");

const args = [
  "--import=./test/support/render.mjs",
  "--experimental-strip-types",
  "--test",
];
// Win32: files whose only spawn is writeFakeBin + cross-spawn, or that
// inject the platform / never spawn. git.exe is on windows-latest.
// Not here: execFile of a fake (gh, fm), signals, /bin/sh, hardcoded /tmp.
const WIN32_FILES = [
  "electron/test/wsl.test.js", // the boundary contract itself
  "electron/test/worktree-wsl.test.js", // worktree placement across it
  "electron/test/doctor.test.js", // the win32 doctor probes
  "electron/test/sandbox.test.js", // sandbox resolution (platform injected)
  "electron/test/which-platform.test.js", // defaultWhich + cross-spawn source
  "electron/test/fake-bin.test.js", // the .cmd wrapper contract
  "electron/test/proc.test.js", // agentSpawnOptions win32 attach (#480)
  "electron/test/claude-spawn.test.js", // .cmd + runClaude/runCodex parse (#480)
  "electron/test/budget-spend.test.js",
  "electron/test/codex.test.js",
  "electron/test/cursor-parse.test.js",
  "electron/test/cursor-pin-task-parent.test.js",
  "electron/test/cursor-guardrail-hook.test.js",
  "electron/test/codex-guardrail-hook.test.js",
  "electron/test/opencode-guardrail-hook.test.js",
  "electron/test/cursor.test.js",
  "electron/test/context-usage.test.js",
  "electron/test/fork-handoff.test.js",
  "electron/test/grok.test.js",
  "electron/test/guardrails-runner.test.js",
  // Simulator lifecycle: platform, process adapter, timers, and signals are
  // all injected and the runner cases inject runAgentFn, so nothing here
  // spawns an agent. Only git.exe is used, same as the entries above. #248
  "electron/test/ios-simulator-lifecycle.test.js",
  // Pure codec: no spawn. Plan 03 Task 1. #248
  "electron/test/ios-simulator-protocol.test.js",
  // Toolchain discovery/cache: execFile/spawn/fs/platform injected. Plan 03 Task 2. #248
  "electron/test/ios-simulator-toolchain.test.js",
  // Stream broker: injected ws / bufferedAmount / decode. Plan 03 Task 4. #248
  "electron/test/ios-simulator-stream.test.js",
  "electron/test/kimi.test.js",
  "electron/test/kimi-effort.test.js",
  "electron/test/kimi-home.test.js",
  "electron/test/workflow-kimi-resume.test.js",
  "electron/test/workflow-phase-resume.test.js",
  "electron/test/grok-home.test.js",
  "electron/test/grok-guardrail-hook.test.js",
  "electron/test/grok-live-hook.test.js", // skip unless GROK_LIVE=1; never CI (#826)
  "electron/test/cursor-home.test.js",
  "electron/test/memory-record.test.js",
  "electron/test/opencode.test.js",
  "electron/test/otel-runner.test.js",
  "electron/test/providers-set.test.js",
  "electron/test/catalog-divergence.test.js",
  "electron/test/reasoning-effort.test.js",
  "electron/test/rewind.test.js",
  "electron/test/session-record.test.js",
  "electron/test/secrets.test.js",
  "electron/test/updater.test.js", // win32 portable stage + helper (#755)
  "electron/test/speech-packaging.test.js", // fixture tree; no archive download (#845)
  "electron/test/workflow-crash-resume.test.js", // store load only; no spawn (#824)
  "electron/test/workflow-phase-retry.test.js",
  "electron/test/workflow-retry-agent.test.js",
  "electron/test/workflow-retry-note.test.js",
];
if (process.platform === "win32") {
  args.push(...WIN32_FILES);
} else {
  // Linux is POSIX: shebang fakes, signals, /bin/sh, and /tmp all work, so
  // it shares the full glob with macOS. A third skip list would only hide a
  // real Linux-only break. Win32 is the exception (CreateProcess / no shebang).
  args.push("electron/test/*.test.js");
}

const r = spawnSync(process.execPath, args, { stdio: "inherit" });
process.exit(r.status ?? 1);
