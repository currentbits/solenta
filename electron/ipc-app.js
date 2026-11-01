"use strict";

const { BrowserWindow, nativeTheme } = require("electron");
const { windowBackgroundColor, nativeThemeSource } = require("./theme.js");
const services = require("./services.js");
const { syncUserMcpServers } = require("./memory-sup.js");
const { redactSettings } = require("./mcp.js");
const updater = require("./updater.js");
const feedback = require("./feedback.js");
const { discoverSourceControl } = require("./sourceControl.js");
const { applyZoom, applyPinchZoom } = require("./zoom.js");
const { whenPathReady } = require("./pathEnv.js");
const { KINDS } = require("./channels/index.js");

// Read-only: setSettings ignores the key if the renderer echoes it back.
function withSecretStorage(ctx, settings) {
  if (typeof ctx.store.secretStorage !== "function") return settings;
  return { ...settings, secretStorage: ctx.store.secretStorage() };
}
const providerAuth = require("./providerAuth.js");

const { appVersion } = feedback;

/** IPC_HANDLERS rows for app:*, memory:*, settings:*, stayAwake:*, providers:*, sourceControl:*; ipc.js spreads them in. */
/**
 * @param {any} ctx
 * @param {unknown} input
 */
function channelsFor(ctx, input) {
  const name = input && typeof input === "object" ? /** @type {any} */ (input).channel : null;
  if (!KINDS.includes(name)) throw new Error(`Unknown channel: ${name}`);
  if (!ctx.channels) throw new Error("Chat channels run in the desktop app only");
  return { channels: ctx.channels, name };
}

