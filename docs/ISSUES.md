# Issues log

- 2026-08-06 - symptom: stop run A then start B; A's late exit marked thread done and cleared B | cause: real-run onChunk/onDone/onError re-looked up active by threadId only | fix: guard e.runId !== closed-over runId in all three callbacks (runner.js)
- 2026-08-06 - symptom: smoke pass B spawn ENOENT for node under Electron | cause: CODER_AGENT_CMD whitespace-split breaks process.execPath under Application Support | fix: smoke resolves space-free node via which/homebrew
- 2026-08-06 - symptom: All projects count ignored search filter | cause: section count used unfiltered threads.length | fix: Sidebar.tsx uses filtered.length

