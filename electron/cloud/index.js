"use strict";

const path = require("node:path");
const { cloudConfig } = require("./config");
const { createCredentials } = require("./credentials");
const { createCloudClient } = require("./client");
const { createCloudHost } = require("./host");
const { createConnector } = require("./connector");
const { createCloudAdmin } = require("./admin");
const { createCloudWindowSessions } = require("./windowSessions");

function createCloudServices({ dataDir, descriptor, devices, webAccess, safeStorage, openExternal, config = cloudConfig(), fetch, connector, isActive, ipcMain }) {
  const storage = { safeStorage, allowPlaintext: descriptor.runtimeKind === "server" };
  const client = createCloudClient({ config, credentials: createCredentials({ file: path.join(dataDir, "cloud-account.json"), ...storage }), fetch, openExternal });
  const host = createCloudHost({ dataDir, descriptor, devices, config, account: client, fetch, isActive,
    port: () => webAccess.address()?.port, disconnect: id => webAccess.disconnect(id),
    credentials: createCredentials({ file: path.join(dataDir, "cloud-host.json"), ...storage }),
    connector: connector ?? createConnector({ cacheDir: path.join(dataDir, "cache", "cloudflared"), fetch }),
  });
  const windows = descriptor.runtimeKind === "desktop" && ipcMain ? createCloudWindowSessions({ ipcMain }) : null;
  return { client, host, windows, adminHandlers: createCloudAdmin({ client, host }), status: () => ({ account: client.status(), host: host.status() }),
    async link() { if (!webAccess.isRunning()) await webAccess.setEnabled({ enabled: true }); return host.link(); },
    async close() { windows?.close(); client.close(); await host.close(); },
  };
}
module.exports = { createCloudServices };
