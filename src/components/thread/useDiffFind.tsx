import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { findDiffHits, stepIndex } from "../../findInView";
import { FindBar, useFindSession, useFindShortcut } from "../FindBar";

export function useDiffFind(
  files: readonly { path: string }[],
  patches: readonly { path: string; text: string }[],
  onSelectPath: (path: string) => void,
  resetKey?: string | number | null,
) {
  const rootRef = useRef<HTMLElement | null>(null);
  const session = useFindSession();
  useFindShortcut("diff", session.openFind, rootRef);
  useEffect(() => {
    session.closeFind();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  const hits = useMemo(
    () =>
      session.open ? findDiffHits(files, patches, session.query) : [],
    [session.open, session.query, files, patches],
  );
  const current = hits[session.index] ?? null;

  useEffect(() => {
    if (current) onSelectPath(current.path);
  }, [current, onSelectPath]);

  useLayoutEffect(() => {
    const scope = rootRef.current ?? document;
    for (const el of scope.querySelectorAll("[data-find-current]")) {
      el.removeAttribute("data-find-current");
    }
    if (!session.open || !current) return;
    const escaped = current.path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const child = scope.querySelector(
      `[data-file-path="${escaped}"], [data-turn-diff-file="${escaped}"]`,
    );
    if (child instanceof HTMLElement) {
      child.setAttribute("data-find-current", "");
      child.scrollIntoView({ block: "nearest" });
    }
  }, [session.open, current]);

  const step = (dir: 1 | -1) => {
    session.setIndex((i) => stepIndex(i, hits.length, dir));
  };

  const bar = session.open ? (
    <FindBar
      surface="diff"
      query={session.query}
      current={hits.length ? session.index : 0}
      total={hits.length}
      inputRef={session.inputRef}
      onQuery={session.updateQuery}
      onNext={() => step(1)}
      onPrev={() => step(-1)}
      onClose={session.closeFind}
    />
  ) : null;

  return { bar, current, open: session.open, rootRef };
}
