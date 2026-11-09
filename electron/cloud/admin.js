"use strict";

function createCloudAdmin({ client, host }) {
  return {
    "cloud:admin": async (ctx, input) => {
      if (ctx.cloudLocalAdmin !== true) throw new Error("Cloud host administration requires its local server credential.");
      if (input?.action === "status") return { account: client.status(), host: host.status() };
      if (input?.action === "accept-login") return client.acceptLogin(input.oauth);
      if (input?.action === "link") return host.link();
      if (input?.action === "unlink") return host.unlink();
      if (input?.action === "logout") {
        const unlink = await host.unlink();
        return { ...await client.logout(), hostRevocationPending: unlink.revocationPending };
      }
      throw new Error("Unknown cloud host command.");
    },
  };
}
module.exports = { createCloudAdmin };
