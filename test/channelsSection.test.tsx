/**
 * Settings → Integrations → Telegram, Slack and Discord (#1718).
 *
 * Run: node --import=./test/support/render.mjs --experimental-strip-types --test test/channelsSection.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { mount, unmountAll } from "./support/dom.ts";
import { createFakeCoder } from "./support/fakeCoder.ts";
import { ChannelsSection } from "../src/components/settings/ChannelsSection";
import type { AppSettings, ProjectInfo } from "../src/shared/ipc";

const projects = [
  { id: "p1", name: "app" },
  { id: "p2", name: "site" },
] as ProjectInfo[];

async function setup(fakeOpts: Parameters<typeof createFakeCoder>[0] = {}) {
  const fake = createFakeCoder(fakeOpts);
  let settings = (await fake.api.settings.get()) as AppSettings;
  const onSaveSettings = async (patch: Partial<AppSettings>) => {
    settings = await fake.api.settings.set(patch);
    return settings;
  };
  const view = await mount(
    <ChannelsSection
      active
      settings={settings}
      projects={projects}
      onSaveSettings={onSaveSettings}
      api={fake.api.settings}
    />,
  );
  await view.flush();
  return { fake, view, saved: () => settings };
}

describe("ChannelsSection", () => {
  afterEach(() => unmountAll());

  it("saves token, allowlist, project; connect shows the bot; token never read back", async () => {
    const { fake, view, saved } = await setup();
    assert.match(view.text(), /Not connected/);
    await view.type(view.query("[data-telegram-token]"), "123:abc");
    await view.type(view.query("[data-telegram-allowed-ids]"), "111, 222");
    await view.change(view.query("[data-telegram-project]"), "p2");
    await view.click(view.query("[data-telegram-connect]"));
    await view.flush();

    const [set] = fake.of("settings.set");
    assert.deepEqual(set.args[0], {
      telegram: {
        allowedSenderIds: ["111", "222"],
        projectId: "p2",
        agentProfileId: null,
        botToken: "123:abc",
      },
    });
    assert.equal(saved().telegram?.hasToken, true);
    assert.equal(saved().telegram?.botToken, undefined);
    assert.deepEqual(fake.only("settings.connectChannel").args, [{ channel: "telegram" }]);
    assert.match(view.query("[data-telegram-status]")!.textContent!, /Connected as @solenta_test_bot/);
    assert.equal((view.query("[data-telegram-token]") as HTMLInputElement).value, "");

    await view.click(view.query("[data-telegram-disconnect]"));
    await view.flush();
    assert.equal(fake.of("settings.disconnectChannel").length, 1);
    assert.match(view.text(), /Not connected/);
  });

  it("a blank token field keeps the saved token", async () => {
    const { fake, view } = await setup();
    await view.type(view.query("[data-telegram-allowed-ids]"), "111");
    await view.click(view.query("[data-telegram-save]"));
    await view.flush();
    const patch = fake.only("settings.set").args[0] as { telegram: Record<string, unknown> };
    assert.equal("botToken" in patch.telegram, false);
  });

  it("shows a connect failure", async () => {
    const { view } = await setup({ connectChannelError: "Unauthorized" });
    await view.click(view.query("[data-telegram-connect]"));
    await view.flush();
    assert.match(view.query("[data-telegram-error]")!.textContent!, /Unauthorized/);
    assert.match(view.query("[data-telegram-status]")!.textContent!, /Error: Unauthorized/);
  });

  it("shows all three channels with DMs-only copy", async () => {
    const { view } = await setup();
    for (const kind of ["telegram", "slack", "discord"]) {
      assert.ok(view.query(`[data-channels-${kind}]`), kind);
      assert.match(view.query(`[data-${kind}-status]`)!.textContent!, /Not connected/);
    }
    assert.match(view.query("[data-channels-slack]")!.textContent!, /DMs only; group\/channel messages are ignored/);
    assert.match(view.query("[data-channels-discord]")!.textContent!, /DMs only; group\/channel messages are ignored/);
  });

  it("Slack saves both tokens write-only and connects its own channel", async () => {
    const { fake, view, saved } = await setup();
    await view.type(view.query("[data-slack-app-token]"), "xapp-1-abc");
    await view.type(view.query("[data-slack-token]"), "xoxb-1-abc");
    await view.type(view.query("[data-slack-allowed-ids]"), "U0ME, U0YOU");
    await view.change(view.query("[data-slack-project]"), "p1");
    await view.click(view.query("[data-slack-connect]"));
    await view.flush();

    assert.deepEqual(fake.only("settings.set").args[0], {
      slack: {
        allowedSenderIds: ["U0ME", "U0YOU"],
        projectId: "p1",
        agentProfileId: null,
        appToken: "xapp-1-abc",
        botToken: "xoxb-1-abc",
      },
    });
    assert.equal(saved().slack?.hasAppToken, true);
    assert.equal(saved().slack?.hasToken, true);
    assert.equal(saved().slack?.appToken, undefined);
    assert.deepEqual(fake.only("settings.connectChannel").args, [{ channel: "slack" }]);
    assert.match(view.query("[data-slack-status]")!.textContent!, /Connected as @solenta_test_bot/);
    // Telegram's card is untouched.
    assert.match(view.query("[data-telegram-status]")!.textContent!, /Not connected/);

    await view.click(view.query("[data-slack-disconnect]"));
    await view.flush();
    assert.deepEqual(fake.only("settings.disconnectChannel").args, [{ channel: "slack" }]);
    assert.match(view.query("[data-slack-status]")!.textContent!, /Not connected/);
  });

  it("Discord connect failure shows on its own card", async () => {
    const { fake, view } = await setup({ connectChannelError: "Discord token check failed (HTTP 401)" });
    await view.type(view.query("[data-discord-token]"), "MTA.abc");
    await view.type(view.query("[data-discord-allowed-ids]"), "222");
    await view.click(view.query("[data-discord-connect]"));
    await view.flush();
    assert.deepEqual(fake.of("settings.set")[0].args[0], {
      discord: { allowedSenderIds: ["222"], projectId: null, agentProfileId: null, botToken: "MTA.abc" },
    });
    assert.match(view.query("[data-discord-error]")!.textContent!, /HTTP 401/);
    assert.match(view.query("[data-discord-status]")!.textContent!, /Error: Discord token check failed/);
    assert.equal(view.query("[data-telegram-error]"), null);
  });
});
