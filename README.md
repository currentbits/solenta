<p align="center">
  <img src="assets/icon-512.png" width="120" alt="Solenta icon" />
</p>

<h1 align="center">Solenta</h1>

<p align="center">
  <strong>A local-first desktop control surface for coding agents.</strong><br/>
  Run Claude Code, Codex, Kimi, Grok, and OpenCode side by side — with git worktrees,
  PRs, spend caps, and shared agent memory, in one window.
</p>

<p align="center">
  <a href="https://github.com/currentbits/solenta/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/currentbits/solenta?style=flat-square" /></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
  <img alt="Platforms" src="https://img.shields.io/badge/macOS%20·%20Windows%20·%20Linux-informational?style=flat-square" />
  <img alt="Local-first" src="https://img.shields.io/badge/cloud-none-success?style=flat-square" />
</p>

<p align="center">
  <a href="https://solenta.app">Website</a> ·
  <a href="https://solenta.app/docs.html">Docs</a> ·
  <a href="https://github.com/currentbits/solenta/releases/latest">Download</a> ·
  <a href="https://solenta.app/changelog.html">Changelog</a> ·
  <a href="https://github.com/currentbits/solenta/issues">Issues</a>
</p>

<p align="center">
  <img src="assets/screenshot.png" alt="Solenta: threads with PR badges, live work log, and the environment panel" width="100%" />
</p>

## What it is

Solenta turns "kick off an agent in a terminal and hope" into a directed, visible
workflow.

Each **thread** is one provider session against one of your projects, in its own
git worktree. You watch the conversation and the work log live, read the diff,
and land the result as a merge or a PR — without juggling terminal tabs,
branches, or stray PIDs. Run five threads at once and the sidebar tells you
which ones are working, which are waiting on you, and which are done.

## What's the catch?

There isn't one. Solenta is MIT-licensed and there is no Solenta account, no
Solenta cloud, and nothing to buy.

It shells out to the agent CLIs you already have installed and bills against the
subscriptions you already pay for. Your projects, threads, transcripts, and
memory stay on your disk; the only network traffic Solenta itself makes is a
GitHub release check for updates.

## Features

**Threads and providers**

- **Five providers, one UI** — Claude Code, Codex, Kimi Code, Grok, and OpenCode,
  with sticky permission modes, per-thread model and reasoning-effort overrides,
  and session resume where the provider supports it.
- **Hand off mid-task** — switch a thread's provider and let a second model pick
  up the same context.
- **Agent profiles** — save a provider + model + effort + permission combination
  and apply it in one click.
- **Edit and resubmit** any past message of yours and run again from that point.
- **Per-thread scratch notes** and **rename**, previewed in the sidebar.
- **Spaces** — named groups for organizing projects in the sidebar.
- **Three-pane workspace** — projects and threads on the left, conversation +
  work log in the middle, live agent / git / memory panel on the right.
- **Desktop notifications** when a thread finishes or needs you — never while
  the window is focused.

**Git, in the loop**

- **Isolated worktree per thread** — set up, diff, merge to main, push, or delete
  from the Git tab. Nothing lands on your working copy by accident.
- **PRs with live CI** — open a PR from a thread and watch its checks as badges
  on the thread row.
- **Issue ingestion** — paste a GitHub issue ref and start a thread from it.
- **Generated commit messages** from the actual diff.
- **Conflict forecast** — parallel worktrees heading for the same lines are
  flagged while both are still cheap to redirect, not at the merge.
- **Worktree GC** — per-project retention, batch cleanup, and visible disk usage.

**Beyond one prompt**

- **Orchestrator threads** — a thread that hands its first prompt to a worker in
  its own worktree and supervises instead of editing. Pick it per thread, or make
  it the default for every new thread in Settings.
- **Build workflows** — multi-phase pipelines (plan → analyze → verify …) with a
  provider per phase, fan-out, and a judge step. Each phase settles visibly in
  the Agents panel.
- **Planboard** — a project's plan as its GitHub issues, written by agents with
  nothing but `gh`, with **Start task** to open a thread on a card. Opt a project
  in to **auto-dispatch** and every issue that enters `plan:todo` starts its own
  worktree thread and moves to `plan:doing`, up to three running at once.
