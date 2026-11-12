# Agent-authored MCP connector proposals

Implemented 2026-11-12. Tracking: [#2004](https://github.com/currentbits/solenta/issues/2004).

Synara [#2049](https://github.com/Emanuele-web04/synara/pull/2049) and its
[proposal card](https://github.com/Emanuele-web04/synara/blob/83e0533b23099908ee14e4fecacd5ed702f4d453/apps/web/src/components/settings/McpConnectorProposalCard.tsx)
provide the interaction: preparing a connection is inert; Review reveals details
before Approve changes the owning computer's registry. Solenta implements that
interaction using its existing MCP validation, settings/secret storage, provider
configuration synchronization and shared UI styles. No upstream code was copied.

## Use and ownership

The thread MCP tool `mcp_propose` takes the caller's thread/project, an `add` or
`remove` action, and `config`. Adding accepts a new server name and either a local
stdio command/argument array/working directory or an HTTP/SSE URL. `envNames` and
`headerNames` request credentials without carrying values. Removal needs only the
existing name. The bound MCP caller cannot place a proposal on another thread.

The proposal appears beneath the thread transcript. Review displays the exact
command, JSON argument array and working directory, or normalized URL. It names
the global effect across projects on this computer. Approving local commands
requires a separate trust checkbox; requested credentials are entered into masked
fields on the desktop. Dismissal changes only the proposal.

Only the owning host's `desktop` IPC transport can resolve a proposal. Web clients,
including full-access devices, cannot approve or dismiss through the new endpoint.
The agent tool exposes no approval action. Existing MCP Settings APIs keep their
existing behavior and permissions; this is a review workflow, not a restriction
on an agent's general filesystem or shell access.

## Lifecycle and boundaries

- Proposals are stored on their thread, capped at ten records and 16 KiB of
  configuration per proposal. Identical pending requests are deduplicated.
  Resolved/expired history can be discarded; active reviews are never evicted.
  Approval expires after 24 hours. Deleted threads cannot create/approve proposals.
- A private fingerprint binds the current definition of the proposed server,
  including credential/enabled-state changes, to the original project identity/path.
  A same-name change, project move/retarget or expiration makes approval stale.
  Unrelated connector changes are preserved. SSH projects
  cannot propose or approve local changes through this initial workflow.
- A review token binds approval to the precise proposal contents. Changed contents
  close the review UI and require fresh review/trust. Fingerprints are excluded
  from public thread detail, and proposal records are omitted from sidebar lists.
- All approval validation and registry/proposal mutation is synchronous, preserving
  the existing single-process atomicity between concurrent IPC requests. A missed
  detail push does not report a successful registry change as failed.
- Existing MCP validators handle names, reserved built-ins, transports, URL
  credentials, command/argument limits, absolute directories, headers, protected
  environment keys and cross-server environment agreement.
- Literal token/header/environment maps are rejected in proposals. URLs cannot
  contain queries or fragments. Credential values travel only through desktop
  approval into the existing encrypted settings path, never into proposal records,
  result payloads or transcript content. Agents are instructed not to embed
  credentials in command arguments or other text; arbitrary strings cannot be
  reliably classified as secret values.
- Registry changes use existing provider configuration synchronization. They apply
  to new agent sessions. Existing CLI sessions may retain their loaded tools until
  restarted; this workflow does not interrupt or revoke an active tool invocation.

Editing/replacing existing connectors and bulk imports stay in Settings.
OAuth initiation and remote-host proposal review are omitted. Provider-specific support and failures continue
to follow existing MCP behavior; approval does not guarantee a server will start.

## Verification

Focused backend checks cover inert creation, persistence/restart with encrypted
credentials, dedup/caps, private-field redaction, exact review identity, local trust,
credential validation, removal/dismissal, stale registry/owner changes, expiration,
deleted threads and desktop-only resolution. Existing MCP validation/IPC, real MCP
tools/list schema, own-thread dispatch, web scopes and IPC seam suites also run.
Renderer tests exercise the review card, stale props, web-client restrictions,
ThreadView routing and the real App/useCoder/preload-method chain.
The final focused run passed 134 backend and 175 renderer checks, plus typecheck,
preload synchronization and diff checks.

A real Electron fixture mounted the actual card and shared styles through Vite,
with a sandboxed preload invoking production `mcp:resolveProposal` against a
temporary Store. It verified an initially empty registry, disabled approval before
credential/trust input, one approved registration, a detail refresh and no credential
value on the stored/public proposal. The inspected screenshot is
`/tmp/solenta-mcp-proposal-review.png`.

The committed fixture sets provider write overrides itself, so direct execution
also stays isolated. During development, one earlier unisolated IPC test reached
the installed Grok CLI; its recovery reported restoring the exact pre-write config.
Subsequent runs disable Grok/Cursor writes and redirect Kimi into each fixture's
temporary directory. No live connector was intentionally installed for verification.

No signed packaged build, installed-app upgrade, real server/OAuth handshake or
main-branch integration was tested. Changes remain local to this worktree branch.
