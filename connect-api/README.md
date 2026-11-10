# Solenta Connect broker

This separate Node/Postgres service owns account-to-computer links and allocates
Cloudflare tunnels. Agent credentials, work and reusable host sessions stay on
the execution computer. Cloudflare terminates HTTPS and this broker is trusted
to authorize account access. This is not end-to-end encryption.

This is an optional self-hosted service. Official builds have no broker address
configured. For access without running a broker, use your own tunnel and
[direct device pairing](../docs/cloud-connect.md#connect-through-your-own-tunnel).

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
| `CONNECT_GITHUB_CLIENT_ID` | Dedicated GitHub OAuth app client ID |
| `CONNECT_GITHUB_CLIENT_SECRET` | Matching OAuth app secret, broker only |
| `CONNECT_SIGNING_JWK` | Persistent private Ed25519 JWK, broker only |
| `CLOUDFLARE_API_TOKEN` | Account tunnel and selected-zone DNS permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `CLOUDFLARE_ZONE_ID` | Dedicated host domain's zone ID |
| `CONNECT_HOST_DOMAIN` | Hostname suffix, e.g. `hosts.example.com` |
| `CONNECT_MAX_COMPUTERS` | Personal account limit, default 3 |
| `PORT` | Internal HTTP port, default 3000 |

Register a **dedicated GitHub OAuth app** for Solenta Connect login. Set its
callback URL to `http://127.0.0.1/callback`, enable device flow and expiring access
tokens. GitHub permits the desktop's dynamically allocated loopback port.
Desktop sign-in uses the system browser, state and S256 PKCE; only the broker
exchanges the code with the app secret. Headless sign-in uses GitHub's device
flow directly, showing only the public verification URL and short user code.
Both request only `offline_access`, which enables expiring access/refresh tokens.
No repository, organization, email or profile permissions are requested. Do not
reuse a GitHub app that already requests repository access.

The broker checks each access token with GitHub's app-authenticated
[`POST /applications/{client_id}/token`](https://docs.github.com/en/rest/apps/oauth-applications#check-a-token).
It validates the issuing app, token, future expiry, identity-only scopes and
numeric user ID. Ownership uses `github_<numeric-id>` so username changes do not
change the account. Tokens from other apps, broad grants and nonexpiring tokens
are refused. This is GitHub OAuth, not OpenID Connect; there is no discovery URL.
The broker's bounded `/v1/oauth/token` accepts only a PKCE authorization-code or
refresh-token exchange for this app. Its secret stays in secure broker config,
never a desktop/CLI bundle. The broker processes OAuth tokens transiently and
never persists or logs them. Refresh is single-flight and requires a new token
pair. Sign-out revokes only that device's app token through the broker; it does
not revoke every device's GitHub authorization. An unconfirmed revocation is
reported to the user. GitHub remains an authentication dependency.

The previous Clerk setup was never deployed. This version replaces that setup;
it does not migrate existing Clerk account IDs or reassign any host ownership.
Users of an unpublished Clerk-configured test build must explicitly unlink and
link again with GitHub. Never rewrite account IDs in the database.

Cloudflare's [remotely managed tunnel API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/methods/create/)
provides a per-link tunnel and connector token. A derived `c-<link-id>` DNS name
routes only to `http://127.0.0.1:<host-port>`, with a final 404 ingress rule.
Create separate token policies: an account policy for Tunnel Edit, and a domain
policy restricted to the selected zone for DNS Edit. Zone Read allows setup
discovery; SSL and Certificates Read allows checking certificate coverage. The
dashboard's "Specified Domains" policy only lists domain permissions, so it
cannot contain the account-scoped tunnel permission. Setting
`CONNECT_HOST_DOMAIN=example.com` places names directly under that domain.
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
No live GitHub OAuth or Cloudflare acceptance is implied by fixture results.

For real staging acceptance, first run a dedicated installed host with
`CODER_SIMULATE=1`, its own data directory and port (4621 on AgentOS), then
`solenta-connect link` on that host. Keep the existing 4620 desktop untouched.
From a separate client checkout, set the public `SOLENTA_CONNECT_ORIGIN`, the
staging host's `CONNECT_ACCEPTANCE_COMPUTER_ID`, and
`CONNECT_ACCEPTANCE_PROJECT` to an existing throwaway repository on that host.
Run:

```sh
node --import=./test/support/render.mjs --experimental-strip-types scripts/smoke-cloud-connect.js --revoke-test-host
```

This script uses public device login, creates a simulated-agent thread in a
worktree, checks a real terminal through renewal and reconnect, and unlinks
the explicitly selected staging host. It does not invoke SSH. It requires host
revocation acknowledgement and provider cleanup to report success. Never point
it at a production computer. Login credentials remain in the acceptance process memory; the test thread remains on the execution host.
Run the native connector smoke and service lifecycle matrix separately; this
does not establish reboot survival or macOS signature validity.
