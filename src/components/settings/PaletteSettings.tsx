import { useEffect, useRef, useState } from "react";
import {
  applyPalette, BUILTIN_PALETTES, exportPalette, PALETTE_FILE_LIMIT,
  PALETTE_LIBRARY_LIMIT, PALETTE_STORAGE_KEY, parsePalette, readPaletteLibrary,
  savePaletteLibrary, selectedPalette,
} from "../../palettes";
import { errorMessage } from "../../coder/errorMessage";
import styles from "../SettingsModal.module.css";

export function PaletteSettings() {
  const [saved, setSaved] = useState(readPaletteLibrary);
  const [draft, setDraft] = useState(saved);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const dirty = draft !== saved;
  const palette = selectedPalette(draft);

  useEffect(() => { applyPalette(draft); }, [draft]);
  useEffect(() => {
    const changed = (e: StorageEvent) => {
      if (e.key !== PALETTE_STORAGE_KEY && e.key !== null) return;
      request.current++;
      const next = readPaletteLibrary();
      setSaved(next);
      setDraft(next);
      setError(null);
    };
    window.addEventListener("storage", changed);
    return () => {
      request.current++;
      window.removeEventListener("storage", changed);
      applyPalette(readPaletteLibrary());
    };
  }, []);

  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor="theme-palette">Color palette</label>
      <select id="theme-palette" className={styles.input} value={draft.selected}
        aria-describedby="theme-palette-note" onChange={(e) => {
          request.current++;
          setError(null);
          setDraft({ ...draft, selected: e.target.value });
        }}>
        <optgroup label="Built-in">
          {BUILTIN_PALETTES.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </optgroup>
        {draft.custom.length > 0 && <optgroup label="Imported">
          {draft.custom.map((p) => <option key={p.id} value={`custom:${p.id}`}>{p.name}</option>)}
        </optgroup>}
      </select>
      <p id="theme-palette-note" className={styles.note}>
        Preview colors in light and dark. Apply to save on this device.
        Increased contrast uses the Solenta palette.
      </p>
      <div className={styles.paletteActions}>
        {dirty && <>
          <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => {
            try {
              savePaletteLibrary(draft);
              setSaved(draft);
              setError(null);
            } catch (err) { setError(errorMessage(err)); }
          }}>Apply palette</button>
          <button type="button" className={styles.btn} onClick={() => {
            request.current++;
            setDraft(saved);
            setError(null);
          }}>Cancel preview</button>
        </>}
        <button type="button" className={styles.btn} onClick={() => fileInput.current?.click()}>Import JSON</button>
        <a className={styles.btn} download={`${palette.id}.json`}
          href={`data:application/json;charset=utf-8,${encodeURIComponent(exportPalette(palette))}`}>Export JSON</a>
        {draft.selected.startsWith("custom:") && <button type="button" className={styles.btn} onClick={() => {
          request.current++;
          setDraft({ ...draft, selected: "solenta", custom: draft.custom.filter((p) => p.id !== palette.id) });
          setError(null);
        }}>Remove palette</button>}
      </div>
      <input ref={fileInput} type="file" accept=".json,application/json" hidden aria-label="Import palette JSON"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          const current = ++request.current;
          setError(null);
          try {
            if (file.size > PALETTE_FILE_LIMIT) throw new Error("Palette JSON must be 16 KB or smaller.");
            const imported = parsePalette(await file.text());
            if (current !== request.current) return;
            const custom = draft.custom.filter((p) => p.id !== imported.id);
            if (custom.length >= PALETTE_LIBRARY_LIMIT) throw new Error("Remove an imported palette before adding another (limit 20).");
            setDraft({ ...draft, selected: `custom:${imported.id}`, custom: [...custom, imported] });
          } catch (err) { if (current === request.current) setError(errorMessage(err)); }
        }} />
      {dirty && <p className={styles.note} role="status">Previewing {palette.name}. Closing settings cancels unsaved changes.</p>}
      {error && <p className={styles.fieldError} role="alert">{error}</p>}
    </div>
  );
}
