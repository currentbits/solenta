import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { mount } from "./support/dom";
import {
  ProjectIcon,
  projectAvatarColor,
  projectInitials,
} from "../src/components/ProjectIcon";

describe("ProjectIcon initials fallback (#1429)", () => {
  it("derives two-letter initials from the last path segment", () => {
    assert.equal(projectInitials("acme/nebula"), "NE");
    assert.equal(projectInitials("my-cool-app"), "MC");
    assert.equal(projectInitials("C:\\code\\solenta"), "SO");
    assert.equal(projectInitials("x"), "X");
    assert.equal(projectInitials("  "), "");
  });

  it("keeps a stable colour per seed", () => {
    assert.equal(projectAvatarColor("p1"), projectAvatarColor("p1"));
  });

  it("prefers the icon, falls back to a tile, and stays empty without a name", async () => {
    const icon = await mount(<ProjectIcon url="data:," name="acme/nebula" />);
    assert.ok(icon.query("[data-project-icon]"));
    assert.equal(icon.query("[data-project-avatar]"), null);
    icon.unmount();
    const tile = await mount(<ProjectIcon name="acme/nebula" seed="p1" />);
    assert.equal(tile.query("[data-project-avatar]")?.textContent, "NE");
    tile.unmount();
    const none = await mount(<ProjectIcon url={null} />);
    assert.equal(none.query("[data-project-avatar], [data-project-icon]"), null);
    none.unmount();
  });
});
