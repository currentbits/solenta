import { useState } from "react";
import type { AgentDotStatus, AgentsWorkflow, PhaseStatus } from "../mockData";
import styles from "./AgentsPanel.module.css";

interface AgentsPanelProps {
  data: AgentsWorkflow;
}

function phaseClass(status: PhaseStatus): string {
  if (status === "done") return styles.phaseDone;
  if (status === "active") return styles.phaseActive;
  return styles.phasePending;
}

function dotClass(status: AgentDotStatus): string {
  if (status === "done") return styles.dotDone;
  if (status === "active") return styles.dotActive;
  if (status === "error") return styles.dotError;
  return styles.dotPending;
}

export function AgentsPanel({ data }: AgentsPanelProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const g of data.groups) {
      init[g.id] = g.expandedByDefault ?? false;
    }
    return init;
  });

  const toggle = (id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <aside className={styles.panel}>
      <header className={styles.tabs}>
        <button type="button" className={styles.tab} data-active="true">
          Agents
        </button>
      </header>

      <div className={styles.scroll}>
        <section className={styles.workflow}>
          <div className={styles.workflowHead}>
            <div>
              <div className={styles.workflowLabel}>Workflow</div>
              <div className={styles.workflowName}>{data.name}</div>
            </div>
            <div className={styles.settled}>{data.settledLabel}</div>
          </div>

          <div className={styles.pipeline} role="list" aria-label="Workflow phases">
            {data.phases.map((phase, index) => (
              <div key={phase.id} className={styles.phaseWrap} role="listitem">
                {index > 0 && <span className={styles.connector} aria-hidden />}
                <span
                  className={`${styles.phaseChip} ${phaseClass(phase.status)}`}
                >
                  {phase.status === "active" && (
                    <span className={styles.dots} aria-hidden>
                      <i />
                      <i />
                      <i />
                    </span>
                  )}
                  {phase.status === "done" && (
                    <span className={styles.phaseCheck} aria-hidden>
                      ✓
                    </span>
                  )}
                  {phase.name}
                </span>
              </div>
            ))}
          </div>
        </section>

        <div className={styles.groups}>
          {data.groups.map((group) => {
            const open = expanded[group.id];
            return (
              <section key={group.id} className={styles.group}>
                <button
                  type="button"
                  className={styles.groupHeader}
                  onClick={() => toggle(group.id)}
                  aria-expanded={open}
                >
                  <span className={styles.chevron} data-open={open}>
                    ▸
                  </span>
                  <span className={styles.groupName}>{group.name}</span>
                  <span className={styles.groupMeta}>
                    · {group.activeCount} active · {group.doneCount} done
                  </span>
                </button>
                {open && (
                  <ul className={styles.agentList}>
                    {group.agents.map((agent) => (
                      <li key={agent.id} className={styles.agentRow}>
                        <span
                          className={`${styles.dot} ${dotClass(agent.status)}`}
                          aria-label={agent.status}
                        />
                        <span className={styles.agentLabel}>
                          {agent.label}
                          <span className={styles.agentModel}>
                            {" "}
                            / {agent.model}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      </div>

      <footer className={styles.footer}>
        <span>
          {data.footerWorking} · {data.footerSettled}
        </span>
        <span className={styles.tokens}>{data.tokenSum}</span>
      </footer>
    </aside>
  );
}
