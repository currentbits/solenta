# Splitting `useCoder` into domain sub-hooks

Issue #1447, round 4, pass I. Base: `origin/main` 6763da60, where `src/useCoder.ts` is 4,510 lines and the `useCoder` body (lines 992–4510) is 3,518 lines.

## How the hook is laid out

The body falls into four bands. The bands matter more than the domains, because the effect-order rules depend on them.

| Lines | What | Hooks |
|---|---|---|
| 993–1053 | `api`, boot snapshot, 17 `useState`, 8 `useRef`, `queued` memo | state + refs |
| 1054–1092 | 5 small effects: ref sync, staged-path reset, detail cache, boot-snapshot persistence | **effects** |
| 1093–1297 | core callbacks: `reloadDetail`, `refreshTrashed`, `applyThreads`, queue, `clearError`, `refreshStatus`, update actions | callbacks |
| 1298–1528 | update-poll effect, boot + push-subscription effect, detail-load effect | **effects** |
| 1529–4287 | 2 memos and ~230 `useCallback`s, plus one `useMemo` (`terminal`) | **no effects** |

All seven effects sit in lines 1054–1528. After line 1528 there is no `useEffect` or `useLayoutEffect`. Everything there is `useCallback`/`useMemo`, which run synchronously during render and have no commit-phase side effects.

## State map

"Read by" lists closures that read the value. Every value is also returned. Setters from `useState` and ref objects are identity-stable, so they are left out of dependency arrays throughout. That stays true after the move.

| State / ref | Line | Holds | Read by | Written by |
|---|---|---|---|---|
| `projects` | 997 | project list (boot-hydrated) | persist effect@1075, `projectById`, `selectedProjectId`, `createThread` | boot effect@1323, `addProject`, `createProject`, `ensureScratchProject`, `updateProject`, `removeProject`, `setSpotlight` |
| `threads` | 1000 | thread list (boot-hydrated) | `queued`, persist effect@1075, `selectedProjectId` | `applyThreads` (the only writer) |
| `trashedThreads` | 1003 | trash list | — | `refreshTrashed` |
| `providers` | 1004 | provider catalog | — | boot effect, `refreshProviders` |
| `workflows` | 1005 | workflow templates | — | boot effect, `refreshWorkflows`, `saveWorkflow`, `removeWorkflow` |
| `workflowListError` | 1006 | last list-refresh failure | — | `refreshWorkflows`, `saveWorkflow`, `removeWorkflow` |
| `automations` | 1009 | automation rows | — | boot effect, `refreshAutomations` |
| `selectedThreadId` | 1010 | open thread id | effects @1054/@1059/@1075/@1488, `selectedProjectId`, and ~45 actions that default to the selected thread (run, thread mutators, worktree/diff/files/attachments, PR, shell) | boot effect, `selectThread`, `createThread`, `forkThread`, `setArchived`, `deleteThread`, `restoreThread`, `purgeThread`, `removeProject`, `checkoutPr`, `importCliSession` |
| `detail` | 1013 | open `ThreadDetail` | effects @1067/@1084 | ~60 writers: `reloadDetail`, queue, boot effect, detail-load effect, run actions, every thread mutator, worktree/PR actions, verify |
| `detailError` | 1015 | last `threads.get` failure | — | detail-load effect, `retryDetail` |
| `detailRetryNonce` | 1016 | retry counter | detail-load effect | `retryDetail` |
| `loading` | 1017 | first boot pending | — | boot effect |
| `error` | 1018 | banner (`project`/`run` scope) | — | ~60 writers across every domain |
| `appStatus` | 1019 | spend meter | — | `refreshStatus`, boot effect |
| `settings` | 1020 | app settings | `createThread` | boot effect, `saveSettings` |
| `stayAwake` | 1021 | stay-awake blocker | `setStayAwakeMode` (updater) | boot effect, `setStayAwakeMode` |
| `updateStatus` | 1022 | updater state | — | `failUpdate`, `checkUpdate`, `downloadUpdate`, update effect@1298 |
| `simulatorStatus` | 1023 | iOS simulator | — | boot effect (push) |
| `selectedRef` | 1025 | latest selection for async closures | ~30 async actions (stale-response guards) | effect@1054, boot effect, `createThread`, `checkoutPr`, `importCliSession` |
| `threadsListGen` | 1029 | push generation; stops a late boot list clobbering a push | boot effect | boot effect (`threads:changed`) |
| `threadsRef` | 1030 | latest list for async closures | `applyThreads` and ~55 actions | `applyThreads` |
| `prevStatusRef` | 1032 | prior status per thread (spend refresh on settle) | boot effect | boot effect |
| `detailRef` | 1034 | open detail for patch merging | effects @1067/@1323/@1488 | effect@1067 |
| `detailCacheRef` | 1036 | bounded detail cache | effect@1067, `applyThreads`, detail-load effect, `removeProject` | (mutable object) |
| `refetchRef` | 1038 | in-flight refetch set | `reloadDetail` | `reloadDetail` |
| `patchSeqRef` | 1040 | last push seq per thread | boot effect | boot effect |
| `stagedPathsRef` | 1058 | Changes-pane staged paths | `mergeWorktree`, `commitChanges` | effect@1059, `setStagedPaths` |

