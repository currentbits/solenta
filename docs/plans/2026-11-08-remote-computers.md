# Remote computers rebuild

Tracker: #1968. Implementation units: #1969 identity/routes, #1970 lifecycle/update, #1971 setup/host settings, #1972 browser enrollment.

## Ownership contract

A computer is the owner of its data directory, provider credentials/configuration, projects, runs, terminals and files. An SSH tunnel or direct HTTP(S) endpoint is a route to that computer. Disconnecting a client does not stop host work. Forgetting a route does not uninstall a server. Revoking a device is distinct from both. SSH-project command execution remains a different mode, not the implementation of a full remote computer.

Existing backend/store/runner/shared IPC handlers remain the execution authority. Implement one remote computer model around them; do not introduce a second execution engine or copy local provider credentials onto another host.

## Core interfaces

- Persist one opaque computer identity per data directory, using an atomic create/read path. Public descriptor at `/.well-known/solenta` identifies kind, computer ID, wire protocol range, runtime kind and nonsensitive build/capability information. It must disclose no tokens, paths, projects or accounts. Authenticated wire/status must confirm the same identity.
- Descriptor lookup precedes sending a saved credential whenever an expected computer identity is known. A mismatch blocks the attempt and preserves the existing saved identity. An initial legacy host can connect through an explicit compatibility path; do not silently bypass a failed identity check for an already-bound computer. SSH/TLS retain their trust roles; opaque identity is not cryptographic attestation.
- Keep optional, backward-compatible descriptor fields in shared IPC/wire types. Use `computerId` consistently. Runtime kind is `server` or `desktop`, with releaseTag/buildSha/version when actually known; never manufacture metadata.
- Saved connections migrate from address-only rows without dropping credentials. Group verified routes to one computer, retaining per-route credentials and user ordering. Only verified authenticated identity can merge rows. Same repository/path elsewhere does not imply same computer.
- Preserve existing `onHost` routing for global calls with no thread/project ID. Provider/profile/model/settings discovery and application must use one owning host consistently. Offline host calls fail explicitly; no local fallback.
- Lifecycle is a focused module owned by the Node launcher/SSH adapter, with explicit managed versus external operation. One process holds exclusive data-directory ownership. Install/start/status/logs/restart/update/uninstall are distinct operations; neither a health probe nor Disconnect implicitly installs/stops anything.
- Lifecycle status and capabilities are factual. Linux systemd-user/linger and macOS launchd login-session behavior are separate adapters. No Windows background-server promise without native distribution/lifecycle evidence.
- Node runtime updates never invoke the Electron desktop installer. Stage and verify immutable versions; stop/quiesce before state migration; validate ready build identity; retain old executable/state on failure. Refuse active-work interruption by default. A reconnect alone is not successful-update evidence.
- One reconnect owner per computer, with bounded/jittered retry and stale-generation fencing. Data freshness is separate from socket state. Reauth/host-online resyncs selected thread and mounted terminal tail/exit, including an outage containing the final event. Never automatically replay a mutating request with an ambiguous reply. Any future retry contract requires persisted operation IDs/receipts.
- Browser enrollment uses hashed, five-minute single-use grants, exchanged atomically for scoped thirty-day named-device sessions. Check computer identity before exchanging the credential, remove link fragments before app initialization, and close expired/revoked sockets. Reusable direct links and existing legacy tokens retain their separate lifetime.

## User journey

Add computer -> SSH or existing address -> check prerequisites/runtime -> prepare/connect -> host agent readiness and sign-in -> host project/first thread. The saved computer shows its actual route, runtime/build, status and available lifecycle actions. Local settings remain local; remote agent controls identify the owning computer.

## Implementation and verification order

1. Agree these boundaries and inspect the pinned source/tests. Three isolated workers implement identity/routes, lifecycle/update, and setup/host settings. Shared-contract overlap is integrated deliberately, not overwritten.
2. Root integrates and owns reconnect/terminal consistency and cross-cutting acceptance. Test each unit before integration and the combined flow afterward.
3. Validate descriptor/credential mismatch, legacy migration, duplicate route/IDs, host-specific providers/profiles, socket loss and final terminal exit, repeated/concurrent bootstrap, duplicate data-dir launch, unavailable service manager, checksum/trial failure and actual runtime update routing.
4. Run relevant typecheck, renderer/backend suites, packaged server smoke and visual checks. Native reboot/service claims require evidence on the promised host/platform; command mocks are not such evidence.
5. Review and open coherent PR(s). Planboard remains doing until delivered work is actually merged. Record any unsupported infrastructure/platform guarantee explicitly.

## Managed public access boundary

Account discovery plus a managed outbound tunnel requires actual identity, broker/DNS/connector infrastructure and deployment configuration. Keep the connection model extensible for that route without building fake login/tunnel success states or claiming a deployed service. Existing direct HTTPS/Tailscale and SSH must stand on their own. A trusted authorization broker is not zero-trust/end-to-end encryption by default.
