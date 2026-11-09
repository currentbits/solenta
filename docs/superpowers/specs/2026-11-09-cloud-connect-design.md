# Solenta cloud connections

Status: proposed design for #1974. Implementation was requested on 2026-11-09;
the infrastructure choices below are proposed defaults, not user decisions.

## Outcome

An owner links a running Solenta computer to their account once. On another
desktop they sign in, choose that computer, and use its projects, agents,
files and terminals. Reconnecting does not require SSH, a Tailscale account,
router changes, or copying a device token. Work and provider credentials stay
on the execution computer. The computer must remain powered on and have
outbound internet access.

This is the cloud discovery and tunnel phase that was previously deferred.
The existing server, computer identity, device access, direct HTTPS routes,
SSH routes, service lifecycle and host-owned execution remain the foundation.
Research into T3 Code is read-only. No upstream comments, reviews, reactions
or issues are authorized.

Cloud access cannot install software on an arbitrary untouched computer.
Initial setup needs either the installed desktop app or one command run on
the host after installing the standalone runtime. It must not require the
desktop app on a headless Linux machine.

## First release

- Desktop sign-in, account computer list, connect, disconnect and forget.
- Linking and unlinking this desktop computer in Connections.
- Standalone-host CLI sign-in/link/status/unlink/logout using browser approval
  on any device; no remote OAuth callback port.
- An authenticated broker, managed stable HTTPS endpoints, a supervised
  outbound connector and recovery after sleep, network loss and restart.
- Access revocation, credential renewal, meaningful offline/error states and
  a complete deployment/runbook/test path.
- Existing browser access continues through the host's HTTPS endpoint and
  enrollment links. A new hosted multi-computer web dashboard and native
  mobile applications are outside this first release.

One personal account owns each linked computer in this release. No teams,
invitations, billing UI, arbitrary public sharing, cloud-hosted execution or
automatic migration of data from another installation. Do not stop or replace
the older remote desktop service as part of enabling cloud access.

## Proposed infrastructure

Use Clerk's public OAuth application for sign-in, Cloudflare managed tunnels
for reachability, and a small Node service with Postgres on existing Girder
hosting for the broker. The broker is a separate Solenta app and database;
it does not run inside the website, feedback service or desktop process.
Girder already hosts Solenta services; reusing it avoids another deployment
platform solely for the broker. These are builder choices pending confirmation.

Proposed public names are `connect.solenta.app` for the broker/login landing
page and `c-<opaque-id>.connect.solenta.app` for computer endpoints. Names are
allocation-derived, not caller-provided. Confirm zone ownership and certificate
coverage, including nested hostnames, before deploying; select a dedicated
single-level subdomain if the account's certificate setup requires it.

Provision no resources and publish no new network endpoints during design.
The implementation should include checked configuration, migrations, a
container definition, health checks, setup validation and a rollback runbook.
Actual public verification requires configured Clerk and Cloudflare resources.
Missing configuration must produce a setup error, never a fake successful login
or an apparently online computer.

Alternatives considered: SSH remains useful but cannot provide the requested
experience when SSH is denied. A custom WebSocket proxy on Girder would put all
app traffic through a new proxy we would have to operate. Cloudflare manages
that transport; the broker only handles identity, discovery and authorization.
There is no need to adopt T3's framework or copy its service architecture.

## User flows

### Receiving desktop

Connections gains a Cloud area alongside the existing computer routes. Sign in
opens the system browser. A public-client OAuth authorization-code flow uses
PKCE S256, state, a bounded one-use loopback callback, and a strict redirect
allowlist. No OAuth client secret is shipped in desktop or server packages.
Keep OAuth credentials in Electron main and encrypted native storage. A
machine without working secure storage can use a session-only login; it must
not silently write an unencrypted refresh token or put it in localStorage.

After login the UI shows only this account's linked computers. Linking is not
the same as online: show Pending setup, Connecting, Online, Offline, Update
required, or an actionable error based on observed states. Connecting verifies
the public computer descriptor before any host credential is sent and confirms
the same identity after authentication. Reuse the existing host hub and routes
so a cloud route does not duplicate a computer already paired over SSH/LAN.

