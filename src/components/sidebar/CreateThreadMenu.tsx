import type { Dispatch, SetStateAction } from "react";
import type { CliImportProvider } from "../ImportCliSessionModal";
import type { SidebarProps } from "../Sidebar";
import styles from "../Sidebar.module.css";

type BasePicker = { defaultBranch: string; branches: string[] };

/**
 * New-thread caret menu: worktree / stacked-base / orchestrator / plain /
 * teach / ask threads, From issue, and the CLI session imports.
 */
export function CreateThreadMenu({
  remoteTarget,
  createProjectId,
  setCreateMenuOpen,
  setBasePicker,
  onCreateThread,
  listBaseBranches,
  basePicker,
  onCreateThreadFromIssue,
  openIssueForm,
  listCliSessions,
  importCliSession,
  setImportCliProvider,
}: {
  remoteTarget: boolean;
  createProjectId: string | undefined;
  setCreateMenuOpen: Dispatch<SetStateAction<boolean>>;
  setBasePicker: Dispatch<SetStateAction<BasePicker | null>>;
  onCreateThread: SidebarProps["onCreateThread"];
  listBaseBranches: SidebarProps["listBaseBranches"];
  basePicker: BasePicker | null;
  onCreateThreadFromIssue: SidebarProps["onCreateThreadFromIssue"];
  openIssueForm: (projectId: string) => void;
  listCliSessions: SidebarProps["listCliSessions"];
  importCliSession: SidebarProps["importCliSession"];
  setImportCliProvider: Dispatch<SetStateAction<CliImportProvider | null>>;
}) {
  return (
    <div
      className={styles.menu}
      role="menu"
      data-new-thread-menu=""
    >
      {!remoteTarget && (
        <>
          <button
            type="button"
            className={styles.menuItem}
            role="menuitem"
            data-create-worktree-thread={createProjectId}
            title="New thread in an isolated git worktree + branch"
            onClick={() => {
              setCreateMenuOpen(false);
              setBasePicker(null);
              onCreateThread(createProjectId, { worktree: true });
            }}
          >
            New worktree thread
          </button>
          {listBaseBranches && createProjectId && (
            <>
              <button
                type="button"
                className={styles.menuItem}
                role="menuitem"
                data-create-base-branch=""
                title="New worktree thread stacked on a branch other than the repo default"
                onClick={() => {
                  const pid = createProjectId;
                  void listBaseBranches(pid).then((listed) => {
                    setBasePicker(listed);
                  });
                }}
              >
                On another base…
              </button>
              {basePicker &&
                basePicker.branches
                  .filter((name) => name !== basePicker.defaultBranch)
                  .map((name) => (
                    <button
                      key={name}
                      type="button"
                      className={`${styles.menuItem} ${styles.menuItemNested}`}
                      role="menuitem"
                      data-base-branch={name}
                      title={`Stack this thread on ${name}`}
                      onClick={() => {
                        setCreateMenuOpen(false);
                        setBasePicker(null);
                        onCreateThread(createProjectId, {
                          worktree: true,
                          baseBranch: name,
                        });
                      }}
                    >
                      {name}
                    </button>
                  ))}
            </>
          )}
          <button
            type="button"
            className={styles.menuItem}
            role="menuitem"
            data-create-orchestrator-thread={createProjectId}
            title="New thread that hands its first prompt to a worker in its own worktree"
            onClick={() => {
              setCreateMenuOpen(false);
              onCreateThread(createProjectId, { orchestrate: true });
            }}
          >
            New orchestrator thread
          </button>
        </>
      )}
      <button
        type="button"
        className={styles.menuItem}
        role="menuitem"
        data-create-plain-thread={createProjectId}
        title="New thread directly in the project checkout (no worktree)"
        onClick={() => {
          setCreateMenuOpen(false);
          onCreateThread(createProjectId, { worktree: false });
        }}
      >
        New plain thread
      </button>
      {!remoteTarget && (
        <button
          type="button"
          className={styles.menuItem}
          role="menuitem"
          data-create-teach-thread={createProjectId}
          title="New thread that teaches: hints, TODO(human) markers, reviews your code"
          onClick={() => {
            setCreateMenuOpen(false);
            onCreateThread(createProjectId, {
              worktree: true,
              teach: true,
            });
          }}
        >
          New teach thread
        </button>
      )}
      <button
        type="button"
        className={styles.menuItem}
        role="menuitem"
        data-create-ask-thread={createProjectId}
        title="New read-only Ask thread: repo Q&A from the index and memory, no worktree"
        onClick={() => {
          setCreateMenuOpen(false);
          onCreateThread(createProjectId, { ask: true });
        }}
      >
        New ask thread
      </button>
      {onCreateThreadFromIssue && createProjectId && (
        <button
          type="button"
          className={styles.menuItem}
          role="menuitem"
          data-create-from-issue={createProjectId}
          title="New thread from a GitHub or Linear issue"
          onClick={() => openIssueForm(createProjectId)}
        >
          From issue
        </button>
      )}
      {listCliSessions && importCliSession && createProjectId && (
        <>
          <button
            type="button"
            className={styles.menuItem}
            role="menuitem"
            data-import-cli-session={createProjectId}
            title="Import a Codex CLI session from disk"
            onClick={() => {
              setCreateMenuOpen(false);
              setImportCliProvider("codex");
            }}
          >
            Import Codex session…
          </button>
          <button
            type="button"
            className={styles.menuItem}
            role="menuitem"
            data-import-grok-session={createProjectId}
            title="Import a Grok CLI session from disk"
            onClick={() => {
              setCreateMenuOpen(false);
              setImportCliProvider("grok");
            }}
          >
            Import Grok session…
          </button>
          <button
            type="button"
            className={styles.menuItem}
            role="menuitem"
            data-import-claude-session={createProjectId}
            title="Import a Claude Code session from disk"
            onClick={() => {
              setCreateMenuOpen(false);
              setImportCliProvider("claude");
            }}
          >
            Import Claude session…
          </button>
          <button
            type="button"
            className={styles.menuItem}
            role="menuitem"
            data-import-cursor-session={createProjectId}
            title="Import a Cursor CLI session from disk"
            onClick={() => {
              setCreateMenuOpen(false);
              setImportCliProvider("cursor");
            }}
          >
            Import Cursor session…
          </button>
          <button
            type="button"
            className={styles.menuItem}
            role="menuitem"
            data-import-opencode-session={createProjectId}
            title="Import an OpenCode CLI session from disk"
            onClick={() => {
              setCreateMenuOpen(false);
              setImportCliProvider("opencode");
            }}
          >
            Import OpenCode session…
          </button>
          <button
            type="button"
            className={styles.menuItem}
            role="menuitem"
            data-import-kimi-session={createProjectId}
            title="Import a Kimi CLI session from disk"
            onClick={() => {
              setCreateMenuOpen(false);
              setImportCliProvider("kimi");
            }}
          >
            Import Kimi session…
          </button>
          <button
            type="button"
            className={styles.menuItem}
            role="menuitem"
            data-import-muse-session={createProjectId}
            title="Import a Muse CLI session from disk"
            onClick={() => {
              setCreateMenuOpen(false);
              setImportCliProvider("muse");
            }}
          >
            Import Muse session…
          </button>
        </>
      )}
    </div>
  );
}
