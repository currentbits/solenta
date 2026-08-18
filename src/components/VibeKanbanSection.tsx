import { useCallback, useEffect, useState } from "react";
import { resolveCoderApi } from "../coderApi";
import type {
  CoderApi,
  VibeKanbanImportResult,
  VibeKanbanPreview,
} from "../shared/ipc";
import styles from "./SettingsModal.module.css";

export interface VibeKanbanSectionProps {
  /** Settings remounts this on each open. */
  active: boolean;
}

function resolveApi(): CoderApi | null {
  try {
    const existing = (window as unknown as { coder?: CoderApi }).coder;
    if (existing && typeof existing.vibeKanban?.preview === "function") {
      return existing;
    }
    const api = resolveCoderApi();
    return typeof api.vibeKanban?.preview === "function" ? api : null;
  } catch {
    return null;
  }
}

function previewLabel(p: VibeKanbanPreview): string {
  const cards = p.taskCount === 1 ? "1 card" : `${p.taskCount} cards`;
  const trees =
    p.worktreeCount === 1 ? "1 worktree" : `${p.worktreeCount} worktrees`;
  const extra =
    p.alreadyImported > 0 ? ` · ${p.alreadyImported} already imported` : "";
  return `${p.projects.length} project${p.projects.length === 1 ? "" : "s"} · ${cards} · ${trees}${extra}`;
}

function resultLabel(r: VibeKanbanImportResult): string {
  const parts = [
    `${r.threadsCreated} thread${r.threadsCreated === 1 ? "" : "s"}`,
    `${r.projectsAdded} project${r.projectsAdded === 1 ? "" : "s"} added`,
  ];
  if (r.projectsReused) parts.push(`${r.projectsReused} reused`);
  if (r.threadsSkipped) parts.push(`${r.threadsSkipped} skipped`);
  if (r.worktreesMapped) {
    parts.push(
      `${r.worktreesMapped} worktree${r.worktreesMapped === 1 ? "" : "s"} mapped`,
    );
  }
  return parts.join(" · ");
}

export function VibeKanbanSection({ active }: VibeKanbanSectionProps) {
  const [preview, setPreview] = useState<VibeKanbanPreview | null>(null);
  const [dataDir, setDataDir] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<"preview" | "import" | "export" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<Array<{ title: string; reason: string }>>(
    [],
  );

  const loadPreview = useCallback(async (dir?: string) => {
    const api = resolveApi();
    if (!api) {
      setPreview(null);
      return;
    }
    setBusy("preview");
    setError(null);
    try {
      const next = await api.vibeKanban.preview(dir ? { dataDir: dir } : {});
      setPreview(next);
      if (dir) setDataDir(dir);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void loadPreview(dataDir);
  }, [active, dataDir, loadPreview]);

  const chooseFolder = async () => {
    const api = resolveApi();
    if (!api) return;
    setError(null);
    try {
      const picked = await api.vibeKanban.pickDataDir();
      if (picked) {
        setDataDir(picked);
        await loadPreview(picked);
      }
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : String(err));
    }
  };

  const runImport = async () => {
    const api = resolveApi();
    if (!api) return;
    setBusy("import");
    setError(null);
    setReport(null);
    setSkipped([]);
    try {
      const result = await api.vibeKanban.import(
        dataDir ? { dataDir } : {},
      );
      setReport(resultLabel(result));
      setSkipped(result.skipped);
      await loadPreview(dataDir);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const runExport = async () => {
    const api = resolveApi();
    if (!api) return;
    setBusy("export");
    setError(null);
    try {
      const dest = await api.vibeKanban.export();
      if (dest) setReport(`Exported to ${dest}`);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className={styles.section} data-vibe-kanban="">
      <h3 className={styles.sectionLabel}>Your data</h3>
      <p className={styles.note}>
        Import a local Vibe Kanban database (cards become threads, worktrees
        are mapped when they still exist). Export writes a JSON dump of
        projects, threads, and messages — nothing is locked in.
      </p>
      {preview?.found ? (
        <p className={styles.note} data-vk-preview="">
          Found {previewLabel(preview)}
          {preview.dataDir ? (
            <>
              {" "}
              in <span className={styles.monoNote}>{preview.dataDir}</span>
            </>
          ) : null}
        </p>
      ) : (
        <p className={styles.note} data-vk-missing="">
          No Vibe Kanban data folder found. Choose the folder that contains
          {" "}
          <span className={styles.monoNote}>db.v2.sqlite</span>
          {" "}
          (or <span className={styles.monoNote}>db.sqlite</span>).
        </p>
      )}
      {preview?.projects.map((p) => (
        <div key={`${p.name}:${p.path ?? ""}`} className={styles.memoryRow}>
          <div className={styles.profileMeta}>
            <div className={styles.profileName}>{p.name}</div>
            <p className={styles.note}>
              {p.exists ? p.path : "path missing"}
              {" · "}
              {p.taskCount} {p.taskCount === 1 ? "card" : "cards"}
            </p>
          </div>
        </div>
      ))}
      {error && (
        <p className={styles.fieldError} role="alert">
          {error}
        </p>
      )}
      {report && (
        <p className={styles.note} data-vk-report="">
          {report}
        </p>
      )}
      {skipped.length > 0 && (
        <ul className={styles.gcFailed} data-vk-skipped="">
          {skipped.map((s) => (
            <li key={`${s.title}:${s.reason}`} className={styles.fieldError}>
              {s.title}: {s.reason}
            </li>
          ))}
        </ul>
      )}
      <div className={styles.fieldRow}>
        <button
          type="button"
          className={styles.btnPrimary}
          data-vk-import=""
          disabled={busy != null || !preview?.found}
          onClick={() => void runImport()}
        >
          {busy === "import" ? "Importing…" : "Import Vibe Kanban"}
        </button>
        <button
          type="button"
          className={styles.btn}
          data-vk-choose=""
          disabled={busy != null}
          onClick={() => void chooseFolder()}
        >
          Choose folder
        </button>
        <button
          type="button"
          className={styles.btn}
          data-vk-export=""
          disabled={busy != null}
          onClick={() => void runExport()}
        >
          {busy === "export" ? "Exporting…" : "Export JSON"}
        </button>
      </div>
    </section>
  );
}
