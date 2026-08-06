# Issues log

- 2026-08-06 - symptom: second claude turn threw "run already active" after first reached done | cause: result event set status done but left active Map until process exit | fix: clearRun on result event; onExit no-ops via runId guard (runner.js)
- 2026-08-06 - symptom: stop run A then start B; A's late exit marked thread done and cleared B | cause: real-run onChunk/onDone/onError re-looked up active by threadId only | fix: guard e.runId !== closed-over runId in all three callbacks (runner.js)
- 2026-08-06 - symptom: smoke pass B spawn ENOENT for node under Electron | cause: CODER_AGENT_CMD whitespace-split breaks process.execPath under Application Support | fix: smoke resolves space-free node via which/homebrew
- 2026-08-06 - symptom: Thread view mixed all runs into one Work Log above messages | cause: single global card + no runId grouping | fix: buildTimeline in src/timeline.ts; ThreadView merges messages + per-run cards
- 2026-08-06 - symptom: All projects count ignored search filter | cause: section count used unfiltered threads.length | fix: Sidebar.tsx uses filtered.length
- 2026-08-06 - symptom: long chats pushed the composer below the window frame | cause: .app grid had no row constraint, implicit row min-height auto grows with content | fix: grid-template-rows minmax(0, 1fr) in App.module.css
