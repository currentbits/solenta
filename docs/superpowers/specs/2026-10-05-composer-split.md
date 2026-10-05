# Composer split (issue #1447, round 4, pass K)

`src/components/Composer.tsx` is 3,531 lines; `const Composer` alone runs
from line 474 to 3531. This note maps its state and picks what can move into
`src/components/composer/` without changing behaviour.

Line numbers refer to `origin/main` at 6763da60.

## Ground rules

- React runs effects (and, separately, layout effects) in declaration order.
  A custom hook's effects run where the hook is called. So a block may only
  move as a unit, called at the exact spot it occupied, unless the block
  contains **no effects at all**. `useState` / `useRef` / `useCallback` /
  `useMemo` / `useId` have no ordering side effects. Reordering them only
  changes hook slot numbers, which must merely be stable across renders.
  That is the independence argument used below for the mention and slash
  hooks.
- Hooks stay unconditional; bodies, dependency arrays, refs and DOM stay
  verbatim.

## State map

R = reads, W = writes. "render" means the JSX or render-scope code.

### Draft core (lines 528-604)

| Hook | Line | Read by | Written by |
|---|---|---|---|
| `useTranscriptViewMode()` | 530 | controls `data-transcript-view-mode` | uiPrefs store |
| `draftsRef` (module map `keptDrafts`) | 551 | every draft helper, textarea `defaultValue`, threadId effect | rememberDraft, writeDraft, writeDraftFor |
| `textareaRef` | 552 | almost everything | textarea `ref` |
| `overflowRef` | 553 | syncOverflow | overflow `<div>` |
| `pasteCardsRef` | 554 | syncOverflow | render (`= pasteCards`, line 904) |
| `syncOverflow` cb | 555 | rememberDraft, writeDraft, writeDraftFor, paste-card effect | — |
| `hasPrompt` state | 565 | canSend, canBuild, workflowRunTitle | syncHasPrompt |
| `syncHasPrompt` / `rememberDraft` / `writeDraft` / `readDraft` cb | 566-597 | everywhere | — |
| `liveThreadIdRef` | 598 | writeDraftFor | render |
| `sending` state | 600 | canSend, mic, drop, paste, attach, focus effect | runAction |
| `busyAction` state | 601 | send title, submitSend, steer toggle | steer toggle |
| `localError` state | 604 | shownError | ~15 call sites |

### Vim (531-537)

`useComposerVimEnabled()`, `vimMode` state, `vimStateRef`, effect that
resets both on `[threadId, vimEnabled]`. R: onKeyDown, textarea
`data-vim-mode`, vim chip. W: onKeyDown. **Contiguous**, one effect.

