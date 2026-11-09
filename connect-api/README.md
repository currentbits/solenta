# Solenta Connect broker

This separate Node/Postgres service owns account-to-computer links and allocates
Cloudflare tunnels. Agent credentials, work and reusable host sessions stay on
the execution computer. Cloudflare terminates HTTPS and this broker is trusted
to authorize account access. This is not end-to-end encryption.

Run `npm ci --prefix connect-api`, then `npm start --prefix connect-api`.
Build the container from the repository root:
`docker build -f connect-api/Dockerfile -t solenta-connect .`.
The container stages the shared proof code beside its dependencies.

Configure secret values through the deployment's secret/environment settings,
never in committed files or command arguments:

| Setting | Value |
| --- | --- |
| `DATABASE_URL` | Dedicated Postgres database; no user/project content |
| `CONNECT_ORIGIN` | Exact public HTTPS broker origin |
| `CLERK_ISSUER` | Exact Clerk instance HTTPS origin |
| `CLERK_CLIENT_ID` | Approved public OAuth application's client ID |
| `CLERK_SECRET_KEY` | Matching instance's Backend API key, broker only |
| `CONNECT_SIGNING_JWK` | Persistent private Ed25519 JWK, broker only |
| `CLOUDFLARE_API_TOKEN` | Account tunnel and selected-zone DNS permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `CLOUDFLARE_ZONE_ID` | Dedicated host domain's zone ID |
| `CONNECT_HOST_DOMAIN` | Hostname suffix, e.g. `hosts.example.com` |
| `CONNECT_MAX_COMPUTERS` | Personal account limit, default 3 |
| `PORT` | Internal HTTP port, default 3000 |

Enable Clerk public-client authorization code with PKCE, rotating refresh
tokens and device authorization. Register the desktop loopback callback and
enable device grants for this application. Configure opaque access tokens for
prompt revocation. Verification uses Clerk's authenticated
[`/oauth_applications/access_tokens/verify`](https://clerk.com/docs/guides/configure/auth-strategies/oauth/verify-oauth-tokens)
endpoint and checks the approved client, user subject, expiry and revocation.
The API key's instance is the issuer authority; it must match `CLERK_ISSUER`.
Delegated actor tokens are refused. Public clients receive no client secret.

Cloudflare's [remotely managed tunnel API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/methods/create/)
provides a per-link tunnel and connector token. A derived `c-<link-id>` DNS name
routes only to `http://127.0.0.1:<host-port>`, with a final 404 ingress rule.
The host domain must have TLS coverage for these names. A wildcard certificate
for `example.com` does not cover `c-<id>.hosts.example.com`; verify coverage or
use a dedicated zone. Do not deploy until that coverage is confirmed.

Postgres transactions enforce ownership, pinned host keys and account limits.
Provider allocation failures persist their checkpoints; retry the same link to
reconcile deterministic tunnel/DNS names. Unlink commits revocation before
attempting host notification and provider deletion. Failed cleanup is reported
as pending and can be retried with DELETE. A later re-link gets a fresh link ID;
old cleanup cannot delete its resources. Pending allocations also have a cap
of twice the linked-computer limit. Registration retries reconcile retired
allocations. Offline hosts must reconcile the signed link status before
restarting their connector. Until notified, already-issued sessions last at
most ten minutes.

Deploy one broker replica initially. Per-account and direct-peer rate limits
are process-local and bounded; use edge rate limiting for multi-replica
deployments. The service ignores caller-supplied forwarding headers. Girder's
proxy peer therefore also shares the direct-peer budget. Do not log request
bodies, authorization headers, connector tokens or mint responses. Return only
sanitized errors. Restrict database backups and environment access.

`GET /health` is public. `GET /v1/config` returns public login and signing
configuration. Account-authenticated routes list/register computers, mint a
one-use client-bound grant or revoke a link. Host-signed heartbeats reconcile
link state without an enduring OAuth login. A successful heartbeat also verifies
the public host identity before showing it online. API fetches reject redirects
and bound response sizes/timeouts.

Run `npm test --prefix connect-api` for provider/protocol tests. To run the HTTP,
ownership and concurrency tests against an isolated real Postgres database, set
`CONNECT_TEST_DATABASE_URL` in the test environment. These tests create the
`cloud_computers` table and randomized account rows; use a disposable database.
No live Clerk or Cloudflare acceptance is implied by fixture results.