Show the computer's OS, label, runtime/version and last successful contact.
Keep projects and providers on their owning computer and reuse host settings.
Account sign-out removes local cloud credentials and disconnects cloud routes;
it does not stop remote work, erase direct routes, or unlink the host globally.

### Linking the execution computer

An installed desktop can sign in and choose Enable cloud access for this
computer. A standalone archive gains `bin/solenta-connect` with `login`, `link`,
`status`, `unlink` and `logout` commands and `--data-dir`/`--port` where needed.
`link` starts login if required, then registers this exact computer identity.
Headless login uses Clerk's OAuth device grant: show a verification URL and
short code, honor advertised expiry/poll intervals and slow_down, and stop on
denial/cancellation. Device authorization does not use PKCE or a callback port.

The initial link requires an explicit owner action in the local app or CLI.
The UI/CLI explains that authorized devices on this account can control agents,
terminals and files as the host's OS user. Cloud linking does not create an
additional sandbox or multi-user security boundary.

The server process owns the connector and cloud bootstrap endpoint. The CLI
must not start a second writer or mutate the live store directly. Put cloud
intent and host signing material in separate, atomic, permission-restricted
files under the selected data directory, then notify the running server through
a local authenticated administrative call. CLI operations use the existing
local token only over verified loopback, never through the cloud broker.

Verify the actual runtime identity and listening port before linking. If an old
desktop or another service owns that port, identify the conflict and refuse;
do not reuse a token merely because some Solenta process exists on the machine.
The host's configured port is preserved rather than assuming 4620.

For durable operation reuse systemd/launchd setup and its existing limits.
If a user service manager is unavailable, require an explicitly managed
external server and explain the lack of automatic reboot/crash restart.
Cloud linking does not make an external process into a supervised service.

### Removing access

Disconnect closes a client connection. Forget removes that device's saved
cloud route. Unlink/deregister disables cloud access for this account/computer,
revokes its cloud sessions and stops its connector while preserving work,
files, providers and non-cloud device sessions. Host logout also removes its
OAuth credentials. Service uninstall remains a separate operation.

Deregister works in the broker even while the host is offline. Commit the
authorization revocation before resource deletion. Online delivery attempts
immediate host revocation; a failure is shown as pending rather than claimed
as complete on the host. On reconnect the host reconciles link state before
enabling the tunnel/bootstrap path. Existing cloud sessions have a hard,
short lifetime so access is bounded even if revocation delivery is interrupted.

## Components and data

The broker owns account-to-computer ownership, computer public signing keys,
link generations/revocation, stable tunnel/DNS allocations, provisioning state
and rate limits. Postgres is the source of truth. Use transactions and unique
constraints so concurrent link requests create one allocation and one owner.
Never accept a client's account ID instead of the verified token subject.

The host owns its existing computer ID, an Ed25519 signing key, cloud intent,
its specific connector credential, and cloud-issued rows in the existing
device-access store. It owns repositories, provider auth and execution state.
The desktop owns OAuth credentials, its client proof key and host sessions in
secure storage. Public renderer state contains labels, identifiers and status;
never OAuth refresh tokens, connector credentials or private signing keys.

The broker never receives a provider credential, repository, terminal stream,
thread transcript or reusable host session token. Host list labels and version
metadata are cloud data and must be named in the privacy documentation.
Cloudflare terminates tunnel HTTPS; do not claim end-to-end encryption or an
untrusted broker. The broker is trusted to authorize linked-account access.

Suggested implementation boundaries, using existing JS/TS conventions:

- `connect-api/`: broker routes, verified OAuth authentication, Postgres schema,
  Cloudflare allocation/reconciliation, deployment files and tests.
- `electron/cloudConnect.js`: account login, secure credentials, discovery and
  proof-bound host session establishment for the receiving desktop.
