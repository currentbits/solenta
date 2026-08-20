const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { toTemplate, showNativeContextMenu } = require("../contextMenu.js");

describe("native context menu (T3 Menu.popup)", () => {
  it("turns children into a submenu and click into the leaf id", async () => {
    const clicks = [];
    const template = toTemplate(
      [
        {
          id: "snooze",
          label: "Snooze",
          children: [{ id: "snooze:hour", label: "In 1 hour" }],
        },
        { id: "fork", label: "Fork", separatorBefore: true },
      ],
      (id) => clicks.push(id),
    );
    assert.equal(template[0].label, "Snooze");
    assert.ok(Array.isArray(template[0].submenu));
    assert.equal(template[0].submenu[0].label, "In 1 hour");
    assert.equal(template[1].type, "separator");
    assert.equal(template[2].label, "Fork");
    template[2].click();
    assert.deepEqual(clicks, ["fork"]);
  });

  it("popup resolves null when the user dismisses", async () => {
    const Menu = {
      buildFromTemplate(t) {
        return {
          popup(opts) {
            opts.callback();
          },
        };
      },
    };
    const id = await showNativeContextMenu(null, [{ id: "fork", label: "Fork" }], { x: 1, y: 2 }, Menu);
    assert.equal(id, null);
  });
});