- **Agent teams** — workers under one orchestrator share a crew task list and
  message each other directly, with loop guardrails so a crew cannot talk in
  circles.
- **Shared agent memory** — a supervised local memory server (MCP + HTTP) is
  auto-injected into sessions, so what one thread learns, the next one knows.
  Entries carry provenance, per-agent trust, and file:line / thread / commit
  citations. Before a fact is injected, its file citations are checked against
  the current worktree and contradicted entries are invalidated. Embeddings
  drive near-dup and contradiction detection. A **hypothesis ledger** hands
  the next thread what the last one already ruled out.
- **Shared code index** — a per-repo symbol index built once and injected into
  every dispatched prompt, so a fresh worker starts knowing where things live.
- **Spec mode** — gated requirements → design → tasks artifacts per thread, each
  approved before the next unlocks.
- **Automations** — recurring prompts (hourly / daily / weekly) against any
  project, and **repeat a finished thread**: put its prompt on a schedule or
  distill the run into a Build workflow.
- **Skills** — browse and edit the `SKILL.md` files your agents can reach, and
  install a skill once to fan it out to every provider's skills directory.
- **Dev servers** — start a project's `dev` script from the app and get the URL.

**Control**

- **Spend guardrails** — an optional daily budget cap blocks new runs once the
  day's spend hits the limit, and a per-orchestration cap bounds what one
  fan-out can spend across its crew; token usage is visible per thread.
- **Verification gate** — a thread only settles green once its verify command
  exits 0, so nothing reports itself done over a red build.
- **Orchestrator guardrails** — protected config a worker may not edit, hook
  packs installed at spawn time, and injection + secret scanning on what comes
  back.
- **Usage and fleet analytics** — cost and tokens per provider/model over
  7/30/90 days, plus merge rate, review tax, rework and cost per merged PR read
  off git and GitHub rather than off the agents' own reports. OTel GenAI spans
  ship to your tracing backend.
- **Morning digest** — one summary of everything that ran unattended: what ran,
  what it cost, what changed.
- **Web mode** — `--serve-web` serves the same UI over HTTP + WebSocket behind a
  session token, so you can check in from a browser or your phone.
- **SSH remote projects** — register projects on other hosts and run agents
  against them over SSH.
- **Activity feed** — one chronological view of everything your agents did.

## Install