- `electron/cloudHost.js`: host ownership, signed broker requests, connector
  supervision, verified readiness and removal/reconciliation.
- `electron/server/connect.js`: headless CLI on the bundled Node runtime.
- Existing `webDevices`, `webAccess`, `webServer`, `webBridge`, `wireClient`,
  `remoteConnections`, `hostHub` and `remoteHosts`: extend the shared identity,
  enrollment/session, token refresh, revoke and route behavior once.
- Existing IPC declarations/preload/dev API, Settings Connections, packaging
  manifests and native archive tests: carry the feature through every transport.

The final file split is left to the builder. Do not introduce a second RPC
transport, execution backend, device store or home-grown OAuth provider.

## Authentication and bootstrap

Use Clerk-supported verification for the configured OAuth token format. Clerk
supports opaque and JWT OAuth access tokens; do not mistake a decoded JWT or a
Clerk browser session token for a verified OAuth access token. Validate issuer,
approved client, subject, expiry and required scopes. Refresh-token handling is
single-flight and rotation-safe, with revocation on explicit logout.

Account login permits listing owned computers, not trusting arbitrary URLs.
Broker allocation endpoints derive account, computer and origin from committed
ownership/allocation records. No caller-supplied tunnel destinations or HTTP
redirects. Allow only the selected host's loopback HTTP port as connector origin;
reject remote/metadata addresses and forwarded-authority overrides.

For each connection the desktop creates a fresh client proof key and sends its
public-key thumbprint with an authenticated connect request. The broker asks the
linked host for a short-lived, single-use enrollment grant, signed over the
account, computer ID, link generation, client key, nonce, scopes and expiry.
The host verifies those bindings and returns a signed response bound to the
request nonce; the broker verifies the pinned host key before returning it.

The desktop verifies the expected public descriptor and exchanges the grant
directly with the allocated host using proof of the bound client private key.
The broker never receives the resulting host bearer session. Consume the grant
and create the named, expiring device session in one existing store transaction.
Use a reviewed JOSE library where protocol verification needs one; do not
hand-roll a JWT/DPoP parser to avoid a dependency. Reject oversized messages,
wrong audiences, unexpected algorithms, replay, expired proofs and widened scopes.

Cloud host sessions expire after ten minutes and renew at most once per device
at a time before expiry. Renewal requires fresh account authorization and the
same computer/client-key binding, preserves the device identity and chosen
scopes, and atomically updates its credential. Add a tested credential-refresh
path for HTTP requests and the established wire connection: a successful renewal
must not reload the window, interrupt a terminal or lose streamed output.
Failed renewal reports an error; existing access continues only until its actual
expiry. Expiry or revocation closes the corresponding live sockets. Direct/SSH
device-session behavior and historical grants are not silently changed.

## Tunnel and resource lifecycle

Allocate one named, remotely managed Cloudflare tunnel and DNS endpoint per
active computer link. Start a checksum-pinned `cloudflared` binary from an
external cache outside signed app/runtime bundles. Never mutate the signed
application during download, verification or rotation. Broker-wide Cloudflare
API credentials stay on the broker; hosts receive only their connector token.
Keep connector secrets out of argv, logs, URLs and browser state.

Cloud access is Online only after real endpoint readiness verifies the expected
public and authenticated computer identity and exact intended runtime. A spawned
process or allocated DNS record is insufficient. Bound public exposure to the
selected Solenta API; no arbitrary loopback proxy, LAN listener or public SSH port.

Use the host server's lifetime and the existing service manager rather than
installing an independent competing daemon. A crashed connector restarts with
bounded backoff. Sleep/network recovery reuses the stored stable allocation.
Reconcile partial API success using persisted allocation IDs/generations and
deterministic names, never by creating a fresh tunnel on every retry.

The first release caps linked computers per account with server configuration
(proposed default three), rate limits allocation/bootstrap/login entry points,
and cleans resources after explicit deregistration. Offline computers retain
their endpoint and account slot; automatic idle tunnel destruction and billing
are deferred until actual operational need. Cleanup retries are generation-fenced
so an old job cannot delete a revived or replacement allocation. Failed external
cleanup does not restore revoked authorization.

