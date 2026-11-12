import {
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import type {
  CoderApi,
  DevServerState,
  LocalServerInfo,
  PreviewDiagnostics,
  PreviewSnapshot,
  PreviewViewportPreset,
} from "../shared/ipc";
import {
  elementChipPrompt,
  type InspectPick,
  type ElementChip,
} from "../contextChips";
import { getContextChips, setContextChips, subscribeContextChips } from "../composerSession";
import { coercePreviewUrl, isLoopbackPreviewUrl } from "../previewUrl";
import styles from "./BrowserPane.module.css";

const POLL_MS = 3_000;

type PreviewApi = CoderApi["preview"];

const VIEWPORT_OPTIONS: { value: PreviewViewportPreset; label: string }[] = [
  { value: "fill", label: "Fill pane" },
  { value: "mobile", label: "Mobile 390" },
  { value: "tablet", label: "Tablet 820" },
  { value: "desktop", label: "Desktop 1440" },
];

/** The same console / network evidence the agent reads (#1191). */
function DiagnosticsPanel({ diag }: { diag: PreviewDiagnostics | null }) {
  if (!diag) {
    return (
      <div className={styles.diag} data-browser-diagnostics="">
        <p className={styles.diagEmpty}>Open a page to collect diagnostics.</p>
      </div>
    );
  }
  return (
    <div className={styles.diag} data-browser-diagnostics="">
      <section aria-label="Console">
        <h3 className={styles.diagHead}>
          Console
          {diag.dropped.console ? (
            <span className={styles.diagDropped}> · {diag.dropped.console} older dropped</span>
          ) : null}
        </h3>
        {diag.console.length ? (
          <ul className={styles.diagList}>
            {diag.console.map((c) => (
              <li key={c.seq} className={styles.diagRow} data-level={c.level}>
                <span className={styles.diagTag}>{c.level}</span>
                <span className={styles.diagText}>{c.text}</span>
                {c.source ? <span className={styles.diagMeta}>{c.source}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.diagEmpty}>No console messages.</p>
        )}
      </section>
      <section aria-label="Network">
        <h3 className={styles.diagHead}>
          Network
          {diag.dropped.network ? (
            <span className={styles.diagDropped}> · {diag.dropped.network} older dropped</span>
          ) : null}
        </h3>
        {diag.network.length ? (
          <ul className={styles.diagList}>
            {diag.network.map((n) => {
              const failed = Boolean(n.error) || (n.status ?? 0) >= 400;
              return (
                <li
                  key={n.seq}
                  className={styles.diagRow}
                  data-level={failed ? "error" : "info"}
                >
                  <span className={styles.diagTag}>{n.error ? "failed" : n.status ?? "…"}</span>
                  <span className={styles.diagText}>
                    {n.method} {n.url}
                  </span>
                  <span className={styles.diagMeta}>
                    {n.error ? `${n.error} · ` : ""}
                    {n.durationMs != null ? `${n.durationMs} ms` : n.type}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className={styles.diagEmpty}>No requests yet.</p>
        )}
      </section>
    </div>
  );
}

function webContentsIdOf(el: HTMLElement | null): number | null {
  const any = el as unknown as { getWebContentsId?: () => number };
  if (!any || typeof any.getWebContentsId !== "function") return null;
  try {
    const id = any.getWebContentsId();
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function pickSuggestedUrl(
  status: DevServerState | null,
  servers: LocalServerInfo[],
): string | null {
  const fromDev = status?.url?.trim() || "";
  if (fromDev && isLoopbackPreviewUrl(fromDev)) return coercePreviewUrl(fromDev);
  for (const row of servers) {
    const url = String(row?.url || "").trim();
    if (url && isLoopbackPreviewUrl(url)) return coercePreviewUrl(url);
  }
  return null;
}

export function BrowserPane({
  threadId,
  preview,
  devServerStatus,
  listLocalServers,
  onAttachScreenshot,
  onAttachElement,
  browserAccess = true,
  onSetBrowserAccess,
}: {
  threadId: string;
  preview?: PreviewApi | null;
  devServerStatus?: (threadId: string) => Promise<DevServerState>;
  listLocalServers?: (threadId: string) => Promise<LocalServerInfo[]>;
  /**
   * Persist a screenshot. `originThreadId` is the thread that started the
   * capture so a parent save already in flight cannot attach to another draft.
   */
  onAttachScreenshot?: (
    dataUrl: string,
    originThreadId: string,
  ) => unknown;
  /**
   * Insert a picked element into `originThreadId`'s composer as a context
   * chip (#1193). Never sends.
   */
  onAttachElement?: (
    pick: InspectPick,
    comment: string,
    originThreadId: string,
  ) => unknown;
  /**
   * Whether the agent's own preview MCP tool may drive this thread's pane
   * (#1797); default true. Never affects the user's own use of the pane.
   */
  browserAccess?: boolean;
  onSetBrowserAccess?: (enabled: boolean) => void | Promise<void>;
}) {
  const webviewRef = useRef<HTMLElement | null>(null);
  const [bound, setBound] = useState(false);
  const [address, setAddress] = useState("");
  const [draft, setDraft] = useState("");
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [suggestedUrl, setSuggestedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [viewportPreset, setViewportPreset] = useState<PreviewViewportPreset>("fill");
  const [diag, setDiag] = useState<PreviewDiagnostics | null>(null);
  const [diagOpen, setDiagOpen] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const readChips = () => getContextChips(threadId);
  const chips = useSyncExternalStore(subscribeContextChips, readChips, readChips);
  const annotations = chips.filter((chip): chip is ElementChip => chip.kind === "element");
  const inspectSession = useRef<{ threadId: string; id: string } | null>(null);
  const [savingAnnotation, setSavingAnnotation] = useState(false);
  const autoLoaded = useRef<string | null>(null);
  const threadIdRef = useRef(threadId);
  const captureGenRef = useRef(0);
  if (threadIdRef.current !== threadId) {
    threadIdRef.current = threadId;
    captureGenRef.current += 1;
  }

  const applySnap = useCallback((snap: PreviewSnapshot | null | undefined) => {
    if (!snap) return;
    const url = snap.url && snap.url !== "about:blank" ? snap.url : "";
    setAddress(url);
    setDraft(url);
    setCanGoBack(Boolean(snap.canGoBack));
    setCanGoForward(Boolean(snap.canGoForward));
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const [status, servers] = await Promise.all([
          devServerStatus ? devServerStatus(threadId) : Promise.resolve(null),
          listLocalServers ? listLocalServers(threadId) : Promise.resolve([]),
        ]);
        if (cancelled) return;
        setSuggestedUrl(pickSuggestedUrl(status, servers ?? []));
      } catch {
        if (!cancelled) setSuggestedUrl(null);
      }
    }
    void tick();
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [threadId, devServerStatus, listLocalServers]);

  useEffect(() => {
    autoLoaded.current = null;
    setBound(false);
    setAddress("");
    setDraft("");
    setError(null);
    setCapturing(false);
    setDiag(null);
    setViewportPreset("fill");
    setInspecting(false);
    setSavingAnnotation(false);
  }, [threadId]);

  // Diagnostics also carry the viewport preset, so an agent-driven resize
  // shows up in the picker.
  useEffect(() => {
    if (!bound || !preview) return;
    let cancelled = false;
    async function tick() {
      try {
        const d = await preview!.diagnostics({ threadId });
        if (cancelled) return;
        setDiag(d);
        setViewportPreset(d.viewportPreset);
      } catch {
        // pane closing; the next bind starts a fresh session
      }
    }
    void tick();
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [bound, preview, threadId]);

  useEffect(() => {
    return () => {
      captureGenRef.current += 1;
    };
  }, []);

  useEffect(() => {
    const el = webviewRef.current;
    if (!el || !preview) return;
    let cancelled = false;
    const tryBind = () => {
      const id = webContentsIdOf(el);
      if (id == null) return;
      void preview
        .bind({ threadId, webContentsId: id })
        .then((snap) => {
          if (cancelled) return;
          setBound(true);
          if (snap.url && snap.url !== "about:blank") applySnap(snap);
        })
        .catch((err) => {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : String(err));
          }
        });
    };
    el.addEventListener("did-attach", tryBind);
    tryBind();
    const onNav = () => {
      const any = el as unknown as {
        getURL?: () => string;
        canGoBack?: () => boolean;
        canGoForward?: () => boolean;
      };
      const url =
        typeof any.getURL === "function" ? String(any.getURL() || "") : "";
      setAddress(url === "about:blank" ? "" : url);
      setDraft(url === "about:blank" ? "" : url);
      setCanGoBack(Boolean(any.canGoBack?.()));
      setCanGoForward(Boolean(any.canGoForward?.()));
    };
    const invalidateInspect = (event?: Event) => {
      if (event && "isMainFrame" in event && event.isMainFrame === false) return;
      captureGenRef.current += 1;
      const session = inspectSession.current;
      inspectSession.current = null;
      setInspecting(false);
      setSavingAnnotation(false);
      if (session) void preview.cancelInspect({ threadId: session.threadId, sessionId: session.id }).catch(() => {});
    };
    el.addEventListener("did-start-navigation", invalidateInspect);
    el.addEventListener("did-navigate-in-page", invalidateInspect);
    el.addEventListener("did-navigate", onNav);
    el.addEventListener("did-navigate-in-page", onNav);
    el.addEventListener("did-stop-loading", onNav);
    return () => {
      cancelled = true;
      invalidateInspect();
      el.removeEventListener("did-start-navigation", invalidateInspect);
      el.removeEventListener("did-navigate-in-page", invalidateInspect);
      el.removeEventListener("did-attach", tryBind);
      el.removeEventListener("did-navigate", onNav);
      el.removeEventListener("did-navigate-in-page", onNav);
      el.removeEventListener("did-stop-loading", onNav);
      const id = webContentsIdOf(el);
      void preview.unbind({
        threadId,
        ...(id != null ? { webContentsId: id } : {}),
      });
    };
  }, [threadId, preview, applySnap]);

  const go = useCallback(
    async (raw: string) => {
      if (!preview) {
        setError("Preview needs the desktop app.");
        return;
      }
      const url = coercePreviewUrl(raw);
      if (!url) return;
      if (!isLoopbackPreviewUrl(url)) {
        setError("Preview only loads local URLs (localhost).");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const snap = await preview.navigate({ threadId, url });
        applySnap(snap);
        autoLoaded.current = snap.url || url;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [preview, threadId, applySnap],
  );

  useEffect(() => {
    if (!bound || !suggestedUrl) return;
    if (autoLoaded.current) return;
    if (address) return;
    autoLoaded.current = suggestedUrl;
    void go(suggestedUrl);
  }, [bound, suggestedUrl, address, go]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void go(draft || suggestedUrl || "");
  };

  const run = async (op: () => Promise<PreviewSnapshot>) => {
    setBusy(true);
    setError(null);
    try {
      applySnap(await op());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /** True while the pane still shows the thread and mount that asked. */
  const liveGuard = (originThreadId: string) => {
    const generation = captureGenRef.current;
    return () =>
      originThreadId === threadIdRef.current &&
      generation === captureGenRef.current;
  };

  const onScreenshot = async () => {
    if (!preview || !onAttachScreenshot) return;
    const originThreadId = threadId;
    const isLive = liveGuard(originThreadId);
    setCapturing(true);
    setError(null);
    try {
      const shot = await preview.screenshot({ threadId: originThreadId });
      if (!isLive()) return;
      applySnap(shot);
      await onAttachScreenshot(shot.dataUrl, originThreadId);
    } catch (err) {
      if (!isLive()) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (isLive()) setCapturing(false);
    }
  };

  // #1940: the agent and the composer get the bounded image; this saves the
  // un-resized original of the latest screenshot (yours or the agent's).
  const onSaveOriginal = async () => {
    if (!preview) return;
    setError(null);
    try {
      const shot = await preview.originalScreenshot({ threadId });
      const a = document.createElement("a");
      a.href = shot.dataUrl;
      a.download = shot.image
        ? `screenshot-${shot.image.width}x${shot.image.height}.png`
        : "screenshot.png";
      a.rel = "noopener";
      a.click();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onViewport = async (preset: PreviewViewportPreset) => {
    if (!preview) return;
    setViewportPreset(preset);
    setError(null);
    try {
      const res = await preview.viewport({ threadId, preset });
      setViewportPreset(res.viewport.preset);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const problems = diag
    ? diag.console.filter((c) => c.level === "error").length +
      diag.network.filter((n) => n.error || (n.status ?? 0) >= 400).length
    : 0;
  const cancelInspect = () => {
    const session = inspectSession.current;
    inspectSession.current = null;
    setInspecting(false);
    if (preview && session) void preview.cancelInspect({ threadId: session.threadId, sessionId: session.id }).catch(() => {});
  };

  const syncMarkers = async (session: { threadId: string; id: string }) => {
    const markers = getContextChips(session.threadId)
      .filter((chip) => chip.kind === "element")
      .slice(0, 100).map((chip, index) => ({ id: chip.id, number: index + 1 }));
    await preview?.annotations({ threadId: session.threadId, sessionId: session.id, markers });
  };

  useEffect(() => {
    const session = inspectSession.current;
    if (session) void syncMarkers(session).catch(() => {});
  }, [chips]);

  const onInspect = async () => {
    if (!preview || !onAttachElement) return;
    if (inspectSession.current) return cancelInspect();
    const session = { threadId, id: crypto.randomUUID() };
    const isLive = liveGuard(threadId);
    const active = () => isLive() && inspectSession.current === session;
    inspectSession.current = session;
    setInspecting(true);
    setError(null);
    webviewRef.current?.focus();
    try {
      while (active() && getContextChips(threadId).filter((chip) => chip.kind === "element").length < 100) {
        const annotationId = crypto.randomUUID();
        const res = await preview.inspect({ threadId, sessionId: session.id, annotationId });
        if (!active() || res.cancelled) break;
        setSavingAnnotation(true);
        await onAttachElement({ ...res, annotationId }, "", threadId);
        if (!active()) break;
        setSavingAnnotation(false);
        await syncMarkers(session);
      }
    } catch (err) {
      if (active()) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (active()) {
        inspectSession.current = null;
        setInspecting(false);
        setSavingAnnotation(false);
      }
      void preview.cancelInspect({ threadId, sessionId: session.id }).catch(() => {});
    }
  };

  const showEmpty = !address;
  const canShot = Boolean(preview && onAttachScreenshot && bound && address);
  const canInspect = Boolean(preview && onAttachElement && bound && address && annotations.length < 100);

  return (
    <div
      className={styles.pane}
      data-browser-pane=""
      onKeyDown={(e) => {
        if (inspecting && e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          cancelInspect();
        }
      }}
    >
      <div className={styles.toolbar} data-browser-toolbar="">
        <button
          type="button"
          className={styles.navBtn}
          data-browser-back=""
          aria-label="Back"
          disabled={!preview || !bound || !canGoBack || busy}
          onClick={() => void run(() => preview!.goBack({ threadId }))}
        >
          ←
        </button>
        <button
          type="button"
          className={styles.navBtn}
          data-browser-forward=""
          aria-label="Forward"
          disabled={!preview || !bound || !canGoForward || busy}
          onClick={() => void run(() => preview!.goForward({ threadId }))}
        >
          →
        </button>
        <button
          type="button"
          className={styles.navBtn}
          data-browser-reload=""
          aria-label="Reload"
          disabled={!preview || !bound || busy}
          onClick={() => void run(() => preview!.reload({ threadId }))}
        >
          ↻
        </button>
        <form className={styles.urlForm} onSubmit={onSubmit}>
          <input
            className={styles.url}
            data-browser-url=""
            aria-label="Preview URL"
            placeholder={suggestedUrl || "http://localhost:5173"}
            value={draft}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button
            type="submit"
            className={styles.go}
            data-browser-go=""
            disabled={busy || (!draft.trim() && !suggestedUrl)}
          >
            Go
          </button>
        </form>
        <select
          className={styles.viewport}
          data-browser-viewport=""
          aria-label="Viewport"
          value={viewportPreset}
          disabled={!preview || !bound}
          onChange={(e) => void onViewport(e.target.value as PreviewViewportPreset)}
        >
          {VIEWPORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={styles.go}
          data-browser-diagnostics-toggle=""
          aria-pressed={diagOpen}
          aria-expanded={diagOpen}
          data-problems={problems ? "true" : undefined}
          disabled={!preview}
          onClick={() => setDiagOpen((v) => !v)}
        >
          {problems ? `Diagnostics (${problems})` : "Diagnostics"}
        </button>
        {onAttachElement ? (
          <button
            type="button"
            className={styles.navBtn}
            data-browser-inspect=""
            aria-label={inspecting ? "Stop annotating" : "Annotate elements"}
            aria-pressed={inspecting}
            title="Pick several elements and add comments to the draft"
            disabled={!canInspect && !inspecting}
            onClick={() => void onInspect()}
          >
            ⌖
          </button>
        ) : null}
        <button
          type="button"
          className={styles.shot}
          data-browser-screenshot=""
          data-primary={canShot ? "true" : undefined}
          disabled={!canShot || capturing}
          onClick={() => void onScreenshot()}
        >
          {capturing ? "Capturing…" : "Add screenshot"}
        </button>
        <button
          type="button"
          className={styles.navBtn}
          data-browser-save-original=""
          aria-label="Save full-size screenshot"
          title="Save the latest screenshot at full resolution"
          disabled={!preview || !bound}
          onClick={() => void onSaveOriginal()}
        >
          ⤓
        </button>
        <button
          type="button"
          className={styles.navBtn}
          data-browser-external=""
          aria-label="Open in system browser"
          disabled={!address}
          onClick={() => {
            if (address) window.open(address);
          }}
        >
          ↗
        </button>
        {onSetBrowserAccess ? (
          <button
            type="button"
            className={styles.go}
            data-browser-access-toggle=""
            aria-pressed={browserAccess}
            title="Let the agent use this browser"
            onClick={() => void onSetBrowserAccess(!browserAccess)}
          >
            Let the agent use this browser
          </button>
        ) : null}
      </div>
      {error ? (
        <p className={styles.error} data-browser-error="" role="alert">
          {error}
        </p>
      ) : null}
      {diagOpen ? <DiagnosticsPanel diag={diag} /> : null}
      {inspecting ? (
        <p className={styles.hint} data-browser-inspect-hint="" role="status">
          {savingAnnotation ? "Saving element… " : "Click elements to add them to the draft. "}
          Tab and Enter also pick; ↑ picks a parent. Esc stops. Edit comments below.
        </p>
      ) : null}
      {annotations.length > 0 ? (
        <section className={styles.pick} data-browser-annotations="" aria-label="Browser annotations">
          <strong>{annotations.length} annotation{annotations.length === 1 ? "" : "s"} in the draft</strong>
          <ol className={styles.annotations}>
            {annotations.map((chip, index) => (
              <li key={chip.id} data-browser-annotation="">
                <div className={styles.pickHead}>
                  <strong className={styles.pickLabel}>{index + 1}. {chip.label}</strong>
                  <span className={styles.pickUrl} title={chip.url}>{chip.url}</span>
                  <button type="button" className={styles.go} aria-label={`Remove annotation ${index + 1}`}
                    onClick={() => setContextChips(threadId, (prev) => prev.filter((c) => c.id !== chip.id))}>Remove context</button>
                </div>
                <textarea className={styles.pickComment} data-browser-annotation-comment=""
                  aria-label={`Comment for annotation ${index + 1}`} placeholder="What should change? (optional)" rows={2}
                  value={chip.comment} onChange={(e) => {
                    const comment = e.target.value;
                    setContextChips(threadId, (prev) => prev.map((c) => c.id === chip.id ? { ...c, comment } : c));
                  }} />
                <details className={styles.pickDetails}>
                  <summary>Exact text added to the message</summary>
                  <pre data-browser-annotation-preview="">{elementChipPrompt(chip)}</pre>
                </details>
              </li>
            ))}
          </ol>
          <span className={styles.pickUrl}>Nothing sends until you send the composer. Crops are separate image attachments.</span>
        </section>
      ) : null}
      <div className={styles.stage}>
        {createElement("webview", {
          key: threadId,
          ref: webviewRef,
          className: styles.webview,
          "data-browser-webview": "",
          partition: `solenta-preview:${threadId}`,
          src: "about:blank",
          allowpopups: "false",
          webpreferences: "contextIsolation=yes, sandbox=yes, nodeIntegration=no",
        })}
        {showEmpty ? (
          <div className={styles.empty} data-browser-empty="">
            <p className={styles.emptyTitle}>Browser</p>
            <p className={styles.emptyHint}>
              {suggestedUrl
                ? "Loading the thread's local server…"
                : "Start the thread's dev server from Environment, or enter a local URL."}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
