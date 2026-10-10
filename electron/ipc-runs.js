"use strict";

const services = require("./services.js");
const automations = require("./automations.js");
const { distillThread } = require("./distill.js");

/** IPC_HANDLERS rows for workflows:*, runs:*, automations:*; ipc.js spreads them in. */
module.exports = {
  "workflows:list": async (ctx) => {
    return services.listTemplates(ctx.store);
  },
  "workflows:save": async (ctx, template) => {
    return services.saveTemplate(ctx.store, template);
  },
  "runs:distill": async (ctx, input) => {
    return distillThread(ctx.store, input && input.threadId);
  },
  "workflows:remove": async (ctx, input) => {
    return services.removeTemplate(ctx.store, input);
  },
  "workflows:exportToRepo": async (ctx, input) => {
    return services.exportTemplateToRepo(ctx.store, input);
  },
  "automations:list": async (ctx) => {
    return services.listAutomations(ctx.store);
  },
  "automations:add": async (ctx, input) => {
    return services.addAutomation(ctx.store, input);
  },
  "automations:update": async (ctx, input) => {
    return services.updateAutomation(ctx.store, input);
  },
  "automations:remove": async (ctx, input) => {
    services.removeAutomation(ctx.store, input);
  },
  "automations:runNow": async (ctx, input) => {
    const id = input && input.id != null ? String(input.id) : "";
    return automations.runNow(ctx, id);
  },
  "automations:listRuns": async (ctx, input) => {
    const id = input && input.id != null ? String(input.id) : "";
    return automations.listAutomationRuns(ctx.store, id);
  },
  "runs:start": async (ctx, input) => {
    return ctx.runner.startRun(input);
  },
  "runs:steer": async (ctx, input) => {
    return ctx.runner.steerRun(input);
  },
  "runs:sendQueued": async (ctx, input) => {
    return ctx.runner.sendQueued(input);
  },
  "runs:startWorkflow": async (ctx, input) => {
    return ctx.runner.startWorkflowRun(input);
  },
  "runs:retryWorkflowAgent": async (ctx, input) => {
    return ctx.runner.retryWorkflowAgent(input);
  },
  "runs:stop": async (ctx, input) => {
    return ctx.runner.stopRun(input);
  },
  "runs:resumeQuotaWait": async (ctx, input) => {
    return ctx.runner.resumeQuotaWait(input);
  },
};
