/**
 * iOS Simulator pane: checklist, lease, stream reconnect, and direct controls.
 * Run: node --import=./test/support/render.mjs --experimental-strip-types --test test/simulatorPane.test.tsx
 */
import assert from "node:assert/strict";
import { afterEach, before, describe, it } from "node:test";
import { createElement } from "react";
import { mount, unmountAll } from "./support/dom.ts";
import { SimulatorPane } from "../src/components/SimulatorPane";
import { PaneWorkspace, ViewsMenu } from "../src/components/PaneWorkspace";
import {
  defaultPaneLayout,
  firstLeafId,
  openPane,
} from "../src/paneLayout";
import { isWebMode } from "../src/shared/wire";
import type {
  CoderApi,
  SimulatorAccessibilityNode,
  SimulatorCapabilitySnapshot,
  SimulatorDeviceInfo,
  SimulatorStatus,
} from "../src/shared/ipc";

before(async () => {
  const boot = await mount(createElement("div"));
  boot.unmount();
});

afterEach(() => {
  if (typeof window !== "undefined") {
    delete (window as unknown as { coder?: unknown }).coder;
  }
  unmountAll();
});

function desktop(): void {
  (window as unknown as { coder: object }).coder = {};
}

function unsupportedCaps(): SimulatorCapabilitySnapshot {
  return {
    platform: "linux",
    supported: false,
    developerDir: "",
    xcode: { version: "0", build: "0" },
    licenseAccepted: false,
    runtimes: [],
    capabilities: {
      deviceLifecycle: false,
      screenshot: false,
      recording: false,
      stream: false,
      touch: false,
      keyboard: false,
      hardwareButtons: false,
      accessibility: false,
    },
  };
}

function readyCaps(
  over: Partial<SimulatorCapabilitySnapshot> = {},
): SimulatorCapabilitySnapshot {
  return {
    platform: "darwin",
    supported: true,
    developerDir: "/Applications/Xcode.app/Contents/Developer",
    xcode: { version: "26.0", build: "17A324" },
    licenseAccepted: true,
    runtimes: [
      {
        identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
        name: "iOS 18.0",
        devices: [
          { udid: "UDID-1", name: "iPhone 16", state: "Shutdown" },
        ],
      },
    ],
    capabilities: {
      deviceLifecycle: true,
      screenshot: true,
      recording: true,
      stream: true,
      touch: true,
      keyboard: true,
      hardwareButtons: true,
      accessibility: true,
    },
    ...over,
  };
}

function status(over: Partial<SimulatorStatus> = {}): SimulatorStatus {
  return {
    attached: false,
    state: null,
    isOwner: false,
    generation: null,
    deviceUdid: null,
    bootedBySolenta: null,
    stream: "disconnected",
    input: "disconnected",
    accessibility: "disconnected",
    ...over,
  };
}

const DEVICES: SimulatorDeviceInfo[] = [
  {
    udid: "UDID-1",
    name: "iPhone 16",
    state: "Shutdown",
    runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
    runtimeName: "iOS 18.0",
  },
];

const AX: SimulatorAccessibilityNode = {
  role: "Application",
  label: "Demo",
  identifier: "app",
  value: null,
  enabled: true,
  selected: false,
  frame: { x: 0, y: 0, width: 390, height: 844 },
  children: [
    {
      role: "Button",
      label: "Login",
      identifier: "login",
      value: null,
      enabled: true,
      selected: false,
      frame: { x: 10, y: 20, width: 80, height: 44 },
      children: [],
    },
  ],
};

