"use strict";

const { BrowserWindow, nativeTheme } = require("electron");
const { windowBackgroundColor, nativeThemeSource } = require("./theme.js");
const services = require("./services.js");
const { syncUserMcpServers } = require("./memory-sup.js");
const { redactSettings } = require("./mcp.js");
const updater = require("./updater.js");
const feedback = require("./feedback.js");
const { discoverSourceControl } = require("./sourceControl.js");
const { applyZoom } = require("./zoom.js");
const { whenPathReady } = require("./pathEnv.js");
const providerAuth = require("./providerAuth.js");

/** Version stamped in the embedded package.json; "dev" outside a build. */
function appVersion() {
  try {
    return String(require("../package.json").version || "") || "dev";
  } catch {
    return "dev";
  }
}

/** IPC_HANDLERS rows for app:*, memory:*, settings:*, stayAwake:*, providers:*, sourceControl:*; ipc.js spreads them in. */
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
          services.getThreadDetail(ctx.store, threadId, null, {
            markVisited: false,
          }),
        );
        ctx.broadcast("threads:changed", services.listThreads(ctx.store));
      } catch {
        // Thread archived between the send and the confirmation.
      }
    }
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
    return redactSettings(services.getSettings(ctx.store));
  },
  "settings:set": async (ctx, patch) => {
    const previousGuardrails = ctx.store.getSettings().guardrailsEnabled;
    const next = services.setSettings(ctx.store, patch);
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
    if (patch && Object.prototype.hasOwnProperty.call(patch, "githubHosts")) {
      // A new account or token per host must not wait out the 10-min cache.
      require("./github.js").forgetToken();
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, "uiScale")) {
      applyZoom(null, next.uiScale, ctx.store);
    }
    // stayAwake mode change (#364): re-derive the power blocker now, not on
    // the next thread tick. evaluate() is idempotent.
    if (ctx.stayAwake) {
      ctx.stayAwake.evaluate();
    }
    return redactSettings(next);
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
  "providers:list": async (ctx) => {
    // First launch: `which` each CLI only once the login-shell PATH is in (#1475).
    const pathWait = whenPathReady({ ifUncached: true });
    if (pathWait) await pathWait;
    // Sign-in probes (#1501): the boot list kicks them in the background; a
    // later list (picker or Agents pane opening) waits for a rate-limited one.
    const first = !providerAuth.started();
    const probing = providerAuth.refresh({
      instances: services.instanceAuthProbes(ctx.store),
    });
    if (!first) await probing;
    return services.listProvidersForApi(ctx.store);
  },
  "sourceControl:discover": async (_ctx, input) => {
    return discoverSourceControl({
      rescan: Boolean(input && input.rescan),
    });
  },
};
