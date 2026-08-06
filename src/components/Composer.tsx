import { useState } from "react";
import type { ComposerConfig } from "../mockData";
import styles from "./Composer.module.css";

interface ComposerProps {
  config: ComposerConfig;
}

export function Composer({ config }: ComposerProps) {
  const [value, setValue] = useState("");

  return (
    <div className={styles.composer}>
      <div className={styles.card}>
        <textarea
          className={styles.textarea}
          placeholder={config.placeholder}
          rows={3}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <div className={styles.controls}>
          <div className={styles.pills}>
            <button type="button" className={styles.pill}>
              {config.model}
              <span className={styles.caret}>▾</span>
            </button>
            <button type="button" className={styles.pill}>
              {config.effort}
            </button>
            <button type="button" className={styles.pill}>
              {config.access}
            </button>
            <button type="button" className={`${styles.pill} ${styles.pillAccent}`}>
              {config.mode}
              <span className={styles.caret}>▾</span>
            </button>
          </div>
          <button
            type="button"
            className={styles.send}
            aria-label="Send"
            disabled={!value.trim()}
          >
            ↑
          </button>
        </div>
      </div>
      <div className={styles.meta}>
        <span className={styles.chip}>{config.sessionId}</span>
        <span className={styles.chip}>{config.worktreeLabel}</span>
        <span className={`${styles.chip} ${styles.chipMono}`}>
          {config.branch}
        </span>
      </div>
    </div>
  );
}
