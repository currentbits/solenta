"use strict";

const fs = require("node:fs");
const path = require("node:path");

function claimStarPrompt(userDataPath) {
  if (!userDataPath) return false;
  try {
    // Claim before displaying, atomically across windows and across restarts.
    fs.writeFileSync(path.join(userDataPath, "star-prompt-shown"), String(Date.now()), { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    // Already shown, or persistence unavailable: quietly skip the prompt.
    return false;
  }
}

module.exports = { claimStarPrompt };
