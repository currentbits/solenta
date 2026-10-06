"use strict";

/**
 * IPC_HANDLERS rows for web:* (#1512 I2): the Solenta Web switch, device
 * tokens and Tailscale Serve. Desktop only: a paired browser must not be
 * able to mint more tokens, revoke others, or turn the server off under
 * itself.
 */

function requireWebAccess(ctx) {
  if (ctx.transport !== "desktop" || !ctx.webAccess) {
    throw new Error("Solenta Web settings require the desktop app.");
  }
  return ctx.webAccess;
}

module.exports = {
  "web:status": async (ctx) => requireWebAccess(ctx).status(),
  "web:setEnabled": async (ctx, input) => requireWebAccess(ctx).setEnabled(input || {}),
  "web:addDevice": async (ctx, input) => requireWebAccess(ctx).addDevice(input || {}),
  "web:revokeDevice": async (ctx, input) => requireWebAccess(ctx).revokeDevice(input || {}),
  "web:setTailscale": async (ctx, input) => requireWebAccess(ctx).setTailscale(input || {}),
};
