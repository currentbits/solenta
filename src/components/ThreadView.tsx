import { useState } from "react";
import type { ThreadViewData } from "../mockData";
import { Composer } from "./Composer";
import styles from "./ThreadView.module.css";

interface ThreadViewProps {
  data: ThreadViewData;
}

export function ThreadView({ data }: ThreadViewProps) {
  const [workLogOpen, setWorkLogOpen] = useState(
    !(data.workLog.collapsedByDefault ?? false),
  );

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <div className={styles.breadcrumb}>
          <span className={styles.project}>{data.project}</span>
          <span className={styles.sep}>/</span>
          <span className={styles.threadTitle}>{data.title}</span>
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.btn}>
            Setup Worktree
          </button>
          <button type="button" className={`${styles.btn} ${styles.btnPrimary}`}>
            Push
          </button>
        </div>
      </header>

      <div className={styles.body}>
        <section className={styles.card}>
          <button
            type="button"
            className={styles.cardHeader}
            onClick={() => setWorkLogOpen((v) => !v)}
            aria-expanded={workLogOpen}
          >
            <span className={styles.chevron} data-open={workLogOpen}>
              ▸
            </span>
            <span className={styles.cardTitle}>{data.workLog.title}</span>
          </button>
          {workLogOpen && (
            <>
              <ul className={styles.steps}>
                {data.workLog.steps.map((step) => (
                  <li key={step.id} className={styles.step}>
                    <span
                      className={styles.checkbox}
                      data-done={step.done}
                      aria-hidden
                    >
                      {step.done ? "✓" : ""}
                    </span>
                    <span className={styles.stepLabel}>{step.label}</span>
                  </li>
                ))}
              </ul>
              <footer className={styles.workLogFooter}>
                {data.workLog.duration}
              </footer>
            </>
          )}
        </section>

        <section className={styles.card}>
          <div className={styles.eventTitle}>{data.kickoff.title}</div>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Phase</th>
                <th>Agents</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {data.kickoff.rows.map((row) => (
                <tr key={`${row.phase}-${row.agents}`}>
                  <td>{row.phase}</td>
                  <td>{row.agents}</td>
                  <td>{row.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {data.messages.map((msg) => (
          <article key={msg.id} className={styles.message}>
            {msg.paragraphs.map((p, i) => (
              <p key={`${msg.id}-${i}`}>{p}</p>
            ))}
          </article>
        ))}

        <div className={styles.statusStrip}>
          <div className={styles.statusLeft}>
            <span className={styles.statusDot} aria-hidden />
            <span>{data.backgroundStatus.label}</span>
          </div>
          {data.backgroundStatus.canStop && (
            <button type="button" className={styles.stopBtn}>
              Stop
            </button>
          )}
        </div>
      </div>

      <Composer config={data.composer} />
    </main>
  );
}
