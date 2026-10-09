import { useState, type RefObject } from "react";
import type { AppSettings, MergeSpotlight, ProjectInfo } from "../../shared/ipc";
import styles from "../SettingsModal.module.css";
import type { SettingsDraftKey, SettingsModalProps } from "../SettingsModal";
import { SourceControlSection } from "../SourceControlSection";
import { WorktreeGcSection } from "../WorktreeGcSection";
import { ProjectPicker } from "./shared";

export function GitPane({
  settings,
  saving,
  error,
  setError,
  prCapText,
  setPrCapText,
  linearKeyText,
  setLinearKeyText,
  dirtyDrafts,
  save,
  saveLinearKey,
  projects,
  onGcScan,
  onGcClean,
  onDiscoverSourceControl,
  onSetSpotlight,
  onSaveSettings,
  toolsProjectId,
  setToolsProjectId,
}: {
  settings: AppSettings | null;
  saving: boolean;
  error: string | null;
  setError: (error: string | null) => void;
  prCapText: string;
  setPrCapText: (text: string) => void;
  linearKeyText: string;
  setLinearKeyText: (text: string) => void;
  dirtyDrafts: RefObject<Set<SettingsDraftKey>>;
  save: () => Promise<void>;
  saveLinearKey: () => Promise<void>;
  projects: SettingsModalProps["projects"];
  onGcScan: SettingsModalProps["onGcScan"];
  onGcClean: SettingsModalProps["onGcClean"];
  onDiscoverSourceControl: SettingsModalProps["onDiscoverSourceControl"];
  onSetSpotlight: SettingsModalProps["onSetSpotlight"];
  onSaveSettings: SettingsModalProps["onSaveSettings"];
  toolsProjectId: string | null;
  setToolsProjectId: (projectId: string) => void;
}) {
  const onBlurPrCap = () => {
    const current = settings?.prDiffCapLines ?? null;
    const next = prCapText.trim() === "" ? null : Number(prCapText.trim());
    const same =
      (current == null && (prCapText.trim() === "" || next === null)) ||
      (current != null &&
        Number.isFinite(next) &&
        next === current &&
        prCapText.trim() !== "");
    if (same && error == null) return;
    void save();
  };

  return (
    <>
      <SourceControlSection
        active
        onDiscover={onDiscoverSourceControl}
      />

      <section className={styles.section}>
        <h3 className={styles.sectionLabel}>Pull requests</h3>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="pr-diff-cap">
            PR size cap (lines changed)
          </label>
          <div className={styles.fieldRow}>
            <input
              id="pr-diff-cap"
              className={styles.input}
              type="number"
              inputMode="numeric"
              min="1"
              step="1"
              placeholder="No cap"
              value={prCapText}
              disabled={saving}
              data-pr-diff-cap=""
              onChange={(e) => {
                dirtyDrafts.current.add("pr");
                setPrCapText(e.target.value);
                setError(null);
              }}
              onBlur={() => onBlurPrCap()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void save();
                }
              }}
            />
            <span className={styles.note}>lines</span>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
          <p className={styles.note}>
            PRs created from the app larger than this are refused with an
            offer to split them into stacked PRs. Small batches keep
            human review affordable. Default 400; empty means no cap.
          </p>
        </div>
        <label className={styles.fieldRow}>
          <input
            type="checkbox"
            data-strip-agent-coauthors=""
            checked={settings?.stripAgentCoauthors === true}
            disabled={saving || settings == null}
            onChange={(e) => {
              setError(null);
              void onSaveSettings({
                stripAgentCoauthors: e.target.checked,
              }).catch((err) => {
                setError(
                  err instanceof Error && err.message
                    ? err.message
                    : "Failed to save settings",
                );
              });
            }}
          />
          <span>Strip agent Co-authored-by lines from squash merges</span>
        </label>
        <p className={styles.note}>
          Squash merges from the app drop trailers that credit an AI agent
          (Claude, Codex, Cursor, bots). Human co-authors are kept.
        </p>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionLabel}>Linear</h3>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="linear-api-key">
            API key
          </label>
          <div className={styles.fieldRow}>
            <input
              id="linear-api-key"
              className={styles.input}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="lin_api_…"
              value={linearKeyText}
              disabled={saving}
              data-linear-api-key=""
              onChange={(e) => {
                dirtyDrafts.current.add("linear");
                setLinearKeyText(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void saveLinearKey();
                }
              }}
            />
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              disabled={saving}
              data-linear-api-key-save=""
              onClick={() => void saveLinearKey()}
            >
              {saving ? "Saving…" : "Save key"}
            </button>
          </div>
          <p className={styles.note}>
            Used to start threads from Linear issues. LINEAR_API_KEY in
            the environment also works. Empty and Save key clears a
            stored key.
          </p>
        </div>
      </section>

      <WorktreeGcSection
        active
        projects={projects}
        onGcScan={onGcScan}
        onGcClean={onGcClean}
      />

      {onSetSpotlight && projects && (
        <SpotlightSection
          projects={projects}
          value={toolsProjectId}
          onPick={setToolsProjectId}
          onSetSpotlight={onSetSpotlight}
        />
      )}
    </>
  );
}

/**
 * Per-project Spotlight opt-in (moved from the Environment Lanes card).
 * Lanes are local-only, so remote projects are not offered.
 */
function SpotlightSection({
  projects,
  value,
  onPick,
  onSetSpotlight,
}: {
  projects: ProjectInfo[];
  value: string | null;
  onPick: (projectId: string) => void;
  onSetSpotlight: (input: {
    projectId: string;
    enabled: boolean;
  }) => Promise<MergeSpotlight>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Shown until useCoder's projects.list refresh brings the saved flag back.
  const [saved, setSaved] = useState<{
    projectId: string;
    enabled: boolean;
  } | null>(null);
  const local = projects.filter((p) => !p.remoteHost);
  const project = local.find((p) => p.id === value) ?? local[0] ?? null;
  if (!project) return null;
  const checked =
    saved?.projectId === project.id ? saved.enabled : project.spotlight === true;
  return (
    <section className={styles.section} data-spotlight-settings="">
      <h3 className={styles.sectionLabel}>Spotlight</h3>
      <ProjectPicker
        id="spotlight-project"
        projects={local}
        value={project.id}
        onChange={onPick}
      />
      <label className={styles.fieldRow}>
        <input
          type="checkbox"
          data-lane-spotlight=""
          checked={checked}
          disabled={busy}
          onChange={(e) => {
            const enabled = e.target.checked;
            const projectId = project.id;
            setBusy(true);
            setError(null);
            void onSetSpotlight({ projectId, enabled })
              .then(() => setSaved({ projectId, enabled }))
              .catch((err) =>
                setError(
                  err instanceof Error && err.message
                    ? err.message
                    : "Failed to save Spotlight",
                ),
              )
              .finally(() => setBusy(false));
          }}
        />
        <span>Preview lanes on the project checkout</span>
      </label>
      <p className={styles.note}>
        When on, Preview on the Environment Lanes section hot-swaps the
        claimed lane onto this project&apos;s checkout, so one running app
        serves whichever lane you pick.
      </p>
      {error ? (
        <p className={styles.fieldError} role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
