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
- `memory_recent` — newest live entries (excerpts, limit ≤ 50)
- `memory_feedback` — `{ id, verdict: helpful|harmful, note? }` evidence counters
- `memory_resolve` — adjudicate a `review_queue` item (`update` | `invalidate` | `noop`)
- `memory_maintenance` — read-only report (open queue, near-dups, aging runs, fat conventions)
- `session_record` / `session_search` — append-only transcript turns and FTS over past conversation excerpts (30-day retention)

Search fuses FTS5, a 2-hop entity graph, and local semantic vectors (RRF), then applies composite scoring and a 20% relevance gate. Vectors use `@huggingface/transformers` MiniLM (`Xenova/all-MiniLM-L6-v2`); set `CODER_MEMORY_SEMANTIC=0` to disable. Write-time Jaccard dedup refuses near-duplicates (≥0.7) unless `force: true`, and enqueues moderate pairs (≥0.4) for review. Entities are extracted conservatively on store/supersede (`[[wikilinks]]`, code/doc files, two-hump PascalCase modules). A janitor runs on start and every 6h (access decay, orphan sweep, session prune, contradiction scan, embedding backfill ≤64, health snapshot on `GET /health` as `janitor` plus `vectors: {enabled,count,model}`).

REST (same bearer auth): `GET /api/recent`, `GET /api/search`, `GET /api/entry/:id`, `POST /api/store`, `POST /api/session`, `GET /api/session-search`.

Search returns excerpts; call `memory_get` for full bodies. Record notable turns with `session_record`; `session_search` finds past conversation excerpts. MCP at `POST /mcp` with `Authorization: Bearer <token>`. Header-less MCP clients (for example codex HTTP MCP) may instead pass the same token as `?token=<token>` on the `/mcp` URL only; REST `/api/*` stays header-only. This option is for localhost use. `GET /health` is open.
