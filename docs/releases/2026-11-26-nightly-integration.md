# T3-inspired work integrated into v0.29

The source branch `feat/solenta-environments` ended at a991e44b on a v0.22
baseline. This nightly integrates its missing behavior onto v0.29 at 3e46f49b.
The two histories had 680 main-only commits and 14 feature-only commits;
merging the old implementation wholesale would replace newer systems.

## Retained from v0.29

- Remote computers, host-owned projects and threads, and cross-computer workers.
- SSH server installation, lifecycle management, identity checks and recovery.
- Direct device links over Tailscale/LAN without a Solenta account.
- Cloud Connect and the standalone `solenta-server`, `solenta-service`, and
  `solenta-connect` commands packaged with the headless server releases.
- Connection setup instructions in Settings.
- Transcript search, turn navigation, history paging and the follow/latest UI.
- The central shortcut registry, conflict handling and editable Keyboard settings.

These supersede the branch's separate EnvironmentWorkspace/environmentHub,
server runtime, transcript navigation, and smaller keybinding implementation.
No old runtime or parallel preference system is carried forward. The earlier
branch's research notes describe that older baseline, not missing v0.29 features.

## Integrated behavior

- A dismissible GitHub star prompt after 20 minutes of active foreground use.
  Desktop claims it atomically in user data before showing it, at most once
  across windows and restarts. Background/sleep time does not count, and setup
  dialogs and other toasts defer it. It disappears after 30 seconds.
- Conversation preferences under Settings > Threads: follow-up action, tool
  detail, run duration, Vim motions and screen-reader announcements.
- Queue/Steer is a live shared preference. The send button names its action;
  the alternate send shortcut uses the opposite action once without changing
  the preference. Unsupported agents queue. Existing remapped chords remain.
- Search in the keyboard shortcut reference, including current remapped chords.
- Copy conversation as Markdown and copy branch name in thread actions.
  Paged conversations require loading full history before copying; clipboard
  errors are visible. Tool payloads and reasoning are excluded.
- A polite live region announces run transitions and pending input, scoped to
  the selected host/thread. Streaming updates stay quiet; final reply previews
  and thread titles are configurable. This has DOM-level coverage, not a
  manual VoiceOver certification.

## Validation

Passed before packaging: typecheck and generated preload parity, all 4,047
renderer tests, and 77 selected IPC/web/remote regressions. The release scripts
verify the signed macOS bundle and extracted archive. Linux and Windows runtime
verification uses the published-package workflow.