### The hub

Three closures connect almost everything: `applyThreads` (the only `threads` writer, which also keeps `threadsRef` and `detailCacheRef` in step), `setDetail`, and `setError`. The boot/subscription effect (1323–1483) writes 12 of the 17 states and reads 6 of the 8 refs. Any domain that writes the thread list, the open detail or the banner therefore has to take these as inputs. They are all identity-stable: `applyThreads` has `[]` deps, and setters and refs never change. Passing them in therefore cannot change any callback identity.

## Domains

| # | Domain | Sub-hook | Lines (base) | Hooks | Inputs | Outputs |
|---|---|---|---|---|---|---|
| A | Memory and code map | `useCoderMemory` | 3990–4082 | 9 | `api` | `searchMemory`, `recentMemory`, `getMemory`, `updateMemory`, `removeMemory`, `storeMemory`, `maintenanceMemory`, `resolveMemory`, `loadCodeMap` |
| B | Agent tooling: agent config, MCP, skills, harness import, CLI commands/sessions | `useCoderAgentTools` | 4083–4252 | 27 | `api` | `lintAgentConfig` … `listCliSessions` |
| C | Insights: activity, usage, digest, summaries, crew reads | `useCoderInsights` | 3588–3626 | 8 | `api` | `listActivity`, `listUsageByDay`, `listProviderLimits`, `listDigest`, `markDigestSeen`, `listThreadSummaries`, `listCrewTasks`, `crewIntegration` |
| D | Repo tools: git sync, dev servers, merge lanes, terminal | `useCoderRepoTools` | 3768–3917 | 17 | `api`, `setProjects` | `gitSyncInfo` … `devServerStatus`, `terminal` |
| E | Project CRUD | `useCoderProjects` | 1553–1632 | 4 | `api`, `setProjects`, `setError` | `addProject`, `createProject`, `ensureScratchProject`, `updateProject` |
| F | App updates | `useCoderUpdates` | 1261–1322 | 4 callbacks + 1 **effect** | `api`, `setUpdateStatus` | `applyUpdate`, `checkUpdate`, `downloadUpdate` |
| G | Workflows and automations | `useCoderWorkflows` | 1957–2106 | 11 | `api`, `selectedThreadId`, `setWorkflows`, `setWorkflowListError`, `setAutomations`, `setDetail`, `setError`, `selectedRef`, `threadsRef`, `applyThreads` | `refreshWorkflows`, automations CRUD, `startWorkflowRun`, `retryWorkflowAgent`, `saveWorkflow`, `removeWorkflow` |
| H | GitHub: push, PRs, PR checkout, issues | `useCoderGitHub` | 3376–3587 | 18 | `api`, `selectedThreadId`, `setDetail`, `setError`, `setSelectedThreadId`, `selectedRef`, `threadsRef`, `applyThreads`, `applyThreadUpdate` | `pushBranch` … `fetchIssue` |
| I | Workspace: worktree, diff/review/commit, files, attachments | `useCoderWorkspace` | 3041–3375 | 25 | `api`, `selectedThreadId`, `setDetail`, `selectedRef`, `stagedPathsRef`, `applyThreadUpdate` | `listBaseBranches` … `dropAttachmentFiles` |
| J | Thread actions: stop, permissions, provider/effort, flags, notes, spec/teach/ask/btw | `useCoderThreadActions` | 2107–2924 | 39 | `api`, `selectedThreadId`, `setSelectedThreadId`, `setDetail`, `setError`, `selectedRef`, `threadsRef`, `applyThreads` | `stopRun` … `requestTeachReview` |
| K | Core: state, refs, the 7 effects, `applyThreads`/`reloadDetail`/`refreshTrashed`, queue, status, selection | stays in `useCoder` | 993–1552 | — | — | — |
| L | Thread lifecycle: create/fork/run/rewind, delete/restore/purge, `removeProject`, `applyThreadUpdate` | stays in `useCoder` | 1633–1956, 2925–3040 | — | — | — |
| M | Leftovers: `integrateWorker`, `refreshProviders`, checkpoints/run stats, shell (`threadRootPath` …), verify, settings/stay-awake, `importCliSession`, search/peek | stays in `useCoder` | 3627–3767, 3918–3989, 4253–4287 | — | — | — |

