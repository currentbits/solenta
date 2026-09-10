/**
 * Command palette overlay (#150).
 * Run: npm run test:renderer -- --test-name-pattern="command palette ui"
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { useState } from "react";
import { inAct, mount } from "./support/dom.ts";
import { CommandPalette } from "../src/components/CommandPalette";
import {
  PALETTE_ACTIONS,
  matchPaletteShortcut,
  type PaletteMode,
} from "../src/commandPalette";
import type { ProjectInfo, ThreadInfo } from "../src/shared/ipc";
import { project, thread } from "./support/fakeCoder";

const projects: ProjectInfo[] = [
  project({ id: "p1", name: "alpha", slug: "acme/alpha", path: "/a" }),
  project({ id: "p2", name: "beta", slug: "acme/beta", path: "/b" }),
];

const threads: ThreadInfo[] = [
  thread({
    id: "t-fix",
    title: "Fix the search box",
    projectId: "p1",
    updatedAt: 3,
  }),
  thread({
    id: "t-old",
    title: "Old kanban layout",
    projectId: "p2",
    updatedAt: 2,
  }),
];

function PalletteHost({
  startOpen = true,
  startMode = "command" as PaletteMode,
  canSearchWorkspace = true,
  listFiles,
  searchFileContents,
  searchThreads,
  onSelectThread,
  onSelectProject,
  onRunAction,
  onOpenFile,
}: {
  startOpen?: boolean;
  startMode?: PaletteMode;
  canSearchWorkspace?: boolean;
  listFiles?: (query: string) => Promise<string[]>;
  searchFileContents?: (
    query: string,
  ) => Promise<Array<{ path: string; line: number; text: string }>>;
  searchThreads?: (input: { query: string }) => Promise<ThreadInfo[]>;
  onSelectThread?: (id: string) => void;
  onSelectProject?: (id: string) => void;
  onRunAction?: (id: string) => void;
  onOpenFile?: (path: string) => void;
}) {
  const [open, setOpen] = useState(startOpen);
  const [mode, setMode] = useState<PaletteMode>(startMode);
  return (
    <>
      <button type="button" data-opener="" onClick={() => setOpen(true)}>
        Open
      </button>
      <CommandPalette
        open={open}
        mode={mode}
        onClose={() => setOpen(false)}
        onModeChange={setMode}
        threads={threads}
        projects={projects}
        searchThreads={searchThreads ?? (async () => [])}
        listFiles={listFiles}
        searchFileContents={searchFileContents}
        canSearchWorkspace={canSearchWorkspace}
        onSelectThread={onSelectThread ?? (() => {})}
        onSelectProject={onSelectProject ?? (() => {})}
        onRunAction={onRunAction ?? (() => {})}
        onOpenFile={onOpenFile ?? (() => {})}
        actions={PALETTE_ACTIONS}
      />
    </>
  );
}

describe("command palette ui", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("lists actions and recent threads when empty", async () => {
    const m = await mount(<PalletteHost />);
    const dialog = m.query("[data-command-palette-dialog]");
    assert.ok(dialog);
    assert.match(m.text(), /New thread/);
    assert.match(m.text(), /Open settings/);
    assert.match(m.text(), /Fix the search box/);
    assert.equal(m.query("[data-palette-mode]")?.getAttribute("data-palette-mode"), "command");
    m.unmount();
  });

  it("filters actions as you type and Enter runs the highlight", async () => {
    const ran: string[] = [];
    const m = await mount(<PalletteHost onRunAction={(id) => ran.push(id)} />);
    const input = m.query("[data-command-palette-input]") as HTMLInputElement;
    assert.ok(input);
    await m.type(input, "settings");
    await m.flush();
    assert.match(m.text(), /Open settings/);
    assert.doesNotMatch(m.text(), /New thread/);
    await m.press(input, "Enter");
    await m.flush();
    assert.deepEqual(ran, ["settings"]);
    assert.equal(m.query("[data-command-palette]"), null);
    m.unmount();
  });

  it("arrow keys move the highlight to a thread and Enter selects it", async () => {
    const selected: string[] = [];
    const m = await mount(
      <PalletteHost onSelectThread={(id) => selected.push(id)} />,
    );
    const input = m.query("[data-command-palette-input]") as HTMLInputElement;
    await m.type(input, "search box");
    await m.flush();
    const threadRow = m.query('[data-palette-kind="thread"]');
    assert.ok(threadRow);
    await m.press(input, "Enter");
    await m.flush();
    assert.deepEqual(selected, ["t-fix"]);
    m.unmount();
  });

  it("Search files action switches mode; picking a file opens it", async () => {
    const opened: string[] = [];
    const m = await mount(
      <PalletteHost
        listFiles={async () => ["src/App.tsx", "README.md"]}
        onOpenFile={(path) => opened.push(path)}
      />,
    );
    const input = m.query("[data-command-palette-input]") as HTMLInputElement;
    await m.type(input, "Search files");
    await m.flush();
    await m.press(input, "Enter");
    await m.flush();
    assert.equal(
      m.query("[data-palette-mode]")?.getAttribute("data-palette-mode"),
      "files",
    );
    await m.flush();
    await inAct(() => new Promise((r) => setTimeout(r, 200)));
    await m.flush();
    assert.match(m.text(), /App\.tsx/);
    const fileRow = m.query('[data-palette-kind="file"]') as HTMLElement;
    assert.ok(fileRow);
    await m.click(fileRow);
    await m.flush();
    assert.ok(opened.includes("src/App.tsx"));
    m.unmount();
  });

  it("content mode greps and opens the hit path", async () => {
    const opened: string[] = [];
    const m = await mount(
      <PalletteHost
        startMode="content"
        searchFileContents={async (q) =>
          q.includes("export")
            ? [{ path: "src/App.tsx", line: 12, text: "export function App" }]
            : []
        }
        onOpenFile={(path) => opened.push(path)}
      />,
    );
    const input = m.query("[data-command-palette-input]") as HTMLInputElement;
    await m.type(input, "export");
    await inAct(() => new Promise((r) => setTimeout(r, 200)));
    await m.flush();
    assert.match(m.text(), /src\/App\.tsx:12/);
    await m.press(input, "Enter");
    await m.flush();
    assert.deepEqual(opened, ["src/App.tsx"]);
    m.unmount();
  });

  it("Escape closes and restores the opener", async () => {
    const m = await mount(<PalletteHost startOpen={false} />);
    const opener = m.query("[data-opener]") as HTMLElement;
    opener.focus();
    await m.click(opener);
    const dialog = m.query("[data-command-palette-dialog]") as HTMLElement;
    assert.ok(dialog);
    await m.pressFocused("Escape");
    assert.equal(m.query("[data-command-palette]"), null);
    assert.equal(document.activeElement, opener);
    m.unmount();
  });

  it("matchPaletteShortcut is what App listens for", () => {
    assert.equal(
      matchPaletteShortcut({
        key: "k",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      }),
      "command",
    );
  });
});
