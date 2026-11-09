"use strict";

/**
 * IPC_HANDLERS rows for web:* (#1512 I2): the Solenta Web switch, device
 * tokens and Tailscale Serve. Server switches and reusable direct-token
 * issuance stay desktop-only. A full-access browser owner can issue scoped
 * one-time enrollment links and revoke named-device sessions.
 */

function requireWebAccess(ctx) {
  if (ctx.transport !== "desktop" || !ctx.webAccess) {
    throw new Error("Solenta Web settings require the desktop app.");
  }
  return ctx.webAccess;
}

// Browser enrollment uses the same named-device authority. The wire bridge
// requires full access for these channels before reaching this handler.
function requireEnrollmentAccess(ctx) {
  if (!ctx.webAccess || !["desktop", "web"].includes(ctx.transport)) throw new Error("Device enrollment is unavailable.");
  return ctx.webAccess;
}
module.exports = {
  "web:enrollmentStatus": async ctx => requireEnrollmentAccess(ctx).enrollmentStatus(),
  "web:createEnrollment": async (ctx, input) => requireEnrollmentAccess(ctx).createEnrollment(input || {}),
  "web:status": async (ctx) => requireWebAccess(ctx).status(),
  "web:setEnabled": async (ctx, input) => requireWebAccess(ctx).setEnabled(input || {}),
  "web:addDevice": async (ctx, input) => requireWebAccess(ctx).addDevice(input || {}),
  "web:revokeDevice": async (ctx, input) => requireEnrollmentAccess(ctx).revokeDevice(input || {}),
  "web:setTailscale": async (ctx, input) => requireWebAccess(ctx).setTailscale(input || {}),
};
