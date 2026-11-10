"use strict";

const MEDIA_COOKIE = "solenta-cloud-session";
const MEDIA_PATH = "/api/run-artifacts";
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
  function updateCookie(entry, session, push = false) {
    entry.pending = entry.pending.then(async () => {
      if (entry.win.isDestroyed()) return;
      const sender = entry.win.webContents;
      if (push && !validFrame(entry, { sender, senderFrame: sender.mainFrame })) { entry.win.destroy(); return; }
      await entry.cookies.set({ url: entry.origin + MEDIA_PATH + "/", name: MEDIA_COOKIE, value: session.token,
        path: MEDIA_PATH, secure: true, httpOnly: true, sameSite: "strict", ...(session.expiresAt ? { expirationDate: session.expiresAt / 1000 } : {}) });
      if (push) {
        if (!validFrame(entry, { sender, senderFrame: sender.mainFrame })) { if (!entry.win.isDestroyed()) entry.win.destroy(); return; }
        sender.mainFrame.send("cloud-window:changed", credential(session));
      }
    });
    return entry.pending;
  }
  ipcMain.handle("cloud-window:session", async event => {
    const entry = windows.get(event.sender.id);
    if (!entry || !validFrame(entry, event)) throw new Error("Cloud credential is unavailable to this window or frame origin.");
    const revision = entry.revision;
    let session = await entry.client.session(entry.computerId);
    if (revision !== entry.revision) session = entry.session;
    if (!windows.has(event.sender.id) || !validFrame(entry, event) || !matches(entry, session)) throw new Error("Cloud window credential identity changed. Reconnect from Connections.");
    await updateCookie(entry, session);
    if (!windows.has(event.sender.id) || !validFrame(entry, event)) throw new Error("Cloud window origin changed.");
    return credential(session);
  });
  return {
    async track(win, client, session) {
      const id = win.webContents.id;
      const entry = { win, client, computerId: session.computerId, accountId: session.accountId, deviceId: session.deviceId, origin: session.origin,
        cookies: win.webContents.session.cookies, pending: Promise.resolve(), session, revision: 0 };
      windows.set(id, entry);
      const unsubscribe = client.subscribe(event => {
        if (win.isDestroyed()) return;
        if (event.type === "account" || (["expired", "unlinked"].includes(event.type) && event.computerId === entry.computerId)) { win.destroy(); return; }
        if (event.type !== "session" || event.computerId !== entry.computerId) return;
        if (!matches(entry, event.session) || !validFrame(entry, { sender: win.webContents, senderFrame: win.webContents.mainFrame })) { win.destroy(); return; }
        entry.session = event.session; entry.revision++;
        void updateCookie(entry, event.session, true).catch(() => { if (!win.isDestroyed()) win.destroy(); });
      });
      win.once("closed", () => {
        windows.delete(id); unsubscribe();
        void entry.pending.catch(() => {}).then(() => entry.cookies.remove(entry.origin + MEDIA_PATH + "/", MEDIA_COOKIE)).catch(() => {});
      });
      try { await updateCookie(entry, session); }
      catch (error) { if (!win.isDestroyed()) win.destroy(); throw error; }
    },
    close() {
      for (const entry of [...windows.values()]) if (!entry.win.isDestroyed()) entry.win.destroy();
      windows.clear(); ipcMain.removeHandler("cloud-window:session");
    },
  };
}
module.exports = { createCloudWindowSessions };
