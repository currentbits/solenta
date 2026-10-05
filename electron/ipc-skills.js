"use strict";

const services = require("./services.js");
const { syncUserMcpServers } = require("./memory-sup.js");
const skills = require("./skills.js");
const skillCatalog = require("./skillCatalog.js");
const skillImports = require("./skillImports.js");
const harnessImports = require("./harnessImports.js");
const { createSafeCommandRunner } = require("./skillPluginAdapters.js");
const cliCommands = require("./cliCommands.js");

/** IPC_HANDLERS rows for skills:*, harness:*; ipc.js spreads them in. */
module.exports = {
  "skills:list": async (ctx, input) => {
    const projectPath =
      input && typeof input.projectPath === "string"
        ? input.projectPath
        : null;
    return skills.listSkillsAsync(projectPath, process.env, ctx.userDataPath);
  },
  "skills:add": async (ctx, input) => {
    return skills.addSkill(input || {});
  },
  "skills:remove": async (ctx, input) => {
    return skills.removeSkill(input || {}, process.env, ctx.userDataPath);
  },
  "skills:sync": async (ctx) => {
    return skills.syncSkills();
  },
  "skills:commands": async (ctx, input) => {
    const projectPath =
      input && typeof input.projectPath === "string"
        ? input.projectPath
        : null;
    return cliCommands.listPaletteCommands({ projectPath, provider: input?.provider });
  },
  "skills:catalog": async (ctx) => {
    return skillCatalog.listCatalog({ userDataPath: ctx.userDataPath });
  },
  "skills:pickImport": async (ctx) => {
    return skillImports.pickImport({
      userDataPath: ctx.userDataPath,
      dialog: ctx.dialog,
    });
  },
  "skills:previewImport": async (ctx, input) => {
    return skillImports.previewImport({
      userDataPath: ctx.userDataPath,
      input,
    });
  },
  "skills:installImport": async (ctx, input) => {
    const request = input && typeof input === "object" ? input : {};
    return skillImports.installImport({
      userDataPath: ctx.userDataPath,
      request: {
        previewId: request.previewId,
        selected: request.selected,
        replace: request.replace,
        trustPluginCode: request.trustPluginCode === true,
      },
      runFile: createSafeCommandRunner(),
    });
  },
  "skills:discardImport": async (ctx, input) => {
    return skillImports.discardImport({
      userDataPath: ctx.userDataPath,
      previewId: input && input.previewId,
    });
  },
  "harness:detectSources": async () => {
    return harnessImports.detectSources({ env: process.env });
  },
  "harness:previewImport": async (ctx, input) => {
    const request = input && typeof input === "object" ? input : {};
    const current = services.getSettings(ctx.store).mcpServers;
    const projectPath =
      typeof request.projectPath === "string" ? request.projectPath : undefined;
    return harnessImports.previewImport({
      userDataPath: ctx.userDataPath,
      source: request.source,
      projectPath,
      current,
      memory: ctx.memory,
      env: process.env,
    });
  },
  "harness:installImport": async (ctx, input) => {
    const request = input && typeof input === "object" ? input : {};
    const current = services.getSettings(ctx.store).mcpServers;
    const projectPath =
      typeof request.projectPath === "string" ? request.projectPath : undefined;
    return harnessImports.installImport({
      userDataPath: ctx.userDataPath,
      current,
      memory: ctx.memory,
      env: process.env,
      projectPath,
      request: {
        previewId: request.previewId,
        selected: request.selected,
        replace: request.replace === true,
        trustLocal: request.trustLocal === true,
        trustPluginCode: request.trustPluginCode === true,
      },
      runFile: createSafeCommandRunner(),
      saveMcp: (nextList) => {
        const next = services.setSettings(
          ctx.store,
          { mcpServers: nextList },
          { replaceMcpServers: true },
        );
        try {
          syncUserMcpServers(next.mcpServers, { userDataPath: ctx.userDataPath });
        } catch {
          // ignore
        }
        return next.mcpServers;
      },
    });
  },
  "harness:discardImport": async (ctx, input) => {
    return harnessImports.discardImport({
      userDataPath: ctx.userDataPath,
      previewId: input && input.previewId,
    });
  },
};
