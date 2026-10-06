/** Dev servers, simulator, preview, terminal and file fixtures for the browser-dev fixture. */
import type {
  CoderApi,
  DevServerState,
  TerminalState,
  PreviewSnapshot,
  LocalServerInfo,
} from "../shared/ipc";
import { SIGNIN_TERMINAL_ID } from "../shared/ipc";

export function createWorkspace(): Pick<CoderApi, "servers" | "simulator" | "preview" | "devserver" | "terminal" | "files" | "fs" | "attachments" | "shell"> {
  /** In-memory per-thread demo servers (Vite-only; Electron uses electron/devservers.js). */
  const demoDevServers = new Map<string, DevServerState>();
  /** Terminal scrollback per thread. The browser harness has no shell. */
  const demoTerminals = new Map<string, string>();

  function demoTerminal(threadId: string, since?: number | null): TerminalState {
    const all = demoTerminals.get(threadId);
    const stale = typeof since !== "number" || since < 0 || since > (all ?? "").length;
    return {
      termId: "1",
      running: all != null,
      pty: false,
      cwd: all == null ? "" : "/demo/worktree",
      shell: all == null ? "" : "/bin/zsh",
      cursor: (all ?? "").length,
      text: stale ? (all ?? "") : (all ?? "").slice(since),
      reset: stale,
      startedAt: 0,
      staleRoot: false,
    };
  }

  return {
    servers: {
      async list(_input: { threadId: string }): Promise<LocalServerInfo[]> {
        return [];
      },
    },
    simulator: {
      async capabilities() {
        return {
          platform: "darwin",
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
      },
      async selectDeveloperDir() {
        return this.capabilities({ threadId: "" });
      },
      async listDevices() {
        return [];
      },
      async status() {
        return {
          attached: false,
          state: null,
          isOwner: false,
          generation: null,
          deviceUdid: null,
          bootedBySolenta: null,
          stream: "disconnected" as const,
          input: "disconnected" as const,
          accessibility: "disconnected" as const,
        };
      },
      async attach() {
        throw Object.assign(new Error("iOS Simulator requires macOS"), {
          code: "unsupported_platform",
        });
      },
      async detach() {
        return { detached: true as const };
      },
      async takeControl() {
        throw Object.assign(new Error("iOS Simulator requires macOS"), {
          code: "unsupported_platform",
        });
      },
      async streamInfo() {
        throw Object.assign(new Error("iOS Simulator requires macOS"), {
          code: "unsupported_platform",
        });
      },
      async retryStream() {
        throw Object.assign(new Error("iOS Simulator requires macOS"), {
          code: "unsupported_platform",
        });
      },
      async sendInput() {
        throw Object.assign(new Error("iOS Simulator requires macOS"), {
          code: "unsupported_platform",
        });
      },
      async accessibility() {
        throw Object.assign(new Error("iOS Simulator requires macOS"), {
          code: "unsupported_platform",
        });
      },
      async scrollTo() {
        throw Object.assign(new Error("iOS Simulator requires macOS"), {
          code: "unsupported_platform",
        });
      },
      async install() {
        throw Object.assign(new Error("iOS Simulator requires macOS"), {
          code: "unsupported_platform",
        });
      },
      async launch() {
        throw Object.assign(new Error("iOS Simulator requires macOS"), {
          code: "unsupported_platform",
        });
      },
      async openUrl() {
        throw Object.assign(new Error("iOS Simulator requires macOS"), {
          code: "unsupported_platform",
        });
      },
      async screenshot() {
        throw Object.assign(new Error("iOS Simulator requires macOS"), {
          code: "unsupported_platform",
        });
      },
      async startRecording() {
        throw Object.assign(new Error("iOS Simulator requires macOS"), {
          code: "unsupported_platform",
        });
      },
      async stopRecording() {
        throw Object.assign(new Error("iOS Simulator requires macOS"), {
          code: "unsupported_platform",
        });
      },
    },
    preview: {
      async bind(_input: { threadId: string; webContentsId: number }): Promise<PreviewSnapshot> {
        return { url: "", title: "", canGoBack: false, canGoForward: false };
      },
      async unbind(_input: { threadId: string; webContentsId?: number }) {
        return { ok: true };
      },
      async navigate(input: { threadId: string; url: string }): Promise<PreviewSnapshot> {
        return {
          url: input.url,
          title: "",
          canGoBack: false,
          canGoForward: false,
        };
      },
      async reload(_input: { threadId: string }): Promise<PreviewSnapshot> {
        return { url: "", title: "", canGoBack: false, canGoForward: false };
      },
      async goBack(_input: { threadId: string }): Promise<PreviewSnapshot> {
        return { url: "", title: "", canGoBack: false, canGoForward: false };
      },
      async goForward(_input: { threadId: string }): Promise<PreviewSnapshot> {
        return { url: "", title: "", canGoBack: false, canGoForward: false };
      },
      async info(_input: { threadId: string }): Promise<PreviewSnapshot> {
        return { url: "", title: "", canGoBack: false, canGoForward: false };
      },
      async screenshot(_input: { threadId: string }) {
        return {
          url: "http://localhost:5173/",
          title: "",
          canGoBack: false,
          canGoForward: false,
          dataUrl: "data:image/png;base64,aaa",
        };
      },
      async click(_input: { threadId: string; selector: string }): Promise<PreviewSnapshot> {
        return { url: "", title: "", canGoBack: false, canGoForward: false };
      },
      async type(_input: {
        threadId: string;
        selector: string;
        text: string;
      }): Promise<PreviewSnapshot> {
        return { url: "", title: "", canGoBack: false, canGoForward: false };
      },
    },
    devserver: {
      async scripts(_input: { threadId: string }): Promise<string[]> {
        return ["dev"];
      },
      async start(input: { threadId: string; script: string }): Promise<DevServerState> {
        const existing = demoDevServers.get(input.threadId);
        if (existing?.running) return { ...existing };
        const state: DevServerState = {
          running: true,
          script: input.script,
          url: "http://localhost:5173/",
          startedAt: Date.now(),
          lastLines: ["  Local: http://localhost:5173/"],
        };
        demoDevServers.set(input.threadId, state);
        return { ...state };
      },
      async stop(input: { threadId: string }): Promise<DevServerState> {
        demoDevServers.delete(input.threadId);
        return { running: false };
      },
      async status(input: { threadId: string }): Promise<DevServerState> {
        const state = demoDevServers.get(input.threadId);
        return state ? { ...state } : { running: false };
      },
    },
    terminal: {
      async open(input: { threadId: string }): Promise<TerminalState> {
        demoTerminals.set(
          input.threadId,
          "Demo shell. Electron runs a real one.\r\n",
        );
        return demoTerminal(input.threadId);
      },
      async write(): Promise<{ ok: boolean }> {
        return { ok: false };
      },
      async resize(): Promise<{ ok: boolean }> {
        return { ok: false };
      },
      async read(input: { threadId: string; since?: number }): Promise<TerminalState> {
        return demoTerminal(input.threadId, input.since);
      },
      async list(): Promise<string[]> {
        return [];
      },
      async close(input: { threadId: string }): Promise<TerminalState> {
        demoTerminals.delete(input.threadId);
        return demoTerminal(input.threadId);
      },
      async signIn(input: { provider: string; threadId?: string | null }) {
        const threadId = input.threadId || SIGNIN_TERMINAL_ID;
        demoTerminals.set(threadId, `Demo shell. Electron would run: ${input.provider} login\r\n`);
        return { threadId, termId: "signin" };
      },
    },
    files: {
      async list(input: { threadId: string; query?: string; limit?: number }) {
        const q = (input.query ?? "").toLowerCase();
        const all = [
          "src/App.tsx",
          "src/components/ThreadView.tsx",
          "src/components/Composer.tsx",
          "src/useCoder.ts",
          "electron/main.js",
          "README.md",
          "package.json",
        ];
        const cap = Math.min(Math.max(Number(input.limit) || 20, 1), 80);
        return {
          files: all
            .filter((f) => !q || f.toLowerCase().includes(q))
            .slice(0, cap),
        };
      },
      async search(input: { threadId: string; query: string }) {
        const q = (input.query ?? "").toLowerCase();
        if (!q) return { hits: [] };
        const hits = [
          {
            path: "src/App.tsx",
            line: 12,
            text: "export function App() {",
          },
          {
            path: "README.md",
            line: 1,
            text: "# Solenta",
          },
        ].filter(
          (h) =>
            h.path.toLowerCase().includes(q) ||
            h.text.toLowerCase().includes(q),
        );
        return { hits };
      },
      async image(_input: { name: string }) {
        return { dataUrl: null };
      },
      async resolve(input: { threadId: string; paths: string[] }) {
        const known = new Set([
          "src/App.tsx",
          "src/components/ThreadView.tsx",
          "src/components/Composer.tsx",
          "src/useCoder.ts",
          "electron/main.js",
          "README.md",
          "package.json",
        ]);
        return {
          resolved: input.paths.map((p) => ({
            path: p,
            abs: known.has(p) ? `/Users/demo/project/${p}` : null,
          })),
        };
      },
    },
    fs: {
      async browse(input: { path: string; environment?: string | null }) {
        const parent = input.path?.trim() || "~/";
        return {
          parentPath: parent.endsWith("/") ? parent : `${parent}/`,
          existed: true,
          entries: [
            { name: "Code", fullPath: "/Users/demo/Code" },
            { name: "Projects", fullPath: "/Users/demo/Projects" },
          ],
        };
      },
    },
    attachments: {
      async pick() {
        // Dev mock: no native dialog in a browser.
        return { attachments: [] };
      },
      async fromPaths(_input: { paths: string[] }) {
        return { attachments: [] };
      },
      async saveImage(_input: { threadId: string; dataUrl: string }) {
        return { attachment: null };
      },
      async saveFile(_input: {
        threadId: string;
        name: string;
        dataUrl: string;
      }) {
        return { attachment: null };
      },
      async saveFolder(_input: {
        threadId: string;
        name: string;
        files: Array<{ relativePath: string; dataUrl: string }>;
      }) {
        return { attachment: null };
      },
      async readImage(_input: { path: string }) {
        return { dataUrl: null };
      },
      async listWindows() {
        return { windows: [] };
      },
      async captureWindow(_input: { threadId: string; sourceId: string }) {
        return { attachment: null };
      },
    },
    shell: {
      async reveal(_input: { threadId: string; path: string }) {
        // Dev mock: no Finder.
      },
      async openPath(_input: { threadId: string; path: string }) {
        // Dev mock: no editor.
      },
      async editors() {
        return [
          { id: "cursor" as const, name: "Cursor" },
          { id: "vscode" as const, name: "VS Code" },
          { id: "finder" as const, name: "Finder" },
        ];
      },
      async openIn(_input: { threadId: string; path: string; editor: string }) {
        // Dev mock: no editor.
      },
    },
  };
}
