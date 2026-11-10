# Solenta Cloud Connect Implementation Plan

Status: the user superseded the hosted-default requirement on 2026-11-10.
Official builds have no broker address. User-owned HTTPS tunnels use existing
direct device pairing; the account-based implementation below is optional
self-hosted software. See `docs/cloud-connect.md` for the current setup.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Link a Solenta host to an account and connect from another desktop without SSH or Tailscale SSH permissions.

**Architecture:** Reuse the existing host, wire bridge, computer identity, named device sessions and route hub. A Girder/Postgres broker verifies GitHub OAuth and provisions Cloudflare tunnels. A host-owned connector serves a stable endpoint; signed, client-bound one-use enrollment creates short host sessions directly on the host.

**Tech Stack:** Existing Node/CommonJS and React/TypeScript; Postgres `pg`; reviewed `jose` for signed proofs; GitHub OAuth login app; Cloudflare Tunnel API and pinned `cloudflared`.

**Spec:** `docs/superpowers/specs/2026-11-09-cloud-connect-design.md`, approved by the user's “ok keep building” on 2026-11-09.

## Global Constraints

- T3 Code research is read-only; no upstream interactions.
- One personal account owns each linked computer. Proposed default cap: three linked computers per account.
- Cloud host sessions expire after ten minutes. Renewal is single-flight and preserves device identity and chosen scopes.
- Provider credentials, work and execution remain on the host. The broker never receives a reusable host session.
- No OAuth client secret in public clients. OAuth/connector/private key material never enters renderer storage, logs, argv or URLs.
- Existing direct and SSH routes and their device grants keep working.
- Downloads use an external cache; signed application bundles remain immutable.
- Missing cloud configuration is an explicit error. Fixture success is not live-cloud verification.
- Existing Linux linger and macOS login-session limits apply. An external process has no automatic restart guarantee.

## Review Focus

- A copied computer ID or tunnel hostname cannot transfer ownership or cause credentials to be sent to a different host (tasks 1–2).
- Two simultaneous renewals or link requests cannot revoke the winning credential or create duplicate allocations (tasks 1–3).
- A broker outage cannot masquerade as host logout, erase work or trigger repeated credential prompts (tasks 3–5).
- A retry after partial DNS/tunnel success must reconcile the same allocation; delayed cleanup cannot delete a new link (task 2).
- A running desktop on a different port must not supply a standalone host's token or be stopped by cloud setup (tasks 4–6).

---

### Task 1: Signed enrollment and renewable cloud device sessions

**Files:** Create `electron/cloud/protocol.js`, `electron/test/cloudProtocol.test.js`; modify `electron/webDevices.js`, `electron/test/webDevices.test.js`, root package manifests.

**Interfaces:** `createKeyPair()` produces private/public Ed25519 JWKs; `thumbprint(publicJwk)`, `signProof(privateJwk, claims, purpose, audience, now)`, `verifyProof(proof, publicJwk, { purpose, audience, now })` enforce algorithm, audience, purpose and bounded age. Existing `createWebDevices` gains cloud enrollment/exchange/renew/revoke operations using the same atomic store transactions.

- [ ] Write tests for wrong audience/key/algorithm/purpose, expired/oversized proofs and client key binding. Verify missing module fails.
- [ ] Implement proof handling with `jose`, ten-minute cloud sessions and one-minute mint proofs. Never decode-only authorize.
- [ ] Test one-use enrollment, concurrent consumption, same-client renewal preserving scopes/device ID, wrong account/key/device refusal and cloud-only revocation.
- [ ] Implement cloud fields and operations without widening old or direct grants.
- [ ] Run `node --test electron/test/cloudProtocol.test.js electron/test/webDevices.test.js`; expect all pass. Commit the tested unit.

### Task 2: Broker ownership, OAuth verification and tunnel allocation

**Files:** Create `connect-api/{package.json,package-lock.json,server.js,store.js,cloudflare.js,test.js,Dockerfile,README.md}`.

