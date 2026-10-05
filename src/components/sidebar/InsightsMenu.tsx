import type { RefObject } from "react";
import { Icon } from "./Icon";
import type { MORE_DESTINATIONS, SidebarNavView } from "./nav";
import styles from "../Sidebar.module.css";

/**
 * Footer Insights menu (activity, usage, automations, …). Open state, focus
 * and dismissal stay in Sidebar (useMoreMenuFocus, toggleMore, closeMore).
 */
export function InsightsMenu({
  moreHostRef,
  moreTriggerRef,
  onMoreBlur,
  moreOpen,
  moreCurrentLabel,
  toggleMore,
  onMoreKeyDown,
  closeMore,
  onOpenThreads,
  moreDestinations,
  activeView,
}: {
  moreHostRef: RefObject<HTMLSpanElement | null>;
  moreTriggerRef: RefObject<HTMLButtonElement | null>;
  onMoreBlur: (e: React.FocusEvent<HTMLElement>) => void;
  moreOpen: boolean;
  moreCurrentLabel: string | null;
  toggleMore: () => void;
  onMoreKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
  closeMore: (returnFocus: boolean) => void;
  onOpenThreads: (() => void) | undefined;
  moreDestinations: ((typeof MORE_DESTINATIONS)[number] & { run: () => void })[];
  activeView: SidebarNavView;
}) {
  return (
    <span
      className={styles.filterMenuHost}
      ref={moreHostRef}
      onBlur={onMoreBlur}
    >
      <button
        type="button"
        ref={moreTriggerRef}
        className={`${styles.viewNavBtn} ${styles.viewNavMore}`}
        data-app-more=""
        title="Insights: activity, usage, automations and more"
        aria-haspopup="menu"
        aria-expanded={moreOpen}
        aria-controls="app-more-menu"
        aria-current={moreCurrentLabel ? "page" : undefined}
        data-active={moreCurrentLabel ? "true" : undefined}
        aria-label={
          moreCurrentLabel ? `Insights, ${moreCurrentLabel}` : undefined
        }
        onClick={toggleMore}
        onKeyDown={onMoreKeyDown}
      >
        <Icon size={15}>
          <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
        </Icon>
        <span className={styles.srOnly}>Insights</span>
      </button>
      {moreOpen && (
        <div
          id="app-more-menu"
          className={`${styles.menu} ${styles.appMoreMenu} ${styles.appMoreMenuUp}`}
          role="menu"
          aria-label="Insights"
          data-app-more-menu=""
          onKeyDown={onMoreKeyDown}
        >
          {moreCurrentLabel ? (
            <button
              type="button"
              className={styles.menuItem}
              role="menuitem"
              data-view-nav="threads"
              onClick={() => {
                closeMore(true);
                onOpenThreads?.();
              }}
            >
              Back to threads
            </button>
          ) : null}
          {moreDestinations.map((dest) => {
            const current = activeView === dest.view;
            return (
              <button
                key={dest.id}
                type="button"
                className={styles.menuItem}
                role="menuitem"
                data-view-nav={dest.id}
                data-active={current ? "true" : undefined}
                aria-current={current ? "page" : undefined}
                onClick={() => {
                  closeMore(true);
                  dest.run();
                }}
              >
                {dest.label}
                {current && (
                  <span className={styles.filterCheck}>
                    <Icon size={12}>
                      <path d="M5 12.5 9 16.5 19 7.5" />
                    </Icon>
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}
