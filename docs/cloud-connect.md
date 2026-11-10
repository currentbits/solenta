# Cloud connections

Solenta builds do not include a Solenta-operated broker address. Remote access
can use your own HTTPS endpoint and Solenta's existing device pairing, without
a Solenta account or broker.

## Connect through your own tunnel

In the desktop app, open Settings > Connections > Computers and select
**Set up a connection without SSH**. The wizard walks through desktop or
standalone host startup, your own tunnel, and device pairing. It validates the
public HTTPS address, accepts the host's local device link, and tests identity
and device access before saving. Tunnel creation still happens in your own
provider account; the wizard never asks for your Cloudflare API credentials.

1. Run Solenta Web or the standalone server on the execution computer. Keep it
   bound to loopback, for example `127.0.0.1:4621`.
2. Configure a tunnel in your own Cloudflare account, with your own hostname,
   pointing to that local HTTP address. Run the connector on that computer.
3. On that computer, open Settings > Connections > Browser access. Under
   Devices, add a device with Full access and copy its link. Its `#token=`
   fragment contains the device token. For a standalone host, use the device
   link or token printed at startup instead; reusable device creation requires
   the desktop app.
4. On the receiving computer, choose Settings > Connections > Address. Enter
   your public HTTPS address and the device token, then press Connect.

This uses the existing address connection. Tunnel setup and connector service
management are manual. Revoke a device on the execution computer to remove its
access. Solenta's servers do not participate in pairing or connecting.
Cloudflare carries the traffic and terminates HTTPS; this is not end-to-end
encryption. The execution computer and its connector must stay running.

## Optional self-hosted account broker

The account-based flow below requires deploying your own
[broker](../connect-api/README.md), database, GitHub OAuth app and Cloudflare
configuration. Set `SOLENTA_CONNECT_ORIGIN` to your broker's exact HTTPS origin
on each computer, or set `connectOrigin` in your custom build's package manifest.
An unconfigured build cannot sign in to a broker or create a broker-managed
tunnel. Direct address connections remain available.

Install the Solenta server archive once on the execution computer and start it
on its chosen port. Cloud setup uses outbound connections and does not require
SSH or Tailscale SSH permission. It cannot install onto an empty computer to
which you have no existing access.

The server archive includes these commands:

```sh
bin/solenta-connect login --port 4621 --data-dir ~/.solenta/data
bin/solenta-connect link --port 4621 --data-dir ~/.solenta/data
bin/solenta-connect status --port 4621 --data-dir ~/.solenta/data
bin/solenta-connect unlink --port 4621 --data-dir ~/.solenta/data
bin/solenta-connect logout --port 4621 --data-dir ~/.solenta/data
```

Use the running server's actual port and data directory. The command checks its
public identity before presenting a local credential, then uses the existing
authenticated wire connection. It neither starts a second writer nor chooses
a server by another process's PID. An unrelated listener or old desktop on
another port is left alone.

Headless login displays GitHub's verification URL and a short code. Open that page in
your browser, sign in and approve the request. Device authorization codes and
refresh tokens are kept out of output and arguments. The headless server owns
its private 0600 account and host-identity files. They are unencrypted on a
headless runtime; protect the data directory and its backups. Desktop login opens GitHub in your system browser with PKCE. It requests login
only, with no repository permissions, and uses OS secure storage or lasts only for the session. Hosting from the desktop needs
persistent secure storage so a pinned signing identity survives restart.

Linking gives devices authorized on your account access to this computer's
agents, terminals and files as its OS user. Agent credentials, repositories,
threads and running work stay on the execution computer. Host sessions expire
after ten minutes. Renewal keeps the same device and access scopes. Expired
cloud devices are reclaimed without removing direct device registrations.

Desktop cloud windows receive host sessions through a narrow main-process
bridge. Artifact images, videos and downloads use a Secure, HttpOnly,
SameSite=Strict host-only cookie restricted to the artifact path in that
window's temporary browser partition. It is rotated before credential updates
and removed when the window closes. Tokens never enter artifact URLs or
localStorage. Signing out closes receiving cloud windows; it does not unlink a
computer that is hosting cloud access.

The connector is checksum-pinned and cached outside the application bundle.
It runs under the server or desktop runtime and exits when its owning app goes
away. Its credential is never a command argument. On restart, the host verifies
its signed account link before starting the connector or issuing new access.

Unlink stops the connector and revokes this link's cloud sessions, while keeping
work, signing identity and direct-device access. A separate disabled marker
prevents restart from restoring cloud access even when secure credential
storage is unavailable. Broker or provider cleanup may remain pending while
offline; retry unlink after connectivity returns. Revoked computers with
pending cleanup remain visible with a retry action. Provider deletion retries
while the host drains its revocation response; an offline host confirms its
disabled state over a signed outbound heartbeat when it returns. The headless `logout` command
also unlinks this host before clearing its local account login.

Cloud linking does not install a service manager. An externally managed server
has no automatic crash or reboot restart guarantee. Linux user services need an
available user manager; survival after logout depends on linger. macOS user
launch agents need a logged-in GUI user session.

The broker stores your account-to-computer links, public signing keys, labels,
runtime metadata, last contact and tunnel/DNS allocation details. It receives a
one-use enrollment grant and never receives a reusable host session, model-provider
credential or project content. It processes GitHub login/refresh tokens transiently
without persisting or logging them. Cloudflare terminates HTTPS. The broker is
trusted to authorize access; this is not end-to-end encryption. See the
[broker setup guide](../connect-api/README.md) for deployment and TLS requirements.
