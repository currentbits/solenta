import type { Dispatch, SetStateAction } from "react";
import type { ProviderInfo } from "../../shared/ipc";
import {
  GROUP_BY_OPTIONS,
  PROVIDER_FILTER_KEY,
  STATUS_FILTERS,
  groupByLabel,
  providerFilterLabel,
  statusFilterLabel,
  tagFilterLabel,
  type GroupBy,
  type StatusFilter,
} from "../../sidebarFilters";
import { savedViewTriggerLabel, type SavedView } from "../../sidebarViews";
import { ProviderMark } from "../ProviderMark";
import { Icon } from "./Icon";
import { saveStored } from "./storage";
import styles from "../Sidebar.module.css";

export type FilterMenu = "status" | "provider" | "group" | "tag" | "views";
export type ViewEditor = { mode: "save" | "rename"; name: string };

/**
 * Filter bar: saved views menu, then status / provider / tag / group-by
 * menus. All state and handlers live in Sidebar.
 */
export function FilterBar({
  activeSavedView,
  viewModified,
  filterMenu,
  toggleFilterMenu,
  savedViews,
  viewEditor,
  activeViewId,
  recallSavedView,
  submitViewEditor,
  setViewEditor,
  updateActiveView,
  deleteActiveView,
  statusFilter,
  applyStatusFilter,
  providerFilter,
  providerNames,
  setProviderFilter,
  providerOptions,
  toggleProviderFilter,
  providers,
  knownTags,
  tagFilter,
  applyTagFilter,
  groupBy,
  applyGroupBy,
}: {
  activeSavedView: SavedView | null;
  viewModified: boolean;
  filterMenu: FilterMenu | null;
  toggleFilterMenu: (menu: FilterMenu) => void;
  savedViews: SavedView[];
  viewEditor: ViewEditor | null;
  activeViewId: string | null;
  recallSavedView: (view: SavedView) => void;
  submitViewEditor: () => void;
  setViewEditor: Dispatch<SetStateAction<ViewEditor | null>>;
  updateActiveView: () => void;
  deleteActiveView: () => void;
  statusFilter: StatusFilter | null;
  applyStatusFilter: (id: StatusFilter | null) => void;
  providerFilter: string[];
  providerNames: Map<string, string>;
  setProviderFilter: Dispatch<SetStateAction<string[]>>;
  providerOptions: { id: string; name: string }[];
  toggleProviderFilter: (id: string) => void;
  providers: ProviderInfo[];
  knownTags: string[];
  tagFilter: string | null;
  applyTagFilter: (tag: string | null) => void;
  groupBy: GroupBy;
  applyGroupBy: (id: GroupBy) => void;
}) {
  return (
    <div className={styles.filterBar} data-filter-bar="">
    <div className={styles.viewRow}>
      <span className={styles.filterMenuHost}>
        <button
          type="button"
          className={styles.viewTrigger}
          data-saved-views-trigger=""
          data-active={activeSavedView ? "true" : undefined}
          data-modified={viewModified ? "true" : undefined}
          aria-haspopup="menu"
          aria-expanded={filterMenu === "views"}
          aria-label={
            activeSavedView
              ? viewModified
                ? `Saved views, ${activeSavedView.name}, modified`
                : `Saved views, ${activeSavedView.name}`
              : "Saved views"
          }
          onClick={() => toggleFilterMenu("views")}
        >
          <span className={styles.filterTriggerLabel}>
            {savedViewTriggerLabel(
              activeSavedView ? { name: activeSavedView.name } : null,
              viewModified,
            )}
          </span>
          <Icon size={12}>
            <path d="m6 9 6 6 6-6" />
          </Icon>
        </button>
        {filterMenu === "views" && (
          <div
            className={`${styles.menu} ${styles.menuLeft} ${styles.viewMenu}`}
            role="menu"
            data-saved-views-menu=""
          >
            {savedViews.length === 0 && !viewEditor && (
              <p className={styles.viewEmpty}>No saved views</p>
            )}
            {savedViews.map((view) => (
              <button
                key={view.id}
                type="button"
                className={styles.menuItem}
                role="menuitem"
                data-saved-view={view.id}
                data-saved-view-label={view.name}
                data-selected={
                  view.id === activeViewId ? "true" : undefined
                }
                onClick={() => recallSavedView(view)}
              >
                {view.name}
                {view.id === activeViewId && !viewModified && (
                  <span className={styles.filterCheck}>
                    <Icon size={12}>
                      <path d="M5 12.5 9 16.5 19 7.5" />
                    </Icon>
                  </span>
                )}
              </button>
            ))}
            {viewEditor ? (
              <form
                className={styles.viewNameForm}
                onSubmit={(e) => {
                  e.preventDefault();
                  submitViewEditor();
                }}
              >
                <input
                  className={styles.viewNameInput}
                  data-saved-view-name=""
                  value={viewEditor.name}
                  onChange={(e) =>
                    setViewEditor({ ...viewEditor, name: e.target.value })
                  }
                  placeholder="View name"
                  aria-label="View name"
                  autoFocus
                />
                <button
                  type="submit"
                  className={styles.viewNameSave}
                  data-saved-view-save-confirm=""
                  disabled={viewEditor.name.trim() === ""}
                >
                  Save
                </button>
              </form>
            ) : (
              <>
                {savedViews.length > 0 && (
                  <div className={styles.menuSep} />
                )}
                <button
                  type="button"
                  className={styles.menuItem}
                  role="menuitem"
                  data-saved-view-save=""
                  onClick={() =>
                    setViewEditor({ mode: "save", name: "" })
                  }
                >
                  Save current as…
                </button>
                {activeSavedView && viewModified && (
                  <button
                    type="button"
                    className={styles.menuItem}
                    role="menuitem"
                    data-saved-view-update=""
                    onClick={updateActiveView}
                  >
                    Update view
                  </button>
                )}
                {activeSavedView && (
                  <button
                    type="button"
                    className={styles.menuItem}
                    role="menuitem"
                    data-saved-view-rename=""
                    onClick={() =>
                      setViewEditor({
                        mode: "rename",
                        name: activeSavedView.name,
                      })
                    }
                  >
                    Rename…
                  </button>
                )}
                {activeSavedView && (
                  <button
                    type="button"
                    className={styles.menuItem}
                    role="menuitem"
                    data-saved-view-delete=""
                    onClick={deleteActiveView}
                  >
                    Delete view
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </span>
    </div>

    <div className={styles.filterRow} data-filter-row="">
      <span className={styles.filterMenuHost}>
        <button
          type="button"
          className={styles.filterTrigger}
          data-status-filter-trigger=""
          data-active={statusFilter != null ? "true" : undefined}
          aria-haspopup="menu"
          aria-expanded={filterMenu === "status"}
          aria-label="Filter threads by status"
          onClick={() => toggleFilterMenu("status")}
        >
          <span className={styles.filterTriggerLabel}>
            {statusFilterLabel(statusFilter)}
          </span>
          <Icon size={12}>
            <path d="m6 9 6 6 6-6" />
          </Icon>
        </button>
        {filterMenu === "status" && (
          <div
            className={`${styles.menu} ${styles.menuLeft} ${styles.filterMenu}`}
            role="menu"
            data-status-filter-menu=""
          >
            <button
              type="button"
              className={styles.menuItem}
              role="menuitem"
              data-status-filter="all"
              data-selected={statusFilter == null ? "true" : undefined}
              onClick={() => applyStatusFilter(null)}
            >
              All statuses
              {statusFilter == null && (
                <span className={styles.filterCheck}>
                  <Icon size={12}>
                    <path d="M5 12.5 9 16.5 19 7.5" />
                  </Icon>
                </span>
              )}
            </button>
            {STATUS_FILTERS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={styles.menuItem}
                role="menuitem"
                data-status-filter={opt.id}
                data-selected={statusFilter === opt.id ? "true" : undefined}
                onClick={() => applyStatusFilter(opt.id)}
              >
                {opt.label}
                {statusFilter === opt.id && (
                  <span className={styles.filterCheck}>
                    <Icon size={12}>
                      <path d="M5 12.5 9 16.5 19 7.5" />
                    </Icon>
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </span>
      <span className={styles.filterMenuHost}>
        <button
          type="button"
          className={styles.filterTrigger}
          data-provider-filter-trigger=""
          data-active={providerFilter.length > 0 ? "true" : undefined}
          aria-haspopup="menu"
          aria-expanded={filterMenu === "provider"}
          aria-label="Filter threads by provider"
          onClick={() => toggleFilterMenu("provider")}
        >
          <span className={styles.filterTriggerLabel}>
            {providerFilterLabel(providerFilter, providerNames)}
          </span>
          <Icon size={12}>
            <path d="m6 9 6 6 6-6" />
          </Icon>
        </button>
        {filterMenu === "provider" && (
          <div
            className={`${styles.menu} ${styles.menuLeft} ${styles.filterMenu}`}
            role="menu"
            data-provider-filter-menu=""
          >
            <button
              type="button"
              className={styles.menuItem}
              role="menuitem"
              data-provider-filter="all"
              data-selected={providerFilter.length === 0 ? "true" : undefined}
              onClick={() => {
                setProviderFilter([]);
                saveStored(PROVIDER_FILTER_KEY, null);
              }}
            >
              All providers
              {providerFilter.length === 0 && (
                <span className={styles.filterCheck}>
                  <Icon size={12}>
                    <path d="M5 12.5 9 16.5 19 7.5" />
                  </Icon>
                </span>
              )}
            </button>
            <div className={styles.filterChipRow} data-provider-chips="">
              {providerOptions.map((p) => {
                const on = providerFilter.includes(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={styles.filterChip}
                    data-provider-filter={p.id}
                    data-on={on ? "true" : undefined}
                    aria-pressed={on}
                    onClick={() => toggleProviderFilter(p.id)}
                  >
                    <ProviderMark
                      providerId={p.id}
                      providers={providers}
                      size={12}
                      decorative
                    />
                    {p.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </span>
      {(knownTags.length > 0 || tagFilter != null) && (
        <span className={styles.filterMenuHost}>
          <button
            type="button"
            className={styles.filterTrigger}
            data-tag-filter-trigger=""
            data-active={tagFilter != null ? "true" : undefined}
            aria-haspopup="menu"
            aria-expanded={filterMenu === "tag"}
            aria-label="Filter threads by tag"
            onClick={() => toggleFilterMenu("tag")}
          >
            <span className={styles.filterTriggerLabel}>
              {tagFilterLabel(tagFilter)}
            </span>
            <Icon size={12}>
              <path d="m6 9 6 6 6-6" />
            </Icon>
          </button>
          {filterMenu === "tag" && (
            <div
              className={`${styles.menu} ${styles.menuLeft} ${styles.filterMenu}`}
              role="menu"
              data-tag-filter-menu=""
            >
              <button
                type="button"
                className={styles.menuItem}
                role="menuitem"
                data-tag-filter="all"
                data-selected={tagFilter == null ? "true" : undefined}
                onClick={() => applyTagFilter(null)}
              >
                All tags
                {tagFilter == null && (
                  <span className={styles.filterCheck}>
                    <Icon size={12}>
                      <path d="M5 12.5 9 16.5 19 7.5" />
                    </Icon>
                  </span>
                )}
              </button>
              {knownTags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className={styles.menuItem}
                  role="menuitem"
                  data-tag-filter={tag}
                  data-selected={tagFilter === tag ? "true" : undefined}
                  onClick={() => applyTagFilter(tag)}
                >
                  {tag}
                  {tagFilter === tag && (
                    <span className={styles.filterCheck}>
                      <Icon size={12}>
                        <path d="M5 12.5 9 16.5 19 7.5" />
                      </Icon>
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </span>
      )}
      <span className={styles.filterMenuHost}>
        <button
          type="button"
          className={styles.filterTrigger}
          data-group-by-trigger=""
          data-active={groupBy !== "none" ? "true" : undefined}
          aria-haspopup="menu"
          aria-expanded={filterMenu === "group"}
          aria-label="Group threads"
          onClick={() => toggleFilterMenu("group")}
        >
          <span className={styles.filterTriggerLabel}>
            {groupByLabel(groupBy)}
          </span>
          <Icon size={12}>
            <path d="m6 9 6 6 6-6" />
          </Icon>
        </button>
        {filterMenu === "group" && (
          <div
            className={`${styles.menu} ${styles.menuLeft} ${styles.filterMenu}`}
            role="menu"
            data-group-by-menu=""
          >
            {GROUP_BY_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={styles.menuItem}
                role="menuitem"
                data-group-by={opt.id}
                data-selected={groupBy === opt.id ? "true" : undefined}
                onClick={() => applyGroupBy(opt.id)}
              >
                {opt.label}
                {groupBy === opt.id && (
                  <span className={styles.filterCheck}>
                    <Icon size={12}>
                      <path d="M5 12.5 9 16.5 19 7.5" />
                    </Icon>
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </span>
    </div>
    </div>
  );
}
