# Solenta

Local-first desktop control surface for coding agents (Claude Code, Codex, Kimi,
Grok, OpenCode). Electron owns CLIs, worktrees, spend, and a shared memory
server; React drives three panes over the typed contract in `src/shared/ipc.ts`.

## UI (three panes)

- **Sidebar:** projects, threads, spend/budget, settings
- **Center:** conversation + work log, composer (provider / model / permission /
  Build), Changes panel
- **Right:** Agents (live workflow), Git (worktree setup/merge/delete, push),
  Memory tab

**Threads** are provider sessions with sticky permission mode, optional model
override, and resume where supported. After the first turn, `sessionId` locks the
provider. Empty `models` lists (e.g. Codex) accept free-form model ids via the
composer pill (Default + Custom…).

**Worktrees** are optional per thread; merge or delete from Git before deleting
the thread. **Build** runs multi-phase workflow templates (custom + builtin) with
per-phase providers and agent dossiers. **Memory** is a supervised local
MCP/HTTP server auto-injected into Claude via `--mcp-config`; the Memory tab
searches and stores notes. **Cost** guardrails: optional daily budget blocks new
runs when today's spend is at/over the cap.

## Dev

```bash
npm install
cd core && npm install && npm run build && cd ..
npx vite build
CODER_PROD=1 npx electron .
```

Vite-only mock (no Electron): `npx vite` (`src/devCoder.ts` implements
`window.coder`).

### Tests

```bash
node --experimental-strip-types --test test/*.test.ts   # renderer / devCoder
node --test electron/test/*.test.js                     # electron main
cd core && npm test
cd memory-server && npm test
```

### Env

`CODER_CLAUDE_BIN`, `CODER_CODEX_BIN`, `CODER_KIMI_BIN`, `CODER_GROK_BIN`,
`CODER_OPENCODE_BIN` (CLI paths); `CODER_SIMULATE=1` (simulate provider);
`CODER_MEMORY_CONFIG` / `CODER_MEMORY_ENTRY` / `CODER_NODE_BIN` (memory server);
`CODER_PROD=1` (load `dist/`); `VITE_DEV_SERVER_URL` (default
`http://localhost:5173`).

### Electron binary on this machine

npm allow-scripts can skip Electron postinstall (stub dist, missing `path.txt`,
"Electron failed to install correctly"). Repair from the cached zip:

```bash
# match version to node_modules/electron/package.json
ditto -x -k ~/Library/Caches/electron/*/electron-v*-darwin-arm64.zip \
  node_modules/electron/dist
printf 'Electron.app/Contents/MacOS/Electron' > node_modules/electron/path.txt
```

Root `package.json` already has `"allowScripts"` for the pinned Electron version.

## Docs

- `docs/ARCHITECTURE.md`: process split, providers, runner, memory, store
- `docs/ISSUES.md`: short symptom/cause/fix log
- `PRODUCT-SPEC.md`, `BRAINSTORM.md`: historical (not kept current)