function fakeApi(
  over: Partial<CoderApi["simulator"]> = {},
): CoderApi["simulator"] & { calls: string[] } {
  const calls: string[] = [];
  const api = {
    calls,
    capabilities: async () => {
      calls.push("capabilities");
      return readyCaps();
    },
    selectDeveloperDir: async () => {
      calls.push("selectDeveloperDir");
      return readyCaps();
    },
    listDevices: async () => {
      calls.push("listDevices");
      return DEVICES;
    },
    status: async () => {
      calls.push("status");
      return status();
    },
    attach: async (input) => {
      calls.push(`attach:${input.deviceUdid}`);
      return {
        generation: 1,
        deviceUdid: input.deviceUdid,
        bootedBySolenta: true,
      };
    },
    detach: async () => {
      calls.push("detach");
      return { detached: true as const };
    },
    takeControl: async (input) => {
      calls.push(`takeControl:${String(input.confirmed)}`);
      return {
        generation: 2,
        deviceUdid: input.deviceUdid ?? "UDID-1",
        bootedBySolenta: true,
      };
    },
    streamInfo: async () => {
      calls.push("streamInfo");
      return {
        url: "ws://127.0.0.1:9/sim",
        token: "viewer",
        generation: 1,
        protocolVersion: 1 as const,
        maxMessageBytes: 4194304 as const,
      };
    },
    retryStream: async () => {
      calls.push("retryStream");
      return {
        url: "ws://127.0.0.1:9/sim",
        token: "viewer",
        generation: 1,
        protocolVersion: 1 as const,
        maxMessageBytes: 4194304 as const,
      };
    },
    sendInput: async (input) => {
      calls.push(`sendInput:${input.input.kind}`);
      return { ok: true as const };
    },
    accessibility: async () => {
      calls.push("accessibility");
      return { tree: AX };
    },
    scrollTo: async () => ({ ok: true as const }),
    install: async (input) => {
      calls.push(`install:${input.relativeAppPath}`);
      return { bundleId: "com.example.app" };
    },
    launch: async (input) => {
      calls.push(`launch:${input.bundleId}`);
      return { pid: 42 };
    },
    openUrl: async (input) => {
      calls.push(`openUrl:${input.url}`);
      return { opened: true as const };
    },
    screenshot: async () => {
      calls.push("screenshot");
      return {
        id: "art-1",
        threadId: "t1",
        runId: null,
        source: "simulator" as const,
        kind: "image" as const,
        mimeType: "image/png" as const,
        name: "simulator.png",
        size: 12,
        createdAt: new Date().toISOString(),
      };
    },
    startRecording: async () => {
      calls.push("startRecording");
      return { recordingId: "rec-1", startedAt: Date.now() - 65_000 };
    },
    stopRecording: async () => {
      calls.push("stopRecording");
      return {};
    },
    ...over,
  };
  return api as CoderApi["simulator"] & { calls: string[] };
}

const noopConnect = () => ({ disconnect() {} });