**Interfaces:** `createBroker({ store, verifyAccount, tunnels, signingKey, fetch, config })` returns an HTTP handler. `createStore(pool)` supplies transactional account ownership/link generations/allocation checkpoints. `createCloudflare({ token, accountId, zoneId, domain, fetch })` derives stable hostnames and configures only a verified loopback origin.

Endpoints: `GET /health`, `GET /v1/config`, `GET /v1/computers`, `POST /v1/computers`, `POST /v1/computers/:id/connect`, `POST /v1/computers/:id/heartbeat`, `DELETE /v1/computers/:id`. Protected routes derive account from verified OAuth token; IDs and keys are never authority by themselves.

- [ ] Write real HTTP tests for account isolation, host registration proof, host-key pinning, limits and bounded requests; confirm missing implementation fails.
- [ ] Implement OAuth-token verification against GitHub's app-authenticated token-check endpoint; check numeric user ID, approved client, identity-only scopes and expiry. Fail closed on provider rejection.
- [ ] Implement Postgres transactions, unique ownership, stable allocation and generation-fenced revoke/cleanup. No in-memory production database.
- [ ] Test partial Cloudflare failure/retry and two concurrent registrations; assert one stable allocation, no caller-provided upstream and no redirects.
- [ ] Implement signed mint request/response with the task-1 protocol; broker returns one-use client-bound grant, never reusable host token.
- [ ] Run `npm test --prefix connect-api` plus actual Postgres integration when available. Commit unit and deployment files.

### Task 3: Public-client OAuth and secure desktop credentials

**Files:** Create `electron/cloud/{oauth.js,credentials.js,client.js}`, `electron/test/cloudOAuth.test.js`, `electron/test/cloudClient.test.js`.

**Interfaces:** `createOAuth({ issuer, brokerOrigin, clientId, fetch, openExternal, now })` exposes `login({ headless, onCode, signal })`, `refresh(credentials)`, `revoke(credentials)`. `createCredentials({ file, safeStorage, allowPlaintext })` reads/writes/deletes bounded atomic files; desktop defaults to encrypted or session-only, CLI explicitly permits 0600 storage. `createCloudClient({ config, credentials, fetch, openExternal })` exposes `status`, `login`, `logout`, `computers`, `session(computerId)`, `deregister(computerId)` and `close`.

- [ ] Write PKCE callback tests for wrong state, duplicate callback and cancellation; device grant tests assert interval/slow_down/expiry handling.
- [ ] Pin GitHub endpoints; use broker-only secret for desktop PKCE/refresh and direct headless device grant; test provider errors and timeouts.
- [ ] Implement secure storage and single-flight refresh/rotation; test failed refresh preserves valid credentials and logout clears state.
- [ ] Test a real local broker/host bootstrap: validate descriptor before exchanging, verify host response and present client-bound proof directly to host.
- [ ] Implement cached sessions with rotation before ten-minute expiry and notifications to connection owners. Preserve established work until actual expiry/revocation.
- [ ] Run focused Node tests and commit.

### Task 4: Host connector, administrative control and standalone CLI

**Files:** Create `electron/cloud/{host.js,connector.js,config.js}`, `electron/server/connect.js`, `electron/test/cloudHost.test.js`; modify `electron/main.js`, `electron/webAccess.js`, `electron/webServer.js`, `scripts/package-server.sh`, relevant server/package tests.

**Interfaces:** `createCloudHost({ dataDir, devices, descriptor, port, credentials, config, connector })` exposes `status`, `link`, `unlink`, `handleRequest(req,res)`, `start`, `close`. Only the host process writes live device access. The CLI invokes local authenticated cloud administrative RPC after verifying descriptor/data directory identity.

- [ ] Test host link generation/account/key checks, wrong loopback port and a legacy HTML listener; assert no second writer, process stop or token selection by unrelated PID.
- [ ] Implement server-owned `/api/cloud/mint` and `/api/cloud/exchange`; verify signed bindings/replay and use task-1 transactions. Integrate through existing server request handler.
- [ ] Implement deterministic connector download into external cache with pinned checksum and supported targets. Launch with token in restricted environment/file, never argv. Test checksum failure and bounded crash restart.
- [ ] Test link-state reconciliation before serving after restart and unlink while offline; revoke only cloud devices, close sockets and preserve work/direct devices.
- [ ] Implement the bundled `solenta-connect` CLI and explicit service/external behavior using existing lifecycle owner; package its launcher.
- [ ] Run host/server/package tests and commit.

