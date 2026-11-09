"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MAINTENANCE_MESSAGE = "The server is validating an update in maintenance mode. Retry after it restarts.";

/** The trial process stays fenced even after its update-request marker is gone. */
function isServerMaintenance(ctx) {
  return process.env.SOLENTA_SERVER === "1" && (
    process.env.SOLENTA_SERVER_MAINTENANCE === "1" ||
    Boolean(ctx && ctx.userDataPath && fs.existsSync(path.join(ctx.userDataPath, ".server-maintenance-request")))
  );
}

module.exports = { isServerMaintenance, MAINTENANCE_MESSAGE };
