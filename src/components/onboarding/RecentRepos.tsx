import { useEffect, useState } from "react";
import { formatRelativeAge } from "../../format";
import type { ProviderInfo, RecentRepoGroup } from "../../shared/ipc";
import styles from "./OnboardingModal.module.css";

/** Checkouts without a remote stand alone in main; show them as one group. */
function displayGroups(groups: RecentRepoGroup[]): RecentRepoGroup[] {
  const shown: RecentRepoGroup[] = [];
  let local: RecentRepoGroup | null = null;
  for (const g of groups) {
    if (g.remote) shown.push(g);
    else if (local) local.repos.push(...g.repos);
    else shown.push((local = { remote: null, repos: [...g.repos] }));
  }
  return shown;
}

/**
 * First-run discovery (#1501): repos the user worked in recently with a
 * provider CLI, grouped by remote, recently active ones ticked. Adds every
 * ticked repo in one step.
 */
export function RecentRepos({
  discover,
  onAdd,
  providers,
  onFound,
}: {
  discover: () => Promise<RecentRepoGroup[]>;
  /** Adds each path; resolves with the ones that were added. */
  onAdd: (paths: string[]) => Promise<string[]>;
  providers: ProviderInfo[];
  /** How many repos are on offer, so the step can demote its folder button. */
  onFound?: (count: number) => void;
}) {
  const [groups, setGroups] = useState<RecentRepoGroup[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(0);

  useEffect(() => {
    let live = true;
    discover()
      .catch(() => [] as RecentRepoGroup[])
      .then((found) => {
        if (!live) return;
        setGroups(displayGroups(found));
        setPicked(
          new Set(found.flatMap((g) => g.repos.filter((r) => r.preselected).map((r) => r.path))),
        );
      });
    return () => {
      live = false;
    };
  }, [discover]);

  const count = groups ? groups.reduce((n, g) => n + g.repos.length, 0) : 0;
  useEffect(() => {
    onFound?.(count);
  }, [count, onFound]);

  if (groups === null) {
    return (
      <p className={styles.stepBody} data-onboarding-recent-loading="">
        Looking for repos you worked in recently…
      </p>
    );
  }
  if (count === 0) return null;

  const toggle = (path: string, on: boolean) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });

  const add = async () => {
    const paths = [...picked];
    setBusy(true);
    try {
      const added = new Set(await onAdd(paths));
      setFailed(paths.length - added.size);
      setGroups((cur) =>
        (cur ?? [])
          .map((g) => ({ ...g, repos: g.repos.filter((r) => !added.has(r.path)) }))
          .filter((g) => g.repos.length > 0),
      );
      setPicked((cur) => new Set([...cur].filter((p) => !added.has(p))));
    } finally {
      setBusy(false);
    }
  };

  const name = (id: string) => providers.find((p) => p.id === id)?.name ?? id;
  const now = Date.now();
  const age = (at: number) => {
    const rel = formatRelativeAge(at, now);
    return rel === "now" ? "just now" : `${rel} ago`;
  };

  return (
    <div className={styles.setupSection} data-onboarding-recent="">
      <p className={styles.setupSectionLabel}>Recent repos</p>
      <p className={styles.stepBody}>
        Found in your agent CLIs&apos; history. The ones you used lately are
        ticked.
      </p>
      {groups.map((g) => (
        <fieldset
          key={g.remote ?? "local"}
          className={styles.recentGroup}
          disabled={busy}
          data-recent-group={g.remote ?? ""}
        >
          <legend className={styles.recentRemote}>{g.remote ?? "Local only"}</legend>
          {g.repos.map((r) => (
            <label key={r.path} className={styles.setupToggle} data-recent-repo={r.path}>
              <input
                type="checkbox"
                checked={picked.has(r.path)}
                onChange={(e) => toggle(r.path, e.target.checked)}
              />
              <span className={styles.recentText}>
                <span className={styles.recentName}>{r.name}</span>
                <span className={styles.recentMeta} title={r.path}>
                  {age(r.lastActiveAt)} · {r.providers.map(name).join(", ")} ·{" "}
                  {r.path}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      ))}
      <div className={styles.recentActions}>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          data-onboarding-recent-add=""
          disabled={busy || picked.size === 0}
          onClick={() => void add()}
        >
          {busy
            ? "Adding…"
            : picked.size === 1
              ? "Add 1 project"
              : `Add ${picked.size} projects`}
        </button>
      </div>
      {failed > 0 ? (
        <p className={styles.setupError} role="alert" data-onboarding-recent-error="">
          {failed === 1 ? "1 repo could not be added." : `${failed} repos could not be added.`}
        </p>
      ) : null}
    </div>
  );
}