`viewOpen` state (538) belongs to menus (read by anyMenuOpen, closeAllMenus,
submitSend; nothing renders a view menu anymore, #1411).

### Speech-to-text (605-807)

`hasSpeech`, `speech` / `speechConfirm` / `dictating` state,
`snapshotRef` / `captureRef` / `dictatingRef`, `writeDraftFor`,
`cancelDictation` + `cancelDictationRef`, `applySpeechStatus`,
effect: subscribe to `speech:changed`, effect: cancel on `disabled`,
`startDictation`, `stopDictation`, `onMicClick`, `confirmSpeechDownload`.

- Inputs: `threadId`, `disabled`, `sending`, `draftsRef`, `textareaRef`,
  `liveThreadIdRef`, `readDraft`, `syncHasPrompt`, `syncOverflow`,
  `setLocalError`; all declared above line 605.
- Outputs used elsewhere: `snapshotRef` and `cancelDictationRef` (Esc
  handler 1470-1473, threadId effect 1085), and the mic pill's `hasSpeech`,
  `speech`, `speechConfirm`, `setSpeechConfirm`, `dictating`, `onMicClick`,
  `confirmSpeechDownload`; `dictating` also sets textarea `readOnly`.
- **Contiguous**, two effects.

### Restore draft (813-820)

`appliedRestoreRef` + one effect. Contiguous, but 8 lines; not worth a file.

### Attachments (826-892)

`attachmentsByThread` state (module map `keptAttachments` via `keepList`),
`attachments`, `addAttachments`, effect: strip images when the model can't
take them, effect: consume `incomingAttachments`, `removeAttachment`,
`clearAttachments`.
Inputs: `threadId`, `canAttachImages`, the three `incomingAttachment*`
props. R by: submitSend/Steer, stash, paste, drop, chip row.
**Contiguous**, two effects.

### Paste cards (893-931)

`pasteCardsByThread` state (`keptPasteCards`), `expandedCardIds` state,
`pasteCards` (+ `pasteCardsRef.current = pasteCards`), effect: re-sync the
overflow counter, `addPasteCard`, `removePasteCard`, `clearPasteCards`.
Inputs: `threadId`, `pasteCardsRef`, `syncOverflow`, `readDraft`.
**Contiguous**, one effect.

### Stash (932-934, 1678-1723)

`stashToast` state + plain render-scope functions (`applyStashEntry`,
`stashCurrent`, `restoreStash`, `undoLastStash`) that close over
`composeOutgoing`, attachments, paste cards, model, effort, `onSetProvider`,
`onSetReasoningEffort`, `onClearReply`. No effects. Its functions are
declared far from its state and need a large chunk of the rest of the
component; leave it.

### Pill menus and model picker (935-986, 1254-1458)

States `modeOpen`, `modelOpen`, `effortOpen`, `customFor`, `customDraft`,
`highlightIndex`, `modelQuery`, `favourites`, `favouritesOnly`, `setupFor`,
`optionsOpen`, `attachOpen`, `bestIds`, `manageOpen`, `menuGuardSeen` (with a
render-time adjustment, 960-969), `templateByThread`, `glider`; refs
`bestOfFocusRef`, 10 wrap/popover refs, `returnFocusToOptions`; `useId`.
Effects in order: mousedown outside-close (1254), model-open reset (1286),
glider measure (1318), `useEscapeClose` (1402), `useModalFocus` x2 (1406-7),
layout: options placement (1410), bestOf focus (1440), layout: return focus
after Manage (1453).

R/W are cross-cutting: `acceptCommand` (slash), `submitSend` (`/workflow`,
`/bestof`), `pickAttachments`, `submitBuild`, `submitBestOfN` and every pill
`onClick` open or close these menus. The model-open effect calls the
render-scope `pickerRowsFor`.

### @-mention menu (988-997, 1089-1159)

`mention`, `mentionFiles`, `mentionIndex` state; `mentionTimer`,
`mentionSeq` refs; derived `mentionOpen`; `closeMention`, `refreshMention`,
`acceptMention`, `browseMentionFolder` callbacks. **No effects.**
Inputs: `textareaRef`, `onListFiles`, `onPickMentionFolder`, `disabled`,
`writeDraft`, `setLocalError`. R by: onKeyDown (arrows/Enter/Tab/Esc),
runAction, textarea onChange/onSelect, vim path, the listbox, `popupOpen`.

### Slash menu (999-1078)

`command`, `commandIndex` state; `commandDismissed` ref; derived
`commandMatches`, `commandOpen`; `closeCommand`, `refreshCommand`,
`acceptCommand`. **No effects.** `lastEscAt` (1010) sits inside the block
but belongs to the Esc handler.
Inputs: `textareaRef`, `cliCommands`, `disabled`, `busy`, `writeDraft`,
`setModelOpen`, `setModeOpen`, `setEffortOpen`, `setOptionsOpen`,
`onModelPickerOpen`, `onSlashAction`.

### Thread switch effect (1080-1087)

Resets `commandDismissed` and `lastEscAt`, re-syncs `hasPrompt`, cancels
dictation on cleanup. Mixes three concerns. Stays in Composer.

### Focus on thread open (1170-1180)

`focusedThread` ref + effect. Order-sensitive (must follow the speech and
restore effects; must precede nothing that refocuses). Stays.

### Derived render values (1183-1252)

Template selection, `canSend`, `locked`, `canBuild`, `shownError`, picker
rows, efforts, permission labels. Plain expressions, no hooks.

### Esc interrupt (1460-1497)

`popupOpen` + one document `keydown` effect: popup open → ignore; chrome
owns Esc → ignore; dictating → cancel; busy → stop run; idle → double-Esc
rewind. Inputs: `disabled`, `busy`, `popupOpen`, `onStopRun`,
`onSlashAction`, `textareaRef`, `snapshotRef`, `cancelDictationRef`,
`lastEscAt`. **One effect**, contiguous.

### Transcript view shortcuts (1499-1529)

One window `keydown` effect, `[]` deps, no inputs (⌃⌥F, ⌃O). **Contiguous.**

### Actions and handlers (1531-2163)

`composeOutgoing` (useCallback), `runAction`, `submit*`, best-of-N, stash,
`onKeyDown` (textarea key precedence: ⌘S stash → mention → slash → ⌃C
stop → ⌥Enter btw → ⌘⇧Enter steer → ⌘Enter send → vim), paste, attachment
pick, `acceptDroppedFiles` (useCallback) + `useFileDrop` (effects inside),
model/profile/effort/permission pickers, model nav keys. Mostly plain
functions closing over most of the component.

## Candidate extractions

| # | Unit | Kind | In | Out | Effects | Risk |
|---|---|---|---|---|---|---|
| 1 | `AttachmentChip` | component | attachment, onRemove, onLoadImage | DOM | own | none: already a separate component |
| 2 | `useComposerVim` | hook | threadId | vimEnabled, vimMode, setVimMode, vimStateRef | 1 | low: contiguous, one effect |
| 3 | `useComposerSpeech` (+ `coderSpeech`, `coderOn`, `SpeechSnapshot`, `speechMicLabel`) | hook | see Speech | see Speech | 2 | low: contiguous; largest body |
| 4 | `useComposerAttachments` (+ `keepList`) | hook | threadId, canAttachImages, incoming* | attachments, add/remove/clear | 2 | low: contiguous |
| 5 | `usePasteCards` | hook | threadId, pasteCardsRef, syncOverflow, readDraft | pasteCards, expandedCardIds, setExpandedCardIds, add/remove/clear | 1 | low: contiguous |
| 6 | `useMentionMenu` | hook | see Mention | state, mentionOpen, callbacks | 0 | low: no effects, so moving the callbacks up next to the state cannot reorder anything |
| 7 | `useSlashMenu` | hook | see Slash | state, commandDismissed, matches, callbacks | 0 | low: no effects; `lastEscAt` moves below the call (ref, no effect) |
| 8 | `useTranscriptViewShortcuts` | hook | — | — | 1 | low: one effect, called in place |
| 9 | `useEscapeInterrupt` (+ `escapeConsumedByChrome`, `DOUBLE_ESC_MS`) | hook | see Esc | — | 1 | low-medium: keyboard precedence; same listener and same registration order when called in place |
| 10 | `useOptionsPopoverPlacement` | hook | optionsOpen, two refs | — | 1 layout | low: one layout effect, called in place |
| 11 | `SpeechControls` (mic pill + confirm) | component | speech, dictating, flags, handlers | DOM | 0 | low |
| 12 | `PasteCardList`, `ReplyChip`, `MentionList`, `CommandList` | components | props | DOM | 0 | low: pure JSX moves |
| — | Model picker (state + 3 effects + popover JSX) | hook + component | ~30 values | — | 3 | **high**: state is opened and closed from slash, submitSend, attach and every pill; effects are interleaved with the mousedown effect and `useEscapeClose`/`useModalFocus`; reset effect calls the render-scope `pickerRowsFor` |
| — | Options / workflow / best-of-N popover | component | ~20 values | — | 3 | medium-high: `menuGuard` render-time adjust, two focus layout effects tied to `manageOpen` |
| — | Stash | hook | ~12 values | — | 0 | medium: needs most of the submit path; little to gain |
| — | `onKeyDown` / submit path | — | everything | — | 0 | high: key precedence is the contract; splitting it spreads one ordered chain across files |
| — | Focus-on-open, thread-switch effect | — | — | — | 2 | high: order-sensitive, mixed concerns |

## Extraction order

1-12 in table order: presentational component with no hook impact first, then
contiguous hooks with one or two effects, then effect-free hooks whose
independence argument is above, then the single-effect keyboard and layout
hooks, then JSX-only components. Each is one commit, verified by typecheck,
`vite build`, the renderer suite TAP count and an indentation-insensitive
pure-move diff.

Stop before the model picker: it is the next-largest concern, but its
state is written from four other concerns and its effects sit between the
mousedown and focus-trap effects, so it can't be moved as one in-place
block.

## Outcome

Items 1-12 landed, one commit each, all at 2701/2701 on the renderer
suite. Composer.tsx went from 3,531 to 2,659 lines. Items 1-12 in the
table map to files under `src/components/composer/`; item 12 became
`ComposerPopups.tsx` (MentionList, CommandList), `ReplyChip.tsx` and
`PasteCardList.tsx`, and item 11 is `SpeechControls.tsx`. The model picker
and the rows after it remain, for the reasons in the table.
