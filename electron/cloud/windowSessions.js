"use strict";

function createCloudWindowSessions({ ipcMain }) {
  const windows = new Map();
  const credential = session => ({ token: session.token, computerId: session.computerId, deviceId: session.deviceId });
  function validFrame(entry, event) {
    try {
      const frame = event.senderFrame, main = event.sender.mainFrame;
      const isMain = frame === main || (Number.isInteger(frame?.routingId) && Number.isInteger(frame?.processId) && frame.routingId === main.routingId && frame.processId === main.processId);
      return !entry.win.isDestroyed() && event.sender === entry.win.webContents && isMain && new URL(frame.url).origin === entry.origin;
    } catch { return false; }
  }
  function matches(entry, session) {
    return session.computerId === entry.computerId && session.accountId === entry.accountId && session.deviceId === entry.deviceId && session.origin === entry.origin;
  }
  ipcMain.handle("cloud-window:session", async event => {
    const entry = windows.get(event.sender.id);
    if (!entry || !validFrame(entry, event)) throw new Error("Cloud credential is unavailable to this window or frame origin.");
    const session = await entry.client.session(entry.computerId);
    if (!windows.has(event.sender.id) || !validFrame(entry, event) || !matches(entry, session)) throw new Error("Cloud window credential identity changed. Reconnect from Connections.");
    return credential(session);
  });
  return {
    track(win, client, session) {
      const entry = { win, client, computerId: session.computerId, accountId: session.accountId, deviceId: session.deviceId, origin: session.origin };
      windows.set(win.webContents.id, entry);
      const unsubscribe = client.subscribe(event => {
        if (win.isDestroyed()) return;
        if (event.type === "account" || (["expired", "unlinked"].includes(event.type) && event.computerId === entry.computerId)) { win.destroy(); return; }
        if (event.type !== "session" || event.computerId !== entry.computerId) return;
        if (!matches(entry, event.session)) { win.destroy(); return; }
        win.webContents.send("cloud-window:changed", credential(event.session));
      });
      win.once("closed", () => { windows.delete(win.webContents.id); unsubscribe(); });
    },
    close() {
      for (const entry of [...windows.values()]) if (!entry.win.isDestroyed()) entry.win.destroy();
      windows.clear(); ipcMain.removeHandler("cloud-window:session");
    },
  };
}
module.exports = { createCloudWindowSessions };
