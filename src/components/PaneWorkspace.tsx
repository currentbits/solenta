import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  closePane,
  hasPaneType,
  leaves,
  movePane,
  PANE_TYPES,
  paneTitle,
  resizeSplit,
  type DropEdge,
  type LayoutNode,
  type PaneLeaf,
  type PaneSplit,
  type PaneType,
} from "../paneLayout";
import { isWebMode } from "../shared/wire";
import styles from "./PaneWorkspace.module.css";

const PANE_DRAG_MIME = "application/x-solenta-pane";

/** jsdom's DataTransfer is incomplete; keep the source id across the gesture. */
let draggingPaneId: string | null = null;

export function PanePlaceholder({ type }: { type: PaneType }) {
  return (
    <div className={styles.placeholder} data-pane-placeholder={type}>
      <p className={styles.placeholderTitle}>{paneTitle(type)}</p>
      <p className={styles.placeholderHint}>
        This pane isn’t built yet. Opening it reserves a slot in the layout.
      </p>
    </div>
  );
}

export function ViewsMenu({
  layout,
  onOpen,
  onReset,
}: {
  layout: LayoutNode;
  onOpen: (type: PaneType) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className={styles.viewsWrap} ref={wrapRef} data-views-menu="">
      <button
        type="button"
        className={styles.viewsBtn}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Views"
        data-views-btn=""
        onClick={() => setOpen((v) => !v)}
      >
        Views
      </button>
      {open && (
        <div className={styles.viewsMenu} role="menu">
          {PANE_TYPES.filter(
            (type) => !(isWebMode() && type === "simulator"),
          ).map((type) => {
            const openAlready = hasPaneType(layout, type);
            return (
              <button
                key={type}
                type="button"
                className={styles.viewsItem}
                role="menuitem"
                data-views-item={type}
                aria-checked={openAlready}
                onClick={() => {
                  setOpen(false);
                  onOpen(type);
                }}
              >
                <span>{paneTitle(type)}</span>
                {openAlready ? (
                  <span className={styles.viewsCheck} aria-hidden>
                    ✓
                  </span>
                ) : null}
              </button>
            );
          })}
          <button
            type="button"
            className={styles.viewsItem}
            role="menuitem"
            data-views-reset=""
            onClick={() => {
              setOpen(false);
              onReset();
            }}
          >
            Reset layout
          </button>
        </div>
      )}
    </div>
  );
}

export function PaneWorkspace({
  layout,
  focusedId,
  onChange,
  onFocus,
  renderPane,
}: {
  layout: LayoutNode;
  focusedId: string;
  onChange: (next: LayoutNode) => void;
  onFocus: (id: string) => void;
  renderPane: (leaf: PaneLeaf) => ReactNode;
}) {
  const rootRef = useRef(layout);
  rootRef.current = layout;
  const showChrome = leaves(layout).length > 1;

  const closeFocused = useCallback(() => {
    const result = closePane(rootRef.current, focusedId);
    if (!result.closed) return;
    onChange(result.layout);
    onFocus(result.focusId);
  }, [focusedId, onChange, onFocus]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "\\") return;
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      e.preventDefault();
      closeFocused();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeFocused]);

  return (
    <div className={styles.workspace} data-pane-workspace="">
      <Node
        node={layout}
        rootRef={rootRef}
        focusedId={focusedId}
        showChrome={showChrome}
        onChange={onChange}
        onFocus={onFocus}
        renderPane={renderPane}
      />
    </div>
  );
}

function Node({
  node,
  rootRef,
  focusedId,
  showChrome,
  onChange,
  onFocus,
  renderPane,
}: {
  node: LayoutNode;
  rootRef: RefObject<LayoutNode>;
  focusedId: string;
  showChrome: boolean;
  onChange: (next: LayoutNode) => void;
  onFocus: (id: string) => void;
  renderPane: (leaf: PaneLeaf) => ReactNode;
}) {
  if (node.kind === "leaf") {
    return (
      <Leaf
        leaf={node}
        rootRef={rootRef}
        focused={node.id === focusedId}
        showChrome={showChrome}
        onChange={onChange}
        onFocus={onFocus}
        renderPane={renderPane}
      />
    );
  }
  return (
    <Split
      split={node}
      rootRef={rootRef}
      focusedId={focusedId}
      showChrome={showChrome}
      onChange={onChange}
      onFocus={onFocus}
      renderPane={renderPane}
    />
  );
}