module.exports = {
  "app:status": async (ctx) => {
    return services.appStatus(ctx.store);
  },
  "app:checkUpdate": async (ctx) => {
    return updater.checkUpdate({
      channelOverride: ctx.store.getSettings().updateChannel,
    });
  },
  "app:downloadUpdate": async (ctx) => {
    const { updateChannel } = ctx.store.getSettings();
    const status = await updater.downloadUpdate({ channelOverride: updateChannel });
    // The staged bundle carries its own channel stamp, so a nightly install
    // swapping in a prod build would silently leave the nightly channel.
    // Pin the channel we were on into settings before that happens.
    if (status.state === "staged" && !updateChannel && status.channel) {
      ctx.store.setSettings({ updateChannel: status.channel });
    }
    return status;
  },
  "app:applyUpdate": async (ctx) => {
    if (typeof ctx.confirmApplyUpdate === "function") {
      const ok = await ctx.confirmApplyUpdate();
      if (!ok) return;
    }
    updater.applyUpdate();
  },
  "app:feedback": async (ctx, input) => {
    const text = feedback.normalizeFeedback(input && input.text);
    if (!text) throw new Error("Feedback is empty");
    // Send first: a failed send must not leave a "sent" line in the transcript.
    await feedback.sendFeedback({
      text,
      version: appVersion(),
      platform: `${process.platform} ${process.arch}`,
    });
    const threadId = input && input.threadId;
    if (threadId) {
      feedback.appendFeedbackEvent(
        ctx.store,
        threadId,
        "Feedback sent to the Solenta team. Thank you.",
      );
      try {
        ctx.broadcast(
          "thread:updated",
          // Direct broadcast, not runner.pushDetail, so there is no prior
          // push to diff against (#1786): request the full transcript so
          // this rare event never truncates a renderer that has paged back
          // further than the default window.
          services.getThreadDetail(ctx.store, threadId, null, {
            markVisited: false,
            limit: Infinity,
          }),
        );
        ctx.broadcast("threads:changed", services.listThreads(ctx.store));
      } catch {
        // Thread archived between the send and the confirmation.
      }
    }
  },
  // Diagnostics zip (#1723): host files and a native dialog, desktop only.
  "app:diagnosticsPreview": async (ctx) => {
    if (ctx.transport !== "desktop") throw new Error("Diagnostics export requires the desktop app.");
    return require("./diagnostics.js").diagnosticsFileList({ userDataPath: ctx.userDataPath });
  },
  "app:exportDiagnostics": async (ctx) => {
    if (ctx.transport !== "desktop") throw new Error("Diagnostics export requires the desktop app.");
    return require("./diagnostics.js").exportDiagnostics(ctx);
  },
  "app:openRemoteConnection": async (ctx, input) => {
    if (ctx.transport !== "desktop" || !ctx.openRemoteConnection) {
      throw new Error("Remote Connections require the desktop app.");
    }
    return ctx.openRemoteConnection(input);
  },
  "app:forgetRemoteConnection": async (ctx, input) => {
    if (ctx.transport !== "desktop" || !ctx.forgetRemoteConnection) {
      throw new Error("Remote Connections require the desktop app.");
    }
    ctx.forgetRemoteConnection(input);
  },
  // Hosts whose threads show in this window (#1819); the list lives in the
  // renderer's saved Connections, so it hands the hub the current set.
  "app:setSidebarHosts": async (ctx, hosts) => {
    if (ctx.transport !== "desktop" || !ctx.hostHub) {
      throw new Error("Remote Connections require the desktop app.");
    }
    return ctx.hostHub.setHosts(hosts);
  },
  "app:installRemoteSolenta": async (ctx, input) => {
    if (ctx.transport !== "desktop" || !ctx.installRemoteSolenta) {
      throw new Error("Remote Connections require the desktop app.");
    }
    return ctx.installRemoteSolenta(input);
  },
  // Answer to an "ssh:prompt" push (#1818); null cancels. Never logged.
  "app:answerSshPrompt": async (ctx, input) => {
    if (ctx.transport !== "desktop" || !ctx.answerSshPrompt) {
      throw new Error("Remote Connections require the desktop app.");
    }
    const id = typeof input?.id === "string" ? input.id : "";
    ctx.answerSshPrompt(id, typeof input?.answer === "string" ? input.answer : null);
  },
  "memory:search": async (ctx, input) => {
    return ctx.memory.search(input || { query: "" });
  },
  "memory:recent": async (ctx, input) => {
    return ctx.memory.recent(input || {});
  },
  "memory:get": async (ctx, input) => {
    return ctx.memory.get(input || { id: "" });
  },
  "memory:store": async (ctx, input) => {
    return ctx.memory.store(input);
  },
  "memory:update": async (ctx, input) => {
    return ctx.memory.update(input);
  },
  "memory:remove": async (ctx, input) => {
    return ctx.memory.remove(input);
  },
  "memory:renameScope": async (ctx, input) => {
    return ctx.memory.renameScope(input);
  },
  "memory:maintenance": async (ctx, input) => {
    return ctx.memory.maintenance(input || {});
  },
  "memory:resolve": async (ctx, input) => {
    return ctx.memory.resolve(input);
  },
  "settings:get": async (ctx) => {
    return withSecretStorage(ctx, redactSettings(services.getSettings(ctx.store)));
  },
  "settings:set": async (ctx, patch) => {
    const previousGuardrails = ctx.store.getSettings().guardrailsEnabled;
    const next = services.setSettings(ctx.store, patch);
    // A saved or removed API key changes sign-in state now, not after the TTL.
    if (patch && Object.prototype.hasOwnProperty.call(patch, "providerInstances")) {
      providerAuth.invalidate();
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, "guardrailsEnabled")) {
      try {
        require("./guardrails.js").setGuardrailsEnabled(next.guardrailsEnabled);
      } catch (err) {
        services.setSettings(ctx.store, { guardrailsEnabled: previousGuardrails });
        throw err;
      }
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, "theme") && nativeTheme) {
      nativeTheme.themeSource = nativeThemeSource(next.theme);
      const bg = windowBackgroundColor(
        next.theme,
        nativeTheme.shouldUseDarkColors,
      );
      const windows =
        typeof BrowserWindow.getAllWindows === "function"
          ? BrowserWindow.getAllWindows()
          : [];
      for (const w of windows) {
        if (w && typeof w.setBackgroundColor === "function") {
          w.setBackgroundColor(bg);
        }
      }
    }
    // Re-register user MCP servers so provider hooks pick the change up on
    // the next turn. Best-effort: never fail a settings save on it.
    try {
      syncUserMcpServers(next.mcpServers, { userDataPath: ctx.userDataPath });
    } catch {
      // ignore
    }
    if (ctx.runner && typeof ctx.runner.refreshAllQuotaWaits === "function") {
      ctx.runner.refreshAllQuotaWaits();
    }
    // A raised or cleared concurrency cap admits waiting turns now (#166).
    if (ctx.runner && typeof ctx.runner.admitQueuedRuns === "function") {
      ctx.runner.admitQueuedRuns();
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, "githubHosts")) {
      // A new account or token per host must not wait out the 10-min cache.
      require("./github.js").forgetToken();
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, "uiScale")) {
      applyZoom(null, next.uiScale, ctx.store);
    }
    // Live toggle, no restart (#1807): the window stays, only its visual
    // zoom limit changes.
    if (patch && Object.prototype.hasOwnProperty.call(patch, "pinchZoomWindow")) {
      try {
        const { BrowserWindow } = require("electron");
        if (BrowserWindow && typeof BrowserWindow.getAllWindows === "function") {
          for (const w of BrowserWindow.getAllWindows()) {
            applyPinchZoom(w, next.pinchZoomWindow !== false);
          }
        }
      } catch {
        // not running under Electron (tests)
      }
    }
    // A cloud provider makes the mic usable without the local model (#1725).
    if (patch && Object.prototype.hasOwnProperty.call(patch, "speech") && ctx.speech) {
      ctx.speech.refresh();
    }
    // stayAwake mode change (#364): re-derive the power blocker now, not on
    // the next thread tick. evaluate() is idempotent.
    if (ctx.stayAwake) {
      ctx.stayAwake.evaluate();
    }
    return withSecretStorage(ctx, redactSettings(next));
  },
  "stayAwake:status": async (ctx) => {
    if (ctx.stayAwake) {
      return ctx.stayAwake.getState();
    }
    // Web mode has no power APIs: report the configured mode, never blocking.
    const settings = services.getSettings(ctx.store);
    return {
      mode: settings.stayAwake,
      blocking: false,
      onBattery: false,
      anyWorking: false,
    };
  },
  // "Send test" in Settings (issue #167). The renderer cannot POST these
  // itself — Slack/Discord/ntfy answer no CORS preflight — and a typo'd or
  // revoked URL is otherwise only discoverable by finishing a real run.
  "settings:testWebhook": async (ctx) => {
    const { testWebhook } = require("./notify.js");
    const { recordSecretUse } = require("./secrets.js");
    return testWebhook({
      webhook: services.getSettings(ctx.store).webhook,
      recordSecretUse,
    });
  },
  // Chat channels (#1718), one per KINDS entry.
  "settings:channelStatus": async (ctx) => {
    if (!ctx.channels) {
      return Object.fromEntries(
        KINDS.map((k) => [k, { state: "off", botUsername: null, error: null }]),
      );
    }
    return ctx.channels.status();
  },
  "settings:connectChannel": async (ctx, input) => {
    const { channels, name } = channelsFor(ctx, input);
    return channels.connect(name);
  },
  "settings:disconnectChannel": async (ctx, input) => {
    const { channels, name } = channelsFor(ctx, input);
    return channels.disconnect(name);
  },
  "providers:list": async (ctx) => {
    // First launch: `which` each CLI only once the login-shell PATH is in (#1475).
    const pathWait = whenPathReady({ ifUncached: true });
    if (pathWait) await pathWait;
    // Sign-in probes (#1501): the boot list kicks them in the background; a
    // later list (picker or Agents pane opening) waits for a rate-limited one.
    const first = !providerAuth.started();
    const probing = providerAuth.refresh({
      instances: services.instanceAuthProbes(ctx.store, ctx.userDataPath),
    });
    if (!first) await probing;
    return services.listProvidersForApi(ctx.store);
  },
  // Live model list (#1714): the key is read from the saved instance env
  // here, never sent by the renderer.
  "providers:fetchModels": async (ctx, input) => {
    const { fetchProviderModels } = require("./providerModels.js");
    return fetchProviderModels(ctx.store.getSettings(), String((input && input.provider) || ""));
  },
  // Ollama / LM Studio probe (#1717): loopback by default, a LAN host when given.
  "providers:detectLocal": async (_ctx, input) => {
    return require("./localModels.js").detectLocalModels(input);
  },
  "sourceControl:discover": async (_ctx, input) => {
    return discoverSourceControl({
      rescan: Boolean(input && input.rescan),
    });
  },
};
