"use strict";

// No host API crosses into the page. This compatibility surface only calls
// functions registered by this document; all descriptors/results are untrusted.
function installWebMcp(compatibilityAllowed) {
  if (globalThis !== globalThis.top || !globalThis.isSecureContext) return;
  const policy = document.permissionsPolicy || document.featurePolicy;
  if (policy?.features?.().includes("tools") && !policy.allowsFeature("tools")) return;
  const native = document.modelContext || navigator.modelContext;
  if (!native && !compatibilityAllowed) return;

  const encoder = new TextEncoder();
  const bytes = (s) => encoder.encode(s).length;
  const json = (value, limit) => {
    const text = JSON.stringify(value);
    if (typeof text !== "string" || bytes(text) > limit) throw new Error("WebMCP JSON exceeds its size limit");
    const copy = JSON.parse(text);
    const depth = (v, n) => {
      if (n > 20) throw new Error("WebMCP JSON exceeds 20 levels");
      if (v && typeof v === "object") for (const child of Object.values(v)) depth(child, n + 1);
    };
    depth(copy, 0);
    return copy;
  };
  const text = (s, limit) => {
    if (typeof s !== "string" || !s.trim() || bytes(s) > limit || /[\u0000-\u001f\u007f]/u.test(s)) {
      throw new Error("Invalid WebMCP text");
    }
    return s;
  };
  const descriptor = (tool) => {
    const name = text(tool.name, 128);
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error("Invalid WebMCP name");
    const schema = json(tool.inputSchema ?? { type: "object", properties: {} }, 16_384);
    if (!schema || typeof schema !== "object" || Array.isArray(schema) || schema.type !== "object") {
      throw new Error("WebMCP inputSchema must describe an object");
    }
    return {
      name, description: text(tool.description, 4096), inputSchema: schema,
      ...(tool.title ? { title: text(tool.title, 1024) } : {}),
      annotations: {
        readOnlyHint: tool.annotations?.readOnlyHint === true,
        consequentialHint: tool.annotations?.consequentialHint === true,
        untrustedContentHint: true,
      },
    };
  };
  const registered = new Map();
  const context = native || new EventTarget();
  const withAbort = async (operation, signal) => {
    signal.throwIfAborted();
    let onAbort;
    try {
      return await Promise.race([
        operation,
        new Promise((_, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
  };
  if (!native) {
    context.registerTool = async (tool, { signal } = {}) => {
      const safe = descriptor(tool);
      if (typeof tool.execute !== "function") throw new TypeError("WebMCP tool needs execute");
      signal?.throwIfAborted();
      if (registered.has(safe.name)) throw new Error("WebMCP tool name already registered");
      if (registered.size >= 128) throw new Error("WebMCP supports at most 128 tools");
      const entry = { ...safe, execute: tool.execute, revision: crypto.randomUUID() };
      registered.set(safe.name, entry);
      const unregister = () => {
        if (registered.get(safe.name) !== entry) return;
        registered.delete(safe.name);
        context.dispatchEvent(new Event("toolchange"));
      };
      signal?.addEventListener("abort", unregister, { once: true });
      context.dispatchEvent(new Event("toolchange"));
    };
    context.getTools = async () => [...registered.values()].map((tool) => ({
      ...tool, origin: location.origin, window: globalThis,
    }));
    context.executeTool = async (tool, input, { signal } = {}) => {
      signal?.throwIfAborted();
      const entry = registered.get(tool.name);
      if (!entry || tool.revision !== entry.revision) throw new Error("WebMCP tool is stale");
      return entry.execute(input, { signal });
    };
    Object.defineProperty(document, "modelContext", { value: context });
    // Older WebMCP applications register on Navigator.
    Object.defineProperty(navigator, "modelContext", { value: context });
  }
  const documentId = crypto.randomUUID();
  const pending = new Map();
  const retained = new Map();
  let epoch = 0;
  context.addEventListener?.("toolchange", () => { epoch++; retained.clear(); });
  let sequence = 0;
  const list = async () => {
    if (typeof context.getTools !== "function" || typeof context.executeTool !== "function") {
      return { available: false, tools: [], skipped: 0 };
    }
    const generation = epoch;
    const raw = await context.getTools();
    if (generation !== epoch) throw new Error("WebMCP tools changed; discover tools again");
    if (!Array.isArray(raw)) throw new Error("Invalid WebMCP tools");
    const tools = [];
    let size = 0;
    let skipped = Math.max(0, raw.length - 128);
    retained.clear();
    for (const tool of raw.slice(0, 128)) {
      try {
        // Only this top-level document is supported, including on native builds.
        if (tool.window !== globalThis || (tool.origin && tool.origin !== location.origin)) {
          skipped++; continue;
        }
        const safe = descriptor(tool);
        const signature = JSON.stringify(safe);
        const ref = `w${documentId}-${++sequence}`;
        const entry = { ref, ...safe };
        const length = bytes(JSON.stringify(entry));
        if (size + length > 32_768) { skipped++; continue; }
        size += length;
        retained.set(ref, { tool, signature });
        tools.push(entry);
      } catch { skipped++; }
    }
    return { available: true, implementation: native ? "native" : "compatibility", tools, skipped };
  };
  const bridge = Object.freeze({
    async tools() { return JSON.stringify({ documentId, ...await list() }); },
    async invoke(ref, input, invocationId) {
      const saved = retained.get(ref);
      if (!saved) throw new Error("WebMCP tool is stale; discover tools again");
      const controller = new AbortController();
      pending.set(invocationId, controller);
      try {
        const generation = epoch;
        const args = json(input, 16_384);
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("WebMCP arguments must be an object");
        const tools = await withAbort(context.getTools(), controller.signal);
        const current = tools.find((t) => t.name === saved.tool.name &&
          t.window === globalThis && (!t.origin || t.origin === location.origin));
        if (generation !== epoch || !current || JSON.stringify(descriptor(current)) !== saved.signature ||
            (!native && current.revision !== saved.tool.revision)) throw new Error("WebMCP tool is stale; discover tools again");
        controller.signal.throwIfAborted();
        const result = await withAbort(context.executeTool(current, args, { signal: controller.signal }), controller.signal);
        return JSON.stringify({ result: json(result === undefined ? null : result, 65_536) });
      } finally { if (pending.get(invocationId) === controller) pending.delete(invocationId); }
    },
    cancel(invocationId) {
      // Also fences an invocation that has been queued but has not started.
      retained.clear();
      pending.get(invocationId)?.abort(new DOMException("WebMCP call cancelled", "AbortError"));
    },
  });
  Object.defineProperty(globalThis, "__solentaWebMcp", { value: bridge });
}

if (process.versions.electron) {
  const { contextBridge, ipcRenderer } = require("electron");
  try {
    contextBridge.executeInMainWorld({
      func: installWebMcp,
      args: [ipcRenderer.sendSync("preview:webmcpPolicy") === true],
    });
  } catch { /* Unsupported bridge: DOM preview tools remain available. */ }
} else {
  module.exports = { installWebMcp };
}
