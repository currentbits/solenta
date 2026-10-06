import { useMemo, useState } from "react";
import {
  bindingLabel,
  effectiveChords,
  findConflicts,
  formatChord,
  KEYBINDINGS,
  keybindingDef,
  parseOverrides,
} from "../../keybindings";
import { setKeybindingOverrides, useKeybindingOverrides } from "../../uiPrefs";
import styles from "../SettingsModal.module.css";

function toJson(overrides: Readonly<Record<string, string>>): string {
  return Object.keys(overrides).length
    ? JSON.stringify(overrides, null, 2)
    : "{}";
}

/** Settings › Keyboard (#1506): a JSON override over the default table. */
export function KeyboardPane() {
  const saved = useKeybindingOverrides();
  const [draft, setDraft] = useState(() => toJson(saved));
  const [applied, setApplied] = useState(false);
  const parsed = useMemo(() => parseOverrides(draft), [draft]);
  const conflicts = useMemo(
    () => findConflicts(effectiveChords(parsed.overrides)),
    [parsed],
  );
  const dirty = draft.trim() !== toJson(saved);

  const apply = () => {
    setKeybindingOverrides(parsed.overrides);
    setDraft(toJson(parsed.overrides));
    setApplied(true);
  };
  const reset = () => {
    setKeybindingOverrides({});
    setDraft("{}");
    setApplied(true);
  };

  return (
    <section className={styles.section} data-keyboard-pane="">
      <h3 className={styles.sectionLabel}>Custom shortcuts</h3>
      <p className={styles.note}>
        Map a shortcut id to a chord, e.g.{" "}
        <code>{'{"palette.command": "mod+e"}'}</code>. <code>mod</code> is{" "}
        {formatChord("mod")} here; <code>ctrl</code>, <code>meta</code>,{" "}
        <code>alt</code> and <code>shift</code> are literal.
      </p>
      <textarea
        className={`${styles.textarea} ${styles.keyboardJson}`}
        data-keybindings-json=""
        aria-label="Shortcut overrides (JSON)"
        spellCheck={false}
        rows={6}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setApplied(false);
        }}
      />
      {parsed.errors.map((err) => (
        <p key={err} className={styles.fieldError} data-keybindings-error="">
          {err}
        </p>
      ))}
      {conflicts.map((ids) => (
        <p key={ids.join()} className={styles.fieldError} data-keybindings-conflict="">
          {ids.map((id) => keybindingDef(id)?.label ?? id).join(" and ")} share{" "}
          {formatChord(effectiveChords(parsed.overrides).get(ids[0]!) ?? "")}.
          Pick a different chord for one of them.
        </p>
      ))}
      <div className={styles.fieldRow}>
        <button
          type="button"
          className={styles.btnPrimary}
          data-keybindings-apply=""
          disabled={!dirty}
          onClick={apply}
        >
          Apply
        </button>
        <button
          type="button"
          className={styles.btn}
          data-keybindings-reset=""
          disabled={Object.keys(saved).length === 0 && draft.trim() === "{}"}
          onClick={reset}
        >
          Reset to defaults
        </button>
        {applied && !dirty && <span className={styles.note}>Saved</span>}
      </div>
      <h3 className={styles.sectionLabel}>Shortcuts</h3>
      <ul className={styles.keyboardList} data-keybindings-list="">
        {KEYBINDINGS.map((def) => (
          <li
            key={def.id}
            className={styles.keyboardRow}
            data-keybinding={def.id}
            data-custom={saved[def.id] ? "" : undefined}
          >
            <span>{def.label}</span>
            <code className={styles.keyboardId}>{def.chord ? def.id : "fixed"}</code>
            <kbd className={styles.keyboardKeys}>{bindingLabel(def.id)}</kbd>
          </li>
        ))}
      </ul>
    </section>
  );
}
