import { useState } from "react";
import type { RecordingPrivacy } from "../recordingPrivacy";
import styles from "./RecordingPrivacyControl.module.css";

export function RecordingPrivacyControl({ privacy, knownTags, onChange }: {
  privacy: RecordingPrivacy;
  knownTags: string[];
  onChange: (next: RecordingPrivacy) => void;
}) {
  const [open, setOpen] = useState(false);
  const tags = [...new Set([...knownTags, ...privacy.hiddenTags])].sort();
  return <section className={styles.control} aria-label="Recording privacy">
    <button type="button" className={styles.launcher} aria-expanded={open} onClick={() => setOpen(!open)}>
      <span aria-hidden="true">◉</span> Recording mode{privacy.enabled ? " on" : ""}
    </button>
    {open && <div className={styles.options}>
      <p>Hide threads with selected tags while sharing this connection.</p>
      <fieldset>
        <legend>Tags to hide</legend>
        {tags.length ? tags.map((tag) => <label key={tag}>
          <input type="checkbox" checked={privacy.hiddenTags.includes(tag)} onChange={(event) => onChange({
            ...privacy,
            hiddenTags: event.target.checked ? [...privacy.hiddenTags, tag] : privacy.hiddenTags.filter((t) => t !== tag),
          })} />{tag}
        </label>) : <p>Add a tag to a thread to choose it here.</p>}
      </fieldset>
      <p className={styles.note}>Display only. Agents keep working; access to their data is unchanged.</p>
      <button type="button" className={styles.toggle} disabled={!privacy.enabled && !privacy.hiddenTags.length} onClick={() => {
        onChange({ ...privacy, enabled: !privacy.enabled });
        setOpen(false);
      }}>{privacy.enabled ? "End recording mode" : "Start recording mode"}</button>
    </div>}
  </section>;
}

export function RecordingPrivacyBanner({ onEnd }: { onEnd: () => void }) {
  return <div className={styles.banner} role="status" data-recording-mode="">
    <span>Recording mode on. Tagged threads are hidden.</span>
    <button type="button" onClick={onEnd}>End recording mode</button>
  </div>;
}