> [!IMPORTANT]
> Solenta drives CLIs; it doesn't ship them. Install and sign into at least one
> provider first — Solenta finds them on your `PATH`.
>
> | Provider | Install | Sign in |
> |---|---|---|
> | [Claude Code](https://claude.com/product/claude-code) | `npm i -g @anthropic-ai/claude-code` | `claude` → `/login` |
> | [Codex](https://developers.openai.com/codex/cli) | `npm i -g @openai/codex` | `codex login` |
> | [Grok](https://x.ai/cli) | see x.ai/cli | `grok login` |
> | [OpenCode](https://opencode.ai) | `npm i -g opencode-ai` | `opencode auth login` |
> | [Kimi Code](https://github.com/MoonshotAI/kimi-cli) | `pip install kimi-cli` | `kimi` → follow prompts |

Grab an archive from the [latest release](https://github.com/currentbits/solenta/releases/latest):

- **macOS (Apple Silicon)** — `Solenta-<v>-macos-arm64.zip`. Unzip, move
  `Solenta.app` to `/Applications`. Not notarized, so right-click → **Open** the
  first time (or `xattr -dr com.apple.quarantine /Applications/Solenta.app`).
- **Windows (x64)** — `Solenta-<v>-win32-x64.zip`. Unzip anywhere, run
  `solenta.exe`. Unsigned, so SmartScreen asks once. There is no installer
  and no winget package; see the note in `scripts/package-cross.sh`.
- **Linux (x64)** — `Solenta-<v>-linux-x64.tar.gz`. Extract, run `./solenta`.

### Updates

Builds are stamped with a channel. **prod** follows the newest normal release;
**nightly** follows the newest prerelease and never migrates itself onto prod.
On macOS the app downloads and swaps itself in place. Builds from a dev tree
carry no stamp and never self-update.

### Remote access

```bash
/Applications/Solenta.app/Contents/MacOS/Solenta --serve-web        # 127.0.0.1:4620
/Applications/Solenta.app/Contents/MacOS/Solenta --serve-web=4700 --serve-host 0.0.0.0
```

The session token is printed to stdout on start (`solenta-web: token …`) and
persisted at `<userData>/web-token`. There is no TLS in v1 — binding beyond
loopback puts a token-gated API on your LAN, which is your call to make.

## How it works

Electron main owns the agents and the disk; the renderer is a React app; preload
exposes a typed `window.coder`. Providers are a data-driven registry
(`electron/providers.js`), each spawned and parsed by an adapter, and the runner
keys every event to a run id so a stopped run can never write into a newer one.

| Layer | Path |
|---|---|
| Main (window, store, runner, memory supervisor) | `electron/main.js` |
| IPC bridges | `electron/ipc.js`, `electron/preload.js` |
| Services (projects, threads, settings, spend gate) | `electron/services.js` |
| Renderer | `src/` |
| Workflow engine (pure) | `core/` |
| Memory server (MCP + HTTP) | `memory-server/` |

Full detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Development

```bash
npm install
cd core && npm install && npm run build && cd ..
npm run dev              # Vite (HMR) + Electron against the real main process
```

`npm run dev` is the loop to develop in: the window loads the Vite dev server,
so every renderer edit hot-reloads while `electron/` runs for real — real
services, real git, real providers, real store.

To check a production bundle instead: `npx vite build && CODER_PROD=1 npx electron .`

`npm run dev:browser` opens the renderer in a browser with no Electron, backed
by the fixtures in `src/devCoder.ts` (demo and trailer captures). Fixtures are
not the app: they store what you give them and return something plausible. Do
not read behaviour off them, and never fix a bug there.

```bash
npm test                 # all four suites, same as CI (.github/workflows/test.yml)

npm run test:core        # workflow engine — also builds core/dist, which electron needs
npm run test:renderer    # renderer
npm run test:electron    # electron main
npm run test:memory      # memory server (needs `npm ci --prefix memory-server`)
```

`npm run acceptance` stays manual: one real claude turn, not part of CI.

**Env:** `CODER_CLAUDE_BIN`, `CODER_CODEX_BIN`, `CODER_KIMI_BIN`,
`CODER_GROK_BIN`, `CODER_OPENCODE_BIN` (CLI paths) · `CODER_SIMULATE=1` (fake
provider) · `CODER_MEMORY_CONFIG` / `CODER_MEMORY_ENTRY` / `CODER_NODE_BIN`
(memory server) · `CODER_PROD=1` (load `dist/`) · `VITE_DEV_SERVER_URL`
(default `http://localhost:5173`).

<details>
<summary>Electron binary fails to install</summary>

npm allow-scripts can skip Electron's postinstall, leaving a stub `dist` with no
`path.txt` ("Electron failed to install correctly"). Repair from the cache —
match the version to `node_modules/electron/package.json`:

```bash
ditto -x -k ~/Library/Caches/electron/*/electron-v*-darwin-arm64.zip \
  node_modules/electron/dist
printf 'Electron.app/Contents/MacOS/Electron' > node_modules/electron/path.txt
```

The root `package.json` already allows scripts for the pinned Electron version.
</details>

## Status

Early and moving fast. Expect bugs and rough edges — [issues][issues] are
welcome, and small PRs more so than large ones.

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — process split, providers, runner, memory, store
- [`docs/ISSUES.md`](docs/ISSUES.md) — symptom / cause / fix log
- `PRODUCT-SPEC.md`, `BRAINSTORM.md` — historical, not kept current

## Acknowledgments

Solenta's design and some of its feature ideas are inspired by
[t3code](https://github.com/pingdotgg/t3code) and
[Synara](https://github.com/Emanuele-web04/synara). No code from either project
is used; everything here is original work under the [MIT license](LICENSE).

[issues]: https://github.com/currentbits/solenta/issues