describe("SimulatorPane", () => {
  it("shows unsupported platform from the capability snapshot", async () => {
    desktop();
    const api = fakeApi({
      capabilities: async () => unsupportedCaps(),
    });
    const m = await mount(
      <SimulatorPane threadId="t1" api={api} connectStream={noopConnect} />,
    );
    await m.flush();
    assert.ok(m.query("[data-simulator-unsupported]"));
    assert.match(m.text(), /linux|macOS|unsupported/i);
    m.unmount();
  });

  it("renders the Xcode, license, and runtime checklist", async () => {
    desktop();
    const api = fakeApi({
      capabilities: async () =>
        readyCaps({
          licenseAccepted: false,
          runtimes: [],
          xcode: { version: "0", build: "0" },
        }),
    });
    const m = await mount(
      <SimulatorPane threadId="t1" api={api} connectStream={noopConnect} />,
    );
    await m.flush();
    assert.ok(m.query("[data-simulator-check='platform']"));
    assert.ok(m.query("[data-simulator-check='xcode']"));
    assert.ok(m.query("[data-simulator-check='license']"));
    assert.ok(m.query("[data-simulator-check='runtime']"));
    assert.equal(
      m.query("[data-simulator-check='license']")!.getAttribute("data-ok"),
      "false",
    );
    assert.equal(
      m.query("[data-simulator-check='runtime']")!.getAttribute("data-ok"),
      "false",
    );
    m.unmount();
  });

  it("selects a device and attaches", async () => {
    desktop();
    const api = fakeApi();
    const m = await mount(
      <SimulatorPane threadId="t1" api={api} connectStream={noopConnect} />,
    );
    await m.flush();
    const select = m.query("[data-simulator-devices]") as HTMLSelectElement;
    assert.ok(select);
    await m.change(select, "UDID-1");
    await m.click(m.query("[data-simulator-attach]"));
    await m.flush();
    assert.ok(api.calls.includes("attach:UDID-1"));
    m.unmount();
  });

  it("detaches an owned session", async () => {
    desktop();
    const api = fakeApi({
      status: async () =>
        status({
          attached: true,
          state: "active",
          isOwner: true,
          generation: 1,
          deviceUdid: "UDID-1",
          stream: "connected",
          input: "connected",
        }),
    });
    const m = await mount(
      <SimulatorPane threadId="t1" api={api} connectStream={noopConnect} />,
    );
    await m.flush();
    await m.click(m.query("[data-simulator-detach]"));
    await m.flush();
    assert.ok(api.calls.includes("detach"));
    m.unmount();
  });

  it("shows a busy owner and requires explicit takeover confirmation", async () => {
    desktop();
    const api = fakeApi({
      status: async () =>
        status({
          attached: true,
          state: "active",
          isOwner: false,
          generation: 3,
          deviceUdid: "UDID-1",
        }),
    });
    const m = await mount(
      <SimulatorPane threadId="t1" api={api} connectStream={noopConnect} />,
    );
    await m.flush();
    assert.ok(m.query("[data-simulator-busy]"));
    assert.equal(m.query("[data-simulator-takeover-confirm]"), null);
    await m.click(m.query("[data-simulator-takeover]"));
    assert.ok(m.query("[data-simulator-takeover-confirm]"));
    assert.equal(
      api.calls.includes("takeControl:true"),
      false,
      "must not take over until confirmed",
    );
    await m.click(m.query("[data-simulator-takeover-confirm]"));
    await m.flush();
    assert.ok(api.calls.includes("takeControl:true"));
    m.unmount();
  });

  it("reconnects a disconnected stream", async () => {
    desktop();
    const api = fakeApi({
      status: async () =>
        status({
          attached: true,
          state: "active",
          isOwner: true,
          generation: 1,
          deviceUdid: "UDID-1",
          stream: "disconnected",
        }),
    });
    const m = await mount(
      <SimulatorPane threadId="t1" api={api} connectStream={noopConnect} />,
    );
    await m.flush();
    await m.click(m.query("[data-simulator-reconnect]"));
    await m.flush();
    assert.ok(api.calls.includes("retryStream"));
    m.unmount();
  });

  it("sends hardware button input", async () => {
    desktop();
    const api = fakeApi({
      status: async () =>
        status({
          attached: true,
          state: "active",
          isOwner: true,
          generation: 1,
          deviceUdid: "UDID-1",
          stream: "connected",
          input: "connected",
        }),
    });
    const m = await mount(
      <SimulatorPane threadId="t1" api={api} connectStream={noopConnect} />,
    );
    await m.flush();
    await m.click(m.query("[data-simulator-button='home']"));
    await m.flush();
    assert.ok(api.calls.includes("sendInput:button"));
    m.unmount();
  });

  it("installs, launches, and opens a URL", async () => {
    desktop();
    const api = fakeApi({
      status: async () =>
        status({
          attached: true,
          state: "active",
          isOwner: true,
          generation: 1,
          deviceUdid: "UDID-1",
        }),
    });
    const m = await mount(
      <SimulatorPane threadId="t1" api={api} connectStream={noopConnect} />,
    );
    await m.flush();
    await m.type(m.query("[data-simulator-install-path]"), "Build/App.app");
    await m.click(m.query("[data-simulator-install]"));
    await m.flush();
    await m.type(m.query("[data-simulator-launch-id]"), "com.example.app");
    await m.click(m.query("[data-simulator-launch]"));
    await m.flush();
    await m.type(m.query("[data-simulator-url-input]"), "https://example.test");
    await m.click(m.query("[data-simulator-url]"));
    await m.flush();
    assert.ok(api.calls.includes("install:Build/App.app"));
    assert.ok(api.calls.includes("launch:com.example.app"));
    assert.ok(api.calls.includes("openUrl:https://example.test"));
    m.unmount();
  });

  it("captures a screenshot", async () => {
    desktop();
    const api = fakeApi({
      status: async () =>
        status({
          attached: true,
          state: "active",
          isOwner: true,
          generation: 1,
          deviceUdid: "UDID-1",
        }),
    });
    const m = await mount(
      <SimulatorPane threadId="t1" api={api} connectStream={noopConnect} />,
    );
    await m.flush();
    await m.click(m.query("[data-simulator-screenshot]"));
    await m.flush();
    assert.ok(api.calls.includes("screenshot"));
    m.unmount();
  });

  it("shows a recording timer", async () => {
    desktop();
    const api = fakeApi({
      status: async () =>
        status({
          attached: true,
          state: "active",
          isOwner: true,
          generation: 1,
          deviceUdid: "UDID-1",
        }),
    });
    const m = await mount(
      <SimulatorPane threadId="t1" api={api} connectStream={noopConnect} />,
    );
    await m.flush();
    await m.click(m.query("[data-simulator-record]"));
    await m.flush();
    assert.ok(api.calls.includes("startRecording"));
    const elapsed = m.query("[data-simulator-record-elapsed]");
    assert.ok(elapsed);
    assert.match(elapsed!.textContent || "", /1:0[45]/);
    m.unmount();
  });

  it("loads accessibility output", async () => {
    desktop();
    const api = fakeApi({
      status: async () =>
        status({
          attached: true,
          state: "active",
          isOwner: true,
          generation: 1,
          deviceUdid: "UDID-1",
          accessibility: "connected",
        }),
    });
    const m = await mount(
      <SimulatorPane threadId="t1" api={api} connectStream={noopConnect} />,
    );
    await m.flush();
    await m.click(m.query("[data-simulator-ax]"));
    await m.flush();
    assert.ok(api.calls.includes("accessibility"));
    assert.match(m.query("[data-simulator-ax-tree]")!.textContent || "", /Login/);
    m.unmount();
  });

  it("hides and refuses the simulator in Web mode", async () => {
    assert.equal(isWebMode(), true);
    const api = fakeApi();
    const m = await mount(
      <SimulatorPane threadId="t1" api={api} connectStream={noopConnect} />,
    );
    await m.flush();
    assert.ok(m.query("[data-simulator-web-hidden]"));
    assert.equal(m.query("[data-simulator-devices]"), null);
    assert.equal(api.calls.includes("capabilities"), false);
    m.unmount();
  });
});

