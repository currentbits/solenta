# Node server lifecycle

`solenta-server` runs in the foreground and owns one data directory, by default `~/.solenta/data`. It is externally managed when launched directly. Closing a client or SSH tunnel leaves the server process running; foreground process/session survival is the operator's responsibility.

The archive also contains `bin/solenta-service`. It installs an explicit per-user service:

```
/path/to/solenta-server/bin/solenta-service install --runtime /path/to/solenta-server
/path/to/solenta-server/bin/solenta-service status
/path/to/solenta-server/bin/solenta-service logs
/path/to/solenta-server/bin/solenta-service start
/path/to/solenta-server/bin/solenta-service stop
/path/to/solenta-server/bin/solenta-service restart
/path/to/solenta-server/bin/solenta-service uninstall
```

`--data-dir` selects the owner, `--root` selects the immutable-runtime and service-state directory, and `--port` selects the initial loopback listener. Later lifecycle operations use the saved service port. Uninstall removes the user service and current-runtime pointer. It preserves data, logs, and runtime directories. It does not delete projects or provider configuration.

Linux uses `systemctl --user`. A working user manager/bus is required. Status reports `loginctl`'s actual linger value when available. Starting before login or continuing after logout depends on the host administrator enabling linger; installation does not run sudo or promise those guarantees. macOS uses `launchctl` in `gui/<uid>`. That job starts with a GUI login and stops at logout. An SSH-only session without that GUI domain cannot install it. Windows user services are unsupported.

Preparing a computer with an existing managed service starts its saved runtime and port, even if the connecting client staged a newer helper. It does not implicitly install an update. Explicit install refuses a different runtime; Update is the action that changes it. An already-running external server must be stopped by its owner before service installation. This release does not automatically take over arbitrary processes. When no service manager is available, choose External process during SSH preparation, or run `bin/solenta-server` with an operator-owned supervisor. The explicit external start detaches a Node process and verifies its readiness. It installs no restart or reboot startup. Automatic first-connect preparation uses the user service when available and the external process otherwise; subsequent status identifies the actual owner. SSH status and logs do not silently install or stop anything.

## Updates and recovery

The SSH updater obtains the matching target archive from the client's tagged release, verifies its published SHA-256, and stages it in an immutable directory before invoking `solenta-service update --runtime <staged-directory>`. Node servers never enter the Electron desktop installer. Each staged directory is keyed by the requested release tag, target and archive SHA-256, so two nightlies with the same package version cannot reuse each other's runtime. A cached install marker and runtime metadata must match that independent requested identity before use. Unstamped development archives cannot be used for managed updates.

Stop, restart, update and uninstall refuse when authenticated server status reports active runs, open questions/permissions or live terminal shells. A server maintenance marker blocks new web invocations and run starts while the activity check and shutdown proceed. Finish work and close terminals before retrying. There is no force-interrupt button.

An update keeps the old runtime and snapshots the entire stopped data directory, including JSON shards, settings, tokens, and memory database files. A candidate boots in maintenance mode with background execution and all web operations except authenticated status disabled. Readiness checks the public loopback descriptor and compatible protocol before sending a saved credential, then confirms authenticated status for the same computer ID, runtime kind, requested release tag, build SHA and version. The candidate is stopped, the current-runtime pointer switches, and the normal service must pass readiness again before success is reported. While that final readiness check runs, the normal process also defers provider registration, peer connections, cleanup and all background execution until the owner removes the maintenance marker. A failed trial or normal activation restores the saved data directory and old runtime. Removing the maintenance marker commits activation. Later journal or snapshot cleanup failures return a warning and never roll back a live process. Recovery of a retained committed journal only verifies and finalizes the selected runtime, preserving work accepted after activation. Failed trial data is retained beside the data directory for diagnosis and can contain secrets.

Rollback covers the data directory. It does not restore project files, repository state outside that directory, or provider configuration in the user's home. Full snapshots include caches and worktrees inside the data directory and can require substantial disk space. A preflight measures file sizes without following symlinks and requires 2.2 times that size plus 64 MiB free before stopping the server, covering both the snapshot and a restored copy without relying on hardlinks or reflinks. No cross-platform native reboot/crash recovery guarantee is inferred from command tests.

An interrupted update retains an update journal. After inspecting service logs and confirming no work is running, run `solenta-service recover`. Start refuses an outstanding update journal. A process killed while acquiring a data or lifecycle lock can leave a lock requiring manual inspection; do not delete a live owner's lock. Status and logs remain available while a lifecycle operation holds its lock.
