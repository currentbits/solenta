import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEscapeClose } from "../useEscapeClose";
import { useModalFocus } from "../useModalFocus";
import type { GitPublishInput, SourceControlDiscovery } from "../shared/ipc";
import { addProjectRemoteSourceLabel, forgeReadiness } from "../sourceControl";
import styles from "./CreatePrDialog.module.css";

type Forge = GitPublishInput["forge"];
const FORGES: readonly Forge[] = ["github", "gitlab", "bitbucket", "azure-devops"];

export interface PublishDialogProps {
  /** Default repo name (the checkout's folder). */
  initialName: string;
  /** Settings → Source Control probe; only ready forges are offered. */
  discovery: SourceControlDiscovery | null;
  pending: boolean;
  error?: string | null;
  onSubmit: (input: Omit<GitPublishInput, "threadId">) => void;
  onClose: () => void;
}

/** Publish a checkout with no origin to a forge (#456). */
export function PublishDialog({
  initialName,
  discovery,
  pending,
  error,
  onSubmit,
  onClose,
}: PublishDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const ready = FORGES.filter((f) => forgeReadiness(discovery, f).ready);
  const [forge, setForge] = useState<Forge | null>(ready[0] ?? null);
  const [name, setName] = useState(initialName);
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [workspace, setWorkspace] = useState("");
  const [org, setOrg] = useState("");
  const [project, setProject] = useState("");
  const close = useCallback(() => {
    if (!pending) onClose();
  }, [pending, onClose]);
  useEscapeClose(!pending, close);
  useModalFocus(true, dialogRef);

  const canSubmit =
    !pending &&
    forge != null &&
    name.trim() !== "" &&
    (forge !== "bitbucket" || workspace.trim() !== "") &&
    (forge !== "azure-devops" || (org.trim() !== "" && project.trim() !== ""));

  const submit = () => {
    if (!canSubmit || !forge) return;
    onSubmit({
      forge,
      name: name.trim(),
      visibility,
      ...(forge === "bitbucket" ? { workspace: workspace.trim() } : {}),
      ...(forge === "azure-devops" ? { org: org.trim(), project: project.trim() } : {}),
    });
  };

  const text = (
    label: string,
    value: string,
    set: (v: string) => void,
    attr: string,
    placeholder?: string,
  ) => (
    <label className={styles.field}>
      <span className={styles.label}>{label}</span>
      <input
        className={styles.input}
        {...{ [attr]: "" }}
        value={value}
        placeholder={placeholder}
        onChange={(event) => set(event.target.value)}
        disabled={pending}
        autoComplete="off"
      />
    </label>
  );

  const node = (
    <div className={styles.backdrop} role="presentation" onClick={close} data-publish-dialog="">
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="publish-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className={styles.header}>
          <h2 id="publish-title" className={styles.heading}>
            Publish repository
          </h2>
          <button type="button" className={styles.close} aria-label="Cancel" disabled={pending} onClick={close}>
            ×
          </button>
        </header>
        <div className={styles.body}>
          {forge == null ? (
            <p className={styles.error} data-publish-no-forge="">
              No forge is signed in. Open Settings → Source Control to set up GitHub, GitLab, Bitbucket or Azure DevOps.
            </p>
          ) : (
            <>
              <label className={styles.field}>
                <span className={styles.label}>Forge</span>
                <select
                  className={styles.select}
                  data-publish-forge=""
                  value={forge}
                  disabled={pending}
                  onChange={(event) => setForge(event.target.value as Forge)}
                >
                  {ready.map((f) => (
                    <option key={f} value={f}>
                      {addProjectRemoteSourceLabel(f)}
                    </option>
                  ))}
                </select>
              </label>
              {forge === "bitbucket" ? text("Workspace", workspace, setWorkspace, "data-publish-workspace") : null}
              {forge === "azure-devops"
                ? text("Organization", org, setOrg, "data-publish-org", "my-org or https://dev.azure.com/my-org")
                : null}
              {forge === "azure-devops" ? text("Project", project, setProject, "data-publish-project") : null}
              {text(
                "Repository name",
                name,
                setName,
                "data-publish-name",
                forge === "github" || forge === "gitlab" ? "name or owner/name" : undefined,
              )}
              {forge !== "azure-devops" ? (
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    data-publish-public=""
                    checked={visibility === "public"}
                    disabled={pending}
                    onChange={(event) => setVisibility(event.target.checked ? "public" : "private")}
                  />
                  Public repository
                </label>
              ) : null}
            </>
          )}
          {error ? (
            <p className={styles.error} data-publish-error="">
              {error}
            </p>
          ) : null}
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.primary}
            data-publish-submit=""
            disabled={!canSubmit}
            aria-busy={pending || undefined}
            onClick={submit}
          >
            {pending ? "Publishing…" : "Publish"}
          </button>
          <button type="button" className={styles.secondary} disabled={pending} onClick={close}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );

  // Portal out of the thread header, same as CreatePrDialog.
  return createPortal(node, document.body);
}
