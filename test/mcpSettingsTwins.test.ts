/**
 * DevCoder / FakeCoder must match main MCP validation, redaction, and clones.
 * Run: node --import=./test/support/render.mjs --experimental-strip-types --test test/mcpSettingsTwins.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDevCoder } from "../src/devCoder.ts";
import { createFakeCoder } from "./support/fakeCoder.ts";

const STDIO = {
  name: "local-tools",
  transport: "stdio" as const,
  command: "/usr/bin/mcp-server",
  args: ["--stdio"],
  env: { GITHUB_TOKEN: "tok" },
  enabled: true,
  trusted: true,
};

const HTTP = {
  name: "team-tools",
  transport: "http" as const,
  url: "https://tools.example.com/mcp",
  headers: { "X-Api-Key": "k" },
  token: "secret-token",
  enabled: true,
};

describe("MCP settings twins", () => {
  it("FakeCoder get redacts secrets and does not alias public arrays", async () => {
    const fake = createFakeCoder();
    await fake.api.settings.set({ mcpServers: [STDIO, HTTP] });
    const first = await fake.api.settings.get();
    assert.equal(first.mcpServers[0].transport, "stdio");
    assert.deepEqual(first.mcpServers[0].env, undefined);
    assert.deepEqual(
      "envNames" in first.mcpServers[0] ? first.mcpServers[0].envNames : [],
      ["GITHUB_TOKEN"],
    );
    assert.equal(first.mcpServers[1].token, undefined);
    assert.equal(first.mcpServers[1].headers, undefined);
    first.mcpServers[0].args.push("--mutated");
    const second = await fake.api.settings.get();
    assert.deepEqual(second.mcpServers[0].args, ["--stdio"]);
    const listed = await fake.api.mcp.list();
    assert.equal(listed[0].hasSecrets, true);
    assert.equal(listed[1].hasToken, true);
  });

  it("DevCoder get redacts secrets and does not alias public arrays", async () => {
    const api = createDevCoder();
    await api.settings.set({ mcpServers: [STDIO, HTTP] });
    const first = await api.settings.get();
    assert.deepEqual(first.mcpServers[0].env, undefined);
    assert.equal(first.mcpServers[1].token, undefined);
    first.mcpServers[0].args.push("--mutated");
    const second = await api.settings.get();
    assert.deepEqual(second.mcpServers[0].args, ["--stdio"]);
  });

  it("FakeCoder/DevCoder preserve omitted secrets and require trusted === true", async () => {
    const fake = createFakeCoder();
    await fake.api.settings.set({ mcpServers: [HTTP] });
    await fake.api.settings.set({
      mcpServers: [
        { name: "team-tools", url: "https://tools.example.com/mcp", enabled: true },
      ],
    });
    const listed = await fake.api.mcp.list();
    assert.equal(listed[0].hasToken, true);

    await assert.rejects(
      () =>
        fake.api.settings.set({
          mcpServers: [
            {
              name: "unsafe",
              transport: "stdio",
              command: "/bin/echo",
              args: [],
              enabled: true,
              trusted: false,
            },
          ],
        }),
      /trusted/,
    );

    const api = createDevCoder();
    await api.settings.set({ mcpServers: [HTTP] });
    await api.settings.set({
      mcpServers: [
        { name: "team-tools", url: "https://tools.example.com/mcp", enabled: true },
      ],
    });
    assert.equal((await api.mcp.list())[0].hasToken, true);
    await assert.rejects(
      () =>
        api.settings.set({
          mcpServers: [
            {
              name: "unsafe",
              transport: "stdio",
              command: "/bin/echo",
              args: [],
              enabled: true,
              trusted: 1 as unknown as boolean,
            },
          ],
        }),
      /trusted/,
    );
  });
});
