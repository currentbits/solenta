"use strict";

const { SPEECH_NOT_IMPLEMENTED } = require("./speech.js");

function requireDesktop(ctx) {
  if (!ctx || ctx.transport !== "desktop") {
    const err = new Error("iOS Simulator controls require the desktop app");
    err.code = "unsupported_platform";
    throw err;
  }
}

function requireSimulator(ctx) {
  requireDesktop(ctx);
  const sim = ctx.getIosSimulator && ctx.getIosSimulator();
  if (!sim) {
    const err = new Error("iOS Simulator controls require the desktop app");
    err.code = "unsupported_platform";
    throw err;
  }
  return sim;
}

function speechStatusMissing() {
  return { state: "missing", runtimeReady: false, modelReady: false };
}

function requireSpeech(ctx) {
  if (!ctx || !ctx.speech) {
    throw new Error(SPEECH_NOT_IMPLEMENTED);
  }
  return ctx.speech;
}

function viewerStreamInfo(info) {
  return {
    url: info && info.url,
    token: info && info.token,
    generation: info && info.generation,
    protocolVersion: 1,
    maxMessageBytes: 4194304,
  };
}

function activeRunIdFrom(ctx, threadId) {
  if (!ctx || !ctx.runner || typeof ctx.runner.activeRunId !== "function") {
    return null;
  }
  const runId = ctx.runner.activeRunId(threadId);
  return typeof runId === "string" ? runId : null;
}

/** IPC_HANDLERS rows for simulator:*, speech:*; ipc.js spreads them in. */
module.exports = {
  "simulator:capabilities": async (ctx, input) => {
    const sim = requireSimulator(ctx);
    return sim.getCapabilities({ threadId: input && input.threadId });
  },
  "simulator:selectDeveloperDir": async (ctx, input) => {
    const sim = requireSimulator(ctx);
    return sim.selectDeveloperDirectory({
      threadId: input && input.threadId,
      developerDir: input && input.developerDir,
    });
  },
  "simulator:listDevices": async (ctx, input) => {
    const sim = requireSimulator(ctx);
    return sim.listDevices({ threadId: input && input.threadId });
  },
  "simulator:status": async (ctx, input) => {
    const sim = requireSimulator(ctx);
    return sim.getStatus({ threadId: input && input.threadId });
  },
  "simulator:attach": async (ctx, input) => {
    const sim = requireSimulator(ctx);
    return sim.attach({
      threadId: input && input.threadId,
      deviceUdid: input && input.deviceUdid,
    });
  },
  "simulator:detach": async (ctx, input) => {
    const sim = requireSimulator(ctx);
    return sim.detach({
      threadId: input && input.threadId,
      generation: input && input.generation,
    });
  },
  "simulator:takeControl": async (ctx, input) => {
    const sim = requireSimulator(ctx);
    return sim.takeover({
      threadId: input && input.threadId,
      deviceUdid: input && input.deviceUdid,
      confirmed: input && input.confirmed,
    });
  },
  "simulator:streamInfo": async (ctx, input) => {
    const sim = requireSimulator(ctx);
    const info = await sim.streamInfo({
      threadId: input && input.threadId,
      generation: input && input.generation,
    });
    return viewerStreamInfo(info);
  },
  "simulator:retryStream": async (ctx, input) => {
    const sim = requireSimulator(ctx);
    const info = await sim.retryStream({
      threadId: input && input.threadId,
      generation: input && input.generation,
    });
    return viewerStreamInfo(info);
  },
  "simulator:sendInput": async (ctx, input) => {
    const sim = requireSimulator(ctx);
    return sim.sendInput({
      threadId: input && input.threadId,
      generation: input && input.generation,
      input: input && input.input,
    });
  },
  "simulator:accessibility": async (ctx, input) => {
    const sim = requireSimulator(ctx);
    return sim.accessibility({
      threadId: input && input.threadId,
      generation: input && input.generation,
      maxDepth: input && input.maxDepth,
    });
  },
  "simulator:scrollTo": async (ctx, input) => {
    const sim = requireSimulator(ctx);
    return sim.scrollTo({
      threadId: input && input.threadId,
      generation: input && input.generation,
      x: input && input.x,
      y: input && input.y,
      dx: input && input.dx,
      dy: input && input.dy,
    });
  },
  "simulator:install": async (ctx, input) => {
    const sim = requireSimulator(ctx);
    return sim.install({
      threadId: input && input.threadId,
      generation: input && input.generation,
      relativeAppPath: input && input.relativeAppPath,
    });
  },
  "simulator:launch": async (ctx, input) => {
    const sim = requireSimulator(ctx);
    return sim.launch({
      threadId: input && input.threadId,
      generation: input && input.generation,
      bundleId: input && input.bundleId,
    });
  },
  "simulator:openUrl": async (ctx, input) => {
    const sim = requireSimulator(ctx);
    return sim.openUrl({
      threadId: input && input.threadId,
      generation: input && input.generation,
      url: input && input.url,
    });
  },
  "simulator:screenshot": async (ctx, input) => {
    const sim = requireSimulator(ctx);
    const threadId = input && input.threadId;
    return sim.captureScreenshot({
      threadId,
      generation: input && input.generation,
      runId: activeRunIdFrom(ctx, threadId),
    });
  },
  "simulator:startRecording": async (ctx, input) => {
    const sim = requireSimulator(ctx);
    const threadId = input && input.threadId;
    return sim.startRecording({
      threadId,
      generation: input && input.generation,
      runId: activeRunIdFrom(ctx, threadId),
    });
  },
  "simulator:stopRecording": async (ctx, input) => {
    const sim = requireSimulator(ctx);
    return sim.stopRecording({
      threadId: input && input.threadId,
      generation: input && input.generation,
      recordingId: input && input.recordingId,
    });
  },
  "speech:status": async (ctx) => {
    if (!ctx || !ctx.speech) return speechStatusMissing();
    return ctx.speech.status();
  },
  "speech:download": async (ctx) => requireSpeech(ctx).download(),
  "speech:start": async (ctx) => requireSpeech(ctx).start(),
  "speech:write": async (ctx, input) => requireSpeech(ctx).write(input),
  "speech:stop": async (ctx, input) => requireSpeech(ctx).stop(input),
  "speech:cancel": async (ctx, input) => requireSpeech(ctx).cancel(input),
};