### Task 5: Desktop route integration and Connections UI

**Files:** Modify `electron/remoteConnections.js`, `electron/hostHub.js`, `electron/ipc-app.js`, `electron/ipc.js`, `electron/preload.js`, `src/shared/{ipc.ts,ipcChannels.ts}`, `src/{App.tsx,remoteHosts.ts,wireClient.ts,devCoder.ts}`, `src/components/{ConnectionsSection.tsx,SettingsModal.tsx}`, fake API/test fixtures. Add a narrowly scoped remote-window credential-update preload if required.

**Interfaces:** App API exposes cloud status/login/logout/computers/link/unlink/connect through explicit methods. Saved cloud routes carry verified `computerId` and cloud account/computer references, not secrets. Shared connection code resolves current cloud session on reconnect; wire credential replacement reauthenticates the same device without renderer reload.

- [ ] Grep every caller of shared connection/token methods before editing.
- [ ] Add renderer tests for sign-in failure, account computer list, unavailable configuration, offline host, connect, sign-out and unlink semantics.
- [ ] Implement Cloud area using existing Settings controls and existing host settings, with honest observed states.
- [ ] Extend IPC/preload/shared/dev/fake APIs together; regenerate the checked IPC declarations using the repo script.
- [ ] Add real WS tests for session rotation during terminal output; identity/scopes/device ID must remain pinned. Revoked/expired sessions close with access-denied handling.
- [ ] Run typecheck, relevant renderer tests and hostHub/connection/wire integration tests; commit.

### Task 6: Package, deployment and real cloud acceptance

**Files:** Modify root package dependency staging in `scripts/package-app.sh`/`scripts/package-cross.sh`/`scripts/package-server.sh`, CI focused tests, user docs/privacy and `connect-api/README.md`; add a staging acceptance script using the existing fake-provider/server smoke patterns.

- [ ] Test packaged resolution of all new runtime dependencies and launcher --help; ensure connector/model cache writes occur outside signed bundles.
- [ ] Run meaningful full relevant checks: root typecheck, renderer Connections/wire tests, cloud/broker/identity/device/server lifecycle tests, package checks.
- [ ] Configure a separate Girder broker app/Postgres and public GitHub/Cloudflare settings when credentials are available. Verify exact deploy plan before publishing public access.
- [ ] Run staging link on the existing Linux host at 4621 without touching the 4620 desktop. Connect through HTTPS with SSH disabled in the acceptance client, run fake-provider work and a real terminal, reconnect and revoke.
- [ ] Perform native connector/service checks and post-use macOS signature checks before cutting a release. Report any missing real-platform or reboot coverage precisely.
- [ ] Obtain a fresh whole-branch security/correctness review, resolve findings, open a Solenta PR and record actual acceptance results on #1974. Never mark cloud complete based only on fixtures or an allocated tunnel.

## Execution

The user approved the design and explicitly requested continued building. Execute
natively in the isolated branch, making one tested commit per unit; reserve an
independent reviewer for the complete trust boundary before publication. Do not
ask the user again for routine code/plan choices already covered by that approval.
External account setup can proceed independently of local implementation; secret
values must be supplied through secure deployment configuration, not chat.

## Approved authentication update, 2026-11-10

The user chose direct GitHub login instead of Clerk. Update OAuth client,
broker verification/exchange/revocation, desktop/CLI callers, auth fixtures,
login copy and deployment docs. Preserve host sessions, tunnel routing and
scope/revocation guarantees. Use a dedicated login-only OAuth app, expiring
tokens, state/S256 PKCE on desktop and device authorization on headless hosts.
Test wrong-app/expired/broad tokens, immutable IDs, bounded PKCE callbacks,
refresh rotation, single-token sign-out and public-config secret exclusion.
Live GitHub/Cloudflare acceptance remains required before release.
