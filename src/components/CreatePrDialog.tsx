import { useCallback, useEffect, useRef, useState } from "react";
import { canSubmitPr } from "../prUi";
import { useEscapeClose } from "../useEscapeClose";
import { useModalFocus } from "../useModalFocus";
import type { PrTemplateFile, PrTemplateResult } from "../shared/ipc";
import { Markdown } from "./Markdown";
import styles from "./CreatePrDialog.module.css";

export interface CreatePrDialogProps {
  initialTitle: string;
  loadTemplate?: () => Promise<PrTemplateResult>;
  pending: boolean;
  error?: string | null;
  onSubmit: (input: { title: string; body: string; draft: boolean }) => void;
  onClose: () => void;
}

export function CreatePrDialog({
  initialTitle,
  loadTemplate,
  pending,
  error,
  onSubmit,
  onClose,
}: CreatePrDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [preview, setPreview] = useState(false);
  const [templates, setTemplates] = useState<PrTemplateFile[]>([]);
  const [templatePath, setTemplatePath] = useState<string | null>(null);
  const close = useCallback(() => {
    if (pending) return;
    onClose();
  }, [pending, onClose]);
  useEscapeClose(!pending, close);
  useModalFocus(true, dialogRef);

  useEffect(() => {
    if (!loadTemplate) return;
    let live = true;
    void loadTemplate().then((result) => {
      if (!live || !result.ok) return;
      setTemplates(result.templates);
      setTemplatePath(result.path);
      setBody((current) => (current.trim() ? current : result.body));
    });
    return () => {
      live = false;
    };
    // Load once when the composer opens. Parent identity changes must not
    // refill a body the user already started editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canSubmit = canSubmitPr(title) && !pending;

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onClick={close}
      data-create-pr-dialog=""
    >
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-pr-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className={styles.header}>
          <h2 id="create-pr-title" className={styles.heading}>
            Create pull request
          </h2>
          <button
            type="button"
            className={styles.close}
            aria-label="Cancel"
            disabled={pending}
            onClick={close}
          >
            ×
          </button>
        </header>
        <div className={styles.body}>
          <label className={styles.field}>
            <span className={styles.label}>Title</span>
            <input
              className={styles.input}
              data-create-pr-title=""
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              disabled={pending}
              autoComplete="off"
            />
          </label>
          {templates.length > 1 ? (
            <label className={styles.field}>
              <span className={styles.label}>Template</span>
              <select
                className={styles.select}
                data-create-pr-template=""
                value={templatePath ?? ""}
                disabled={pending}
                onChange={(event) => {
                  const next = templates.find((row) => row.path === event.target.value);
                  setTemplatePath(next?.path ?? null);
                  if (next) setBody(next.body);
                }}
              >
                {templates.map((row) => (
                  <option key={row.path} value={row.path}>
                    {row.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className={styles.field}>
            <span className={styles.labelRow}>
              <span className={styles.label}>Body</span>
              <button
                type="button"
                className={styles.previewToggle}
                data-create-pr-preview=""
                aria-pressed={preview}
                onClick={() => setPreview((v) => !v)}
              >
                {preview ? "Edit" : "Preview"}
              </button>
            </span>
            {preview ? (
              <div className={styles.preview} data-create-pr-preview-body="">
                {body.trim() ? (
                  <Markdown text={body} />
                ) : (
                  <p className={styles.previewEmpty}>Nothing to preview</p>
                )}
              </div>
            ) : (
              <textarea
                className={styles.textarea}
                data-create-pr-body=""
                value={body}
                onChange={(event) => setBody(event.target.value)}
                disabled={pending}
                rows={10}
              />
            )}
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              data-create-pr-draft=""
              checked={draft}
              disabled={pending}
              onChange={(event) => setDraft(event.target.checked)}
            />
            Create as draft
          </label>
          {error ? (
            <p className={styles.error} data-create-pr-error="">
              {error}
            </p>
          ) : null}
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.primary}
            data-create-pr-submit=""
            disabled={!canSubmit}
            aria-busy={pending || undefined}
            onClick={() => {
              if (!canSubmit) return;
              onSubmit({ title: title.trim(), body, draft });
            }}
          >
            {pending ? "Creating…" : draft ? "Create draft" : "Create PR"}
          </button>
          <button
            type="button"
            className={styles.secondary}
            data-create-pr-cancel=""
            disabled={pending}
            onClick={close}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
