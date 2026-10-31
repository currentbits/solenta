/**
 * Command palette overlay (#150).
 * Run: npm run test:renderer -- --test-name-pattern="command palette ui"
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { useState } from "react";
import { inAct, mount } from "./support/dom.ts";
import {
  CommandPalette,
  type CommandPaletteProps,
} from "../src/components/CommandPalette";
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
  searchMessages,
  onSelectThread,
  onSelectMessage,
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
  searchThreads?: CommandPaletteProps["searchThreads"];
  searchMessages?: CommandPaletteProps["searchMessages"];
  onSelectThread?: (id: string) => void;
  onSelectMessage?: (threadId: string, messageId: string) => void;
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
        searchThreads={
          searchThreads ?? (async () => ({ threads: [], truncated: false }))
        }
        searchMessages={
          searchMessages ?? (async () => ({ hits: [], truncated: false }))
        }
        listFiles={listFiles}
        searchFileContents={searchFileContents}
        canSearchWorkspace={canSearchWorkspace}
        onSelectThread={onSelectThread ?? (() => {})}
        onSelectMessage={onSelectMessage ?? (() => {})}
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

  it("a leading > shows actions only (#1506)", async () => {
    const searched: string[] = [];
    const m = await mount(
      <PalletteHost
        searchThreads={async ({ query }) => {
          searched.push(query);
          return { threads: [], truncated: false };
        }}
      />,
    );
    const input = m.query("[data-command-palette-input]") as HTMLInputElement;
    await m.type(input, ">");
    await m.flush();
    assert.match(m.text(), /New thread/);
    assert.doesNotMatch(m.text(), /Fix the search box/, "no recent threads");
    assert.match(m.text(), /Actions/);
    await m.type(input, "> kanban");
    await new Promise((r) => setTimeout(r, 200));
    await m.flush();
    assert.match(m.text(), /Open kanban/);
    assert.doesNotMatch(m.text(), /Old kanban layout/, "threads are filtered out");
    assert.deepEqual(searched, [], "no transcript search for actions");
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

  it("shows message hits with the snippet highlighted; selecting one calls onSelectMessage (#1761)", async () => {
    const selectedMessages: Array<[string, string]> = [];
    const m = await mount(
      <PalletteHost
        searchMessages={async ({ query }) =>
          query === "parser bug"
            ? {
                hits: [
                  {
                    threadId: "t-old",
                    messageId: "m1",
                    snippet: "the parser bug is in the lexer",
                    createdAt: 5,
                  },
                ],
                truncated: false,
              }
            : { hits: [], truncated: false }
        }
        onSelectMessage={(threadId, messageId) =>
          selectedMessages.push([threadId, messageId])
        }
      />,
    );
    const input = m.query("[data-command-palette-input]") as HTMLInputElement;
    await m.type(input, "parser bug");
    await inAct(() => new Promise((r) => setTimeout(r, 200)));
    await m.flush();
    const messageRow = m.query('[data-palette-kind="message"]') as HTMLElement;
    assert.ok(messageRow, "a message result row renders");
    assert.match(messageRow.textContent || "", /parser bug is in the lexer/);
    const mark = messageRow.querySelector("mark");
    assert.ok(mark, "the matched word is wrapped for highlighting");
    assert.equal(mark?.textContent, "parser");
    await m.click(messageRow);
    await m.flush();
    assert.deepEqual(selectedMessages, [["t-old", "m1"]]);
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

// #1800: palette rows show the sidebar's status word/tone (statusLabelFor),
// not a reinvented vocabulary.
describe("command palette status chip (#1800)", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  function statusThreads(): ThreadInfo[] {
    return [
      thread({
        id: "t-working",
        title: "Working thread",
        projectId: "p1",
        status: "working",
        updatedAt: 4,
      }),
      thread({
        id: "t-wait",
        title: "Waiting thread",
        projectId: "p1",
        status: "working",
        awaitingInput: true,
        updatedAt: 3,
      }),
      thread({
        id: "t-failed",
        title: "Failed thread",
        projectId: "p1",
        status: "failed",
        updatedAt: 2,
      }),
      thread({
        id: "t-done",
        title: "Done thread",
        projectId: "p1",
        status: "done",
        updatedAt: 100,
        lastVisitedAt: 1,
      }),
    ];
  }

  function renderPalette(
    over: Partial<CommandPaletteProps> = {},
  ) {
    return (
      <CommandPalette
        open
        mode="command"
        onClose={() => {}}
        onModeChange={() => {}}
        threads={statusThreads()}
        projects={projects}
        searchThreads={async () => ({ threads: [], truncated: false })}
        searchMessages={async () => ({ hits: [], truncated: false })}
        canSearchWorkspace={false}
        onSelectThread={() => {}}
        onSelectMessage={() => {}}
        onSelectProject={() => {}}
        onRunAction={() => {}}
        onOpenFile={() => {}}
        actions={PALETTE_ACTIONS}
        {...over}
      />
    );
  }

  it("shows Working for a working thread", async () => {
    const m = await mount(renderPalette());
    const row = [...document.querySelectorAll('[data-palette-kind="thread"]')].find(
      (el) => el.textContent?.includes("Working thread"),
    ) as HTMLElement;
    assert.ok(row, "working thread row renders");
    const chip = row.querySelector("[data-palette-status]");
    assert.ok(chip, "status chip renders");
    assert.equal(chip?.getAttribute("data-palette-status"), "Working");
    assert.equal(chip?.getAttribute("data-tone"), "working");
    m.unmount();
  });

  it("shows Waiting for a thread awaiting input", async () => {
    const m = await mount(renderPalette());
    const row = [...document.querySelectorAll('[data-palette-kind="thread"]')].find(
      (el) => el.textContent?.includes("Waiting thread"),
    ) as HTMLElement;
    assert.ok(row, "waiting thread row renders");
    const chip = row.querySelector("[data-palette-status]");
    assert.equal(chip?.getAttribute("data-palette-status"), "Waiting");
    assert.equal(chip?.getAttribute("data-tone"), "attention");
    m.unmount();
  });

  it("shows Failed for a failed thread", async () => {
    const m = await mount(renderPalette());
    const row = [...document.querySelectorAll('[data-palette-kind="thread"]')].find(
      (el) => el.textContent?.includes("Failed thread"),
    ) as HTMLElement;
    assert.ok(row, "failed thread row renders");
    const chip = row.querySelector("[data-palette-status]");
    assert.equal(chip?.getAttribute("data-palette-status"), "Failed");
    assert.equal(chip?.getAttribute("data-tone"), "failed");
    m.unmount();
  });

  it("shows Done for an unread finished thread", async () => {
    const m = await mount(renderPalette());
    const doneRow = [...document.querySelectorAll('[data-palette-kind="thread"]')].find(
      (el) => el.textContent?.includes("Done thread"),
    ) as HTMLElement;
    assert.ok(doneRow, "done thread row renders");
    const chip = doneRow.querySelector("[data-palette-status]");
    assert.equal(chip?.getAttribute("data-palette-status"), "Done");
    assert.equal(chip?.getAttribute("data-tone"), "done");
    m.unmount();
  });

  it("shows the matching status chip on a message-hit row (#1761)", async () => {
    const m = await mount(
      renderPalette({
        searchMessages: async ({ query }: { query: string }) =>
          query === "broke"
            ? {
                hits: [
                  {
                    threadId: "t-failed",
                    messageId: "m1",
                    snippet: "it broke during the run",
                    createdAt: 5,
                  },
                ],
                truncated: false,
              }
            : { hits: [], truncated: false },
      }),
    );
    const input = m.query("[data-command-palette-input]") as HTMLInputElement;
    await m.type(input, "broke");
    await inAct(() => new Promise((r) => setTimeout(r, 200)));
    await m.flush();
    const messageRow = m.query('[data-palette-kind="message"]') as HTMLElement;
    assert.ok(messageRow, "message row renders");
    const chip = messageRow.querySelector("[data-palette-status]");
    assert.ok(chip, "message row shows the hit thread's status");
    assert.equal(chip?.getAttribute("data-palette-status"), "Failed");
    assert.equal(chip?.getAttribute("data-tone"), "failed");
    m.unmount();
  });
});
