// Real renderer, entirely in-memory API. No preload, providers or user store.
import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { createDevCoder } from "../../src/devCoder";
import { saveBootSnapshot } from "../../src/bootSnapshot";
import speechCatalog from "../../src/speechModels";
import "../../src/index.css";

const api = createDevCoder();
await api.settings.set({ onboardingSeen: true, theme: "dark", speech: { provider: "local", localModel: "nemotron-3.5", language: "nl-NL" } });
const speechModel = speechCatalog.models["nemotron-3.5"];
api.speech.status = async () => ({
  state: "ready", runtimeReady: true, modelReady: true, language: "nl-NL",
  model: { id: "nemotron-3.5", label: speechModel.label, bytes: speechModel.bytes },
  modelLocation: { source: "external", filename: speechModel.filename },
});
const projects = await api.projects.list();
const source = (await api.threads.list()).find((t) => t.id === "thread-2")!;
const thread = { ...source, status: "idle" as const, title: "Review narrow window layout", awaitingInput: false };
const detail = { ...(await api.threads.get(source.id)), thread, messages: [], pendingPermission: null };
const listeners = new Set<(detail: unknown) => void>();
api.threads.list = async () => [thread];
api.threads.get = async () => structuredClone(detail);
const on = api.on.bind(api);
api.on = ((channel: string, cb: (value: unknown) => void) => {
  if (channel === "threads:changed") return () => {};
  if (channel === "thread:updated") {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }
  return on(channel as never, cb as never);
}) as typeof api.on;
api.runs.start = async () => { throw new Error("Layout fixture must never start a run"); };
window.coder = api;
saveBootSnapshot({ projects, threads: [thread], selectedThreadId: thread.id });
(window as any).layoutFixture = {
  approval() {
    // Taller than the transcript viewport: decisions must remain reachable.
    Object.assign(detail, { pendingPermission: {
      requestId: "layout-approval", toolName: "Write", summary: "Review proposed file",
      input: JSON.stringify({ path: "src/layout.ts", content: Array.from({ length: 60 }, (_, i) => `Proposed line ${i + 1}`).join("\n") }, null, 2),
      guardrail: { rule: null, reason: "Review this proposed change before allowing the tool to continue. ".repeat(15) },
    } });
    thread.awaitingInput = true;
    for (const cb of listeners) cb(structuredClone(detail));
  },
};
createRoot(document.getElementById("root")!).render(<App />);
