# Cloud connections

Cloud connections are being built and require a configured Solenta Connect
broker, GitHub OAuth application and Cloudflare host domain. An
unconfigured build cannot sign in or create a tunnel. Local test success does
not establish that the public cloud service is available.

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
