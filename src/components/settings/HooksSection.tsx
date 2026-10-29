import { useCallback, useEffect, useState } from "react";
import { resolveCoderApi } from "../../coderApi";
import type {
  CoderApi,
  ProjectInfo,
  UserHookRow,
  UserHookRunResult,
  UserHookSource,
  UserHooksList,
} from "../../shared/ipc";
import styles from "../SettingsModal.module.css";
import { ProjectPicker } from "./shared";

function hooksApi(): CoderApi["hooks"] | null {
  try {
    const api = resolveCoderApi();
    return typeof api.hooks?.list === "function" ? api.hooks : null;
  } catch {
    return null;
  }
}

function errText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

function runSummary(r: UserHookRunResult): string {
  const outcome = r.timedOut
    ? "timed out"
    : r.exitCode === 0
      ? "exit 0"
      : r.exitCode === 2
        ? "exit 2 (blocked)"
        : r.exitCode == null
          ? r.error || "failed to start"
          : `exit ${r.exitCode} (warning)`;
  return `${outcome} · ${r.durationMs} ms · ${new Date(r.at).toLocaleString()}`;
}

/**
 * User lifecycle hooks (#1724): user-level and project `.solenta/hooks.json`,
 * project trust with Approve, last run per hook, and Test.
 */
export function HooksSection({
  projects,
  currentProjectId,
}: {
  projects: ProjectInfo[];
  currentProjectId: string | null;
}) {
  const local = projects.filter((p) => !p.remoteHost);
  const [projectId, setProjectId] = useState<string>(
    local.find((p) => p.id === currentProjectId)?.id ?? local[0]?.id ?? "",
  );
  const [list, setList] = useState<UserHooksList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const api = hooksApi();
    if (!api) return;
    try {
      setList(await api.list({ projectId: projectId || null }));
    } catch (err) {
      setError(errText(err));
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const approve = async (hash: string) => {
    const api = hooksApi();
    if (!api || !projectId) return;
    setBusy("approve");
    setError(null);
    try {
      await api.approve({ projectId, hash });
      await refresh();
    } catch (err) {
      setError(errText(err));
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const test = async (id: string) => {
    const api = hooksApi();
    if (!api) return;
    setBusy(id);
    setError(null);
    try {
      await api.test({ projectId: projectId || null, id });
      await refresh();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  };

  const native = list?.nativePreToolUse ?? [];

  const row = (h: UserHookRow) => (
    <div key={h.id} className={styles.memoryRow} data-hook-row={h.id}>
      <span className={styles.monoNote}>
        {h.event}
        {h.matcher ? ` [${h.matcher}]` : ""} · {h.command.join(" ")} ·{" "}
        {h.timeoutMs / 1000}s
      </span>
      {h.scripts && h.scripts.length > 0 && (
        <span className={styles.note} data-hook-scripts={h.id}>
          Runs from the project checkout:{" "}
          {h.scripts.map((s, i) => (
            <span key={s.path} className={styles.monoNote}>
              {i > 0 && ", "}
              {s.path} ({s.sha256.slice(0, 8)})
            </span>
          ))}
        </span>
      )}
      {h.event === "PreToolUse" && (
        <span className={styles.note} data-hook-best-effort="">
          Blocks before the tool on {native.join(" and ")}; best effort on
          other providers (reported after the tool starts).
        </span>
      )}
      {h.lastRun ? (
        <span className={styles.note} data-hook-last-run={h.id}>
          Last run: {runSummary(h.lastRun)}
          {h.lastRun.output && (
            <pre className={styles.monoNote}>{h.lastRun.output}</pre>
          )}
        </span>
      ) : (
        <span className={styles.note}>Not run yet.</span>
      )}
      <div className={styles.fieldRow}>
        <button
          type="button"
          className={styles.btn}
          data-hook-test={h.id}
          disabled={busy != null}
          onClick={() => void test(h.id)}
        >
          {busy === h.id ? "Testing…" : "Test"}
        </button>
      </div>
    </div>
  );

  const source = (label: string, src: UserHookSource) => (
    <div className={styles.field} data-hook-source={label}>
      <p className={styles.fieldLabel}>{label}</p>
      <p className={styles.monoNote}>{src.path}</p>
      {!src.exists && <p className={styles.note}>No file.</p>}
      {src.error && (
        <p className={styles.note} role="alert" data-hook-error={label}>
          Invalid, so none of its hooks run: {src.error}
        </p>
      )}
      {src.hooks.map(row)}
    </div>
  );

  const project = list?.project ?? null;

  return (
    <section className={styles.section} data-hooks-settings="">
      <h3 className={styles.sectionLabel}>Hooks</h3>
      <p className={styles.note}>
        Your own commands on PreToolUse, PostToolUse, UserPromptSubmit and
        Stop, for every provider. They get a JSON payload on stdin. Exit 0
        continues, exit 2 blocks with stderr as the reason, anything else is a
        warning. They run after Solenta&apos;s guardrails and can only add a
        block. Project hooks in .solenta/hooks.json come from the repo and run
        only after you approve the file; any change needs a new approval.
        Approval also covers repo scripts a hook runs; they run from the
        project checkout, not the thread&apos;s worktree. It does not cover
        files those scripts load in turn, scripts named inside inline code
        (bash -c), or package.json scripts run through npm or npx.
      </p>
      {local.length > 0 && (
        <ProjectPicker
          id="hooks-project"
          projects={local}
          value={projectId}
          onChange={setProjectId}
        />
      )}
      {error && (
        <p className={styles.note} role="alert" data-hooks-error="">
          {error}
        </p>
      )}
      {list && source("User hooks", list.user)}
      {project && (
        <>
          {source("Project hooks", project)}
          {project.exists && !project.error && (
            <div className={styles.fieldRow} data-hook-trust={project.trusted ? "trusted" : "untrusted"}>
              {project.trusted ? (
                <span className={styles.note}>Approved. These hooks run.</span>
              ) : (
                <>
                  <span className={styles.note}>
                    Not approved: these hooks do not run. Review the commands
                    above, and any repo scripts they call, first.
                  </span>
                  <button
                    type="button"
                    className={styles.btn}
                    data-hook-approve=""
                    disabled={busy != null || !project.hash}
                    onClick={() => project.hash && void approve(project.hash)}
                  >
                    Approve
                  </button>
                </>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
