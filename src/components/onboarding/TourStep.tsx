import type { OnboardingStepProps } from "./OnboardingModal";
import styles from "./OnboardingModal.module.css";

const DOCS = "https://solenta.app/docs.html";

const CARDS: ReadonlyArray<{
  slug: string;
  title: string;
  body: string;
  href?: string;
}> = [
  {
    slug: "threads",
    title: "Threads & providers",
    body: "Each thread is one agent conversation — Claude Code, Codex, Grok, Kimi or OpenCode — against one project.",
    href: `${DOCS}#threads`,
  },
  {
    slug: "workers",
    title: "Parallel workers",
    body: "A lead thread forks workers that build in isolated worktrees and report back instead of editing itself.",
    href: `${DOCS}#orchestration`,
  },
  {
    slug: "worktrees",
    title: "Worktrees & PRs",
    body: "Each thread gets its own git worktree; review, merge or open a PR from the Git tab.",
    href: `${DOCS}#worktrees`,
  },
  {
    slug: "review",
    title: "Review itinerary",
    body: "The agent ranks its own diff so you read the change in the right order, not top to bottom.",
    href: `${DOCS}#review`,
  },
  {
    slug: "memory",
    title: "Shared memory",
    body: "Decisions and gotchas one thread stores stay visible to the next, per project, across sessions.",
    href: `${DOCS}#memory`,
  },
  {
    slug: "modes",
    title: "Spec, Teach & Ask modes",
    body: "Stage a spec before the patch, learn with hints instead of silent diffs, or ask read-only questions.",
    href: `${DOCS}#spec`,
  },
  {
    slug: "shortcuts",
    title: "Keyboard shortcuts",
    body: "Press ? anywhere to open the shortcut sheet for new threads, stop, and the rest.",
  },
];

export default function TourStep({}: OnboardingStepProps) {
  return (
    <div className={styles.step} data-onboarding-tour="">
      <h3 className={styles.stepTitle}>What you can do</h3>
      <p className={styles.stepBody}>
        A short map of the desk. Open a card's docs if you want the full story.
      </p>
      <ul className={styles.tourGrid}>
        {CARDS.map((card) => (
          <li
            key={card.slug}
            className={styles.tourCard}
            data-onboarding-tour-card={card.slug}
          >
            <p className={styles.tourCardTitle}>{card.title}</p>
            <p className={styles.tourCardBody}>{card.body}</p>
            {card.href ? (
              <a
                className={styles.tourCardLink}
                href={card.href}
                target="_blank"
                rel="noreferrer"
              >
                Learn more
              </a>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