## Verification and acceptance

Use real local HTTP/WS servers and the existing temporary-data/fake-provider
patterns for integration tests. Fake identity/tunnel APIs are test fixtures,
not a production mode and not evidence of a live cloud connection.

Required checks cover:

1. Both desktop PKCE and CLI device approval, including cancellation, expiry,
   polling slow-down, wrong state, token verification failure and refresh races.
2. Ownership isolation: another account cannot list/connect/unlink a computer;
   copied IDs, alternate origins, wrong keys and stale link generations fail.
3. Real descriptor/authenticated identity checks before credentials, one-use
   proof-bound bootstrap, replay refusal, expiry, unchanged scopes and live revoke.
4. Credential renewal while a real terminal and streamed thread remain open;
   missed events resync and ambiguous mutations are not blindly replayed.
5. Concurrent provisioning, partial Cloudflare failure, retries after broker
   restart, stable endpoints, connector crash/reconnect and cleanup races.
6. Actual packaged desktop and standalone startup with supported binaries;
   model/connector downloads leave macOS signatures intact after real use.
7. A configured staging deployment: link the affected Linux host through its
   actual port, connect from the desktop over the public HTTPS endpoint with
   no SSH route, start fake-provider work and a real terminal, disconnect,
   reconnect to the same work, then revoke and prove denial.
8. Native connector checks for supported targets and a service restart check.
   A real reboot/logout check is required before promising those guarantees;
   retain the platform's honest session/linger limitations.

Do not publish a nightly claiming cloud access until staging acceptance passes.
Code that passes local fixtures but lacks configured production credentials is
reported as implemented locally, with live deployment still outstanding.

## Deployment inputs and remaining decisions

Already confirmed: existing Girder Solenta stack, plain-Node server archives,
four native server targets, desktop packaging, identity and scoped enrollment.
No existing Solenta cloud broker was found in the hosting inventory.

Need to configure/confirm: Clerk instance/public OAuth application and grants;
the broker's verification secret; Cloudflare account/zone and tunnel/DNS API
permissions; endpoint DNS/certificate coverage; production public client config;
broker signing/encryption keys and database; consent/privacy copy and per-account
limits. Never commit or print these secrets. The user's latest request authorizes
building the feature; it does not confirm that these resources already exist.

The question currently put to the user is which existing accounts/hosting to use,
with Clerk + Cloudflare offered as the default. Their answer overrides these
proposals. Once the description is approved (or questions are explicitly skipped),
write an implementation plan and proceed with the approved scope.

## Primary references

- [Solenta tracking issue](https://github.com/currentbits/solenta/issues/1974)
- [T3 remote setup](https://github.com/pingdotgg/t3code/blob/ade473018d32003658b7d38693e083ee2e314bd8/docs/user/remote-access.md)
- [T3 Connect architecture and trust](https://github.com/pingdotgg/t3code/blob/ade473018d32003658b7d38693e083ee2e314bd8/docs/internals/t3-connect.md)
- [Clerk device authorization](https://clerk.com/docs/guides/configure/auth-strategies/oauth/device-authorization-grant)
- [Clerk OAuth token verification](https://clerk.com/docs/guides/configure/auth-strategies/oauth/verify-oauth-tokens)
- [Cloudflare Tunnel setup](https://developers.cloudflare.com/tunnel/get-started/)


### Implementation ruling: artifact streaming

Cloud desktop windows use the existing non-persistent per-window browser
partition for an exact-host Secure/HttpOnly/SameSite=Strict cookie restricted
to `/api/run-artifacts`. Main sets it before loading the window, rotates it
before notifying the pinned main frame, and removes it on close. Only the
artifact read route accepts it, with normal per-request device expiry and
revocation checks. This retains ranged video streaming without bearer tokens
in URLs, localStorage, or a whole-video JavaScript blob buffer.