The scan behind the inputs column computes each range's free identifiers against every name declared in `useCoder`. No range's outputs are read by any hook outside it, so every sub-hook's outputs go straight to the `return`.

Module-level helpers move with their only users:
- `errorMessage` is used by K, L, E, G, H, I and J, so it moves to `src/coder/errorMessage.ts`.
- The web attachment helpers (`readFileAsDataUrl`, `isWebImageFile`, `filesToAttachments`, `pickWebFiles`, `pickWebFolder`, `readDirectoryHandle` and their types) are used only by I, so they move to `src/coder/webAttachments.ts`.
- `upsertWorkflow` is used only by G, so it moves into `useCoderWorkflows.ts`.
- `UPDATE_CHECK_INTERVAL_MS` is used only by F, so it moves into `useCoderUpdates.ts` and is re-exported from `useCoder.ts`, where `test/updateCheck.test.tsx` imports it.

None of these helpers were exported from `useCoder.ts`, so the only export-name obligation is `UPDATE_CHECK_INTERVAL_MS`.

## Why the extraction preserves behaviour

Every extracted range is one contiguous run of hooks, cut verbatim, with the sub-hook called at the exact line the range occupied. React keeps hooks in one flat list per component, and a custom hook's hooks are spliced in where it is called. The flattened hook sequence of `useCoder` (state, memo, callback and effect slots, in order) is therefore **identical** before and after each extraction. It is the same slots in the same order, called unconditionally. This covers both rules at once:
- **Effect order is unchanged.** Only domain F contains an effect, and it runs at the same position, between `downloadUpdate` and the boot effect, as before.
- **Hook count and order are stable across renders.** No sub-hook call sits under a condition.

Each moved callback still closes over the same values: either the same module function, or a parameter that holds exactly the value the old closure saw in that render. Its dependency array is unchanged text and has the same meaning. A parameter `selectedThreadId` equals the outer `selectedThreadId` on every render. Setters, refs and `applyThreads`/`applyThreadUpdate` are stable, and omitted from deps exactly as before. Memoized identities therefore change on exactly the same renders as before.

No interleaving proof is needed, because no extracted domain is interleaved. Domain G includes `startWorkflowRun`/`retryWorkflowAgent`, which sit between the workflow and automation callbacks. That makes 1957–2106 one block. Domain F leaves `updateStatus`'s `useState` at line 1022 and takes the setter as an input. Moving the state slot would be harmless, because state slots have no ordering semantics, but leaving it keeps the flattened hook list identical.

## Extraction order

1. **A Memory, B Agent tooling, C Insights.** Their only input is `api`, which never changes. These are pure IPC pass-throughs with no state, no refs and no effects, so they are the lowest possible risk.
2. **D Repo tools.** These are also pass-throughs, except that `setSpotlight` writes `projects` through the stable `setProjects` setter.
3. **E Project CRUD.** These write `projects` and `error`, with stable setters only, and read no state.
4. **F Updates.** This is the first domain with an effect. It touches only `updateStatus` and is self-contained: no other hook reads or writes `updateStatus`. Its effect keeps its position between `downloadUpdate` and the boot effect.
5. **G Workflows and automations.** This is the first domain that reads a changing value (`selectedThreadId`) and writes through the hub (`applyThreads`, `setDetail`, `setError`). Every input is passed through unchanged.
6. **H GitHub.** Same shape as G. `checkoutPr` also moves the selection, through `selectedRef` and `setSelectedThreadId`.
7. **I Workspace.** Same shape. It also moves the web attachment helpers, and reads `stagedPathsRef`.
8. **J Thread actions.** This is the largest block, at about 820 lines. It is mechanically identical to G–I but has the most surface area, so it goes last.

### What stays, and why

- **K, the core, is the boundary.** Its effects depend on their relative order within a commit:
  - effect@1054 updates `selectedRef` before the later effects read it.
  - effect@1067 refreshes `detailRef`/`detailCacheRef` before the detail-load effect@1488 consults both.
  - The boot effect owns `threadsListGen`/`prevStatusRef`/`patchSeqRef` and writes 12 states across every domain.

  Splitting the core means moving effects away from the callbacks they share refs with, or interleaving sub-hook calls between effects. That is not a verbatim, contiguous move.
- **L, the lifecycle (create/fork/run/rewind, delete/restore/purge/`removeProject`).** These read `projects`, `settings` and `selectedProjectId` from the core and are interleaved with the band of thread actions. `createThread` reads three other domains' state. This group is the next candidate, but only after the core has a settled interface.
- **M, the leftovers.** These are small runs of 1–6 hooks between the extracted blocks (`integrateWorker`, checkpoints, shell, verify, settings). Each could move, but the sub-hooks would be tiny and add wiring for no clarity. Leave them until L moves.