function Split({
  split,
  rootRef,
  focusedId,
  showChrome,
  onChange,
  onFocus,
  renderPane,
}: {
  split: PaneSplit;
  rootRef: RefObject<LayoutNode>;
  focusedId: string;
  showChrome: boolean;
  onChange: (next: LayoutNode) => void;
  onFocus: (id: string) => void;
  renderPane: (leaf: PaneLeaf) => ReactNode;
}) {
  const horizontal = split.orientation === "horizontal";
  const frameRef = useRef<HTMLDivElement>(null);

  const onSplitterPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    const frame = frameRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    const size = horizontal ? rect.width : rect.height;
    if (size <= 0) return;
    const pointerId = e.pointerId;
    const target = e.currentTarget;
    target.setPointerCapture(pointerId);

    const onMove = (ev: PointerEvent) => {
      const pos = horizontal ? ev.clientX : ev.clientY;
      const originPos = horizontal ? rect.left : rect.top;
      const next = (pos - originPos) / size;
      if (!Number.isFinite(next)) return;
      onChange(resizeSplit(rootRef.current, split.id, next));
    };
    const onUp = () => {
      target.releasePointerCapture(pointerId);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
  };

  const child = (
    childNode: LayoutNode,
    ratio: number,
  ) => (
    <div className={styles.splitChild} style={{ flex: `${ratio} 1 0` }}>
      <Node
        node={childNode}
        rootRef={rootRef}
        focusedId={focusedId}
        showChrome={showChrome}
        onChange={onChange}
        onFocus={onFocus}
        renderPane={renderPane}
      />
    </div>
  );

  return (
    <div
      ref={frameRef}
      className={styles.split}
      data-pane-split={split.orientation}
      style={{ flexDirection: horizontal ? "row" : "column" }}
    >
      {child(split.children[0], split.ratio)}
      <button
        type="button"
        className={styles.splitter}
        data-pane-splitter={split.orientation}
        aria-label={
          horizontal ? "Resize panes left and right" : "Resize panes up and down"
        }
        style={{ cursor: horizontal ? "col-resize" : "row-resize" }}
        onPointerDown={onSplitterPointerDown}
      />
      {child(split.children[1], 1 - split.ratio)}
    </div>
  );
}

function Leaf({
  leaf,
  rootRef,
  focused,
  showChrome,
  onChange,
  onFocus,
  renderPane,
}: {
  leaf: PaneLeaf;
  rootRef: RefObject<LayoutNode>;
  focused: boolean;
  showChrome: boolean;
  onChange: (next: LayoutNode) => void;
  onFocus: (id: string) => void;
  renderPane: (leaf: PaneLeaf) => ReactNode;
}) {
  const onDragStart = (e: React.DragEvent) => {
    draggingPaneId = leaf.id;
    if (!e.dataTransfer) return;
    e.dataTransfer.effectAllowed = "move";
    try {
      e.dataTransfer.setData(PANE_DRAG_MIME, leaf.id);
    } catch {
      // jsdom
    }
  };

  return (
    <section
      className={styles.leaf}
      data-pane-leaf=""
      data-pane-type={leaf.type}
      data-pane-id={leaf.id}
      data-focused={focused ? "true" : undefined}
      onClick={() => onFocus(leaf.id)}
      onMouseDown={() => onFocus(leaf.id)}
      onDragOver={(e) => {
        if (!draggingPaneId || draggingPaneId === leaf.id) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      }}
      onDrop={(e) => {
        e.preventDefault();
        const sourceId = draggingPaneId;
        draggingPaneId = null;
        if (!sourceId) return;
        onChange(movePane(rootRef.current, sourceId, leaf.id, dropEdge(e)));
      }}
    >
      {showChrome && (
        <header
          className={styles.header}
          data-pane-header=""
          draggable
          onDragStart={onDragStart}
          onDragEnd={() => {
            draggingPaneId = null;
          }}
        >
          <span className={styles.headerTitle}>{paneTitle(leaf.type)}</span>
          <button
            type="button"
            className={styles.close}
            data-pane-close=""
            aria-label={`Close ${paneTitle(leaf.type)}`}
            title={`Close ${paneTitle(leaf.type)}`}
            onClick={(e) => {
              e.stopPropagation();
              const result = closePane(rootRef.current, leaf.id);
              if (!result.closed) return;
              onChange(result.layout);
              onFocus(result.focusId);
            }}
          >
            ×
          </button>
        </header>
      )}
      <div className={styles.leafBody}>
        {isWebMode() && leaf.type === "simulator" ? (
          <div data-simulator-web-hidden="">
            iOS Simulator is available in the desktop app.
          </div>
        ) : (
          renderPane(leaf)
        )}
      </div>
    </section>
  );
}

function dropEdge(e: React.DragEvent): DropEdge {
  const el = e.currentTarget as HTMLElement;
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) return "center";
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const edgeX = rect.width * 0.25;
  const edgeY = rect.height * 0.25;
  if (x < edgeX) return "left";
  if (x > rect.width - edgeX) return "right";
  if (y < edgeY) return "top";
  if (y > rect.height - edgeY) return "bottom";
  return "center";
}
