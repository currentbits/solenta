# Coder memory server

Minimal shared-memory MCP server for the Coder app. Localhost-only HTTP, bearer auth, SQLite + FTS5.

## Supervision

Coder (Electron) is expected to adopt-or-spawn this process: probe `GET /health`, adopt if live, otherwise spawn `node src/index.js` and only kill a child it started.

## Config

Env `CODER_MEMORY_CONFIG` points at a JSON file (default `~/Library/Application Support/coder/memory-server.json` on macOS). Shape: `{ "port", "token", "dbPath" }`. Created on first run (random port 49500-49999, 32-byte hex token, mode 0600). Broken configs refuse to start; they are never silently regenerated.

## Run standalone

```bash
cd memory-server && npm install && node src/index.js
```

## Tools

- `memory_bootstrap` — conventions, knowledge, active tasks, protocol
- `memory_store` / `memory_get` / `memory_search` / `memory_supersede`

Search returns excerpts; call `memory_get` for full bodies. MCP at `POST /mcp` with `Authorization: Bearer <token>`. `GET /health` is open.
