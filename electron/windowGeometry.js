"use strict";

// At 640px the renderer uses pane drawers and the compact settings navigation.
// Keep launch sizes independent of the minimum so existing placement stays put.
function windowGeometry(threadId) {
  return {
    width: threadId ? 960 : 1440,
    height: 900,
    minWidth: 640,
    minHeight: 480,
  };
}

module.exports = { windowGeometry };