describe("PaneWorkspace simulator view", () => {
  it("omits simulator from Views in Web mode and refuses a stale leaf", async () => {
    assert.equal(isWebMode(), true);
    const layout = openPane(defaultPaneLayout(), "simulator", "pane-1").layout;
    const m = await mount(
      <PaneWorkspace
        layout={layout}
        focusedId={firstLeafId(layout)}
        onChange={() => {}}
        onFocus={() => {}}
        renderPane={(leaf) => <div data-live={leaf.type}>{leaf.type}</div>}
      />,
    );
    assert.ok(m.query("[data-simulator-web-hidden]"));
    assert.equal(m.query("[data-live='simulator']"), null);

    const menu = await mount(
      <ViewsMenu
        layout={defaultPaneLayout()}
        onOpen={() => {}}
        onReset={() => {}}
      />,
    );
    await menu.click(menu.query("[data-views-btn]"));
    assert.equal(menu.query("[data-views-item='simulator']"), null);
    m.unmount();
    menu.unmount();
  });

  it("lists the shipped simulator pane on desktop", async () => {
    desktop();
    const menu = await mount(
      <ViewsMenu
        layout={defaultPaneLayout()}
        onOpen={() => {}}
        onReset={() => {}}
      />,
    );
    await menu.click(menu.query("[data-views-btn]"));
    assert.ok(menu.query("[data-views-item='simulator']"));
    assert.match(
      menu.query("[data-views-item='simulator']")!.textContent || "",
      /iOS Simulator/,
    );
    menu.unmount();
  });
});
