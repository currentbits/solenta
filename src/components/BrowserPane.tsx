import {
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type {
  CoderApi,
  DevServerState,
  LocalServerInfo,
  PreviewSnapshot,
} from "../shared/ipc";
import {
  elementChip,
  elementChipPrompt,
  type InspectPick,
} from "../contextChips";
import { coercePreviewUrl, isLoopbackPreviewUrl } from "../previewUrl";
import styles from "./BrowserPane.module.css";

const POLL_MS = 3_000;

type PreviewApi = CoderApi["preview"];

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
  const [inspecting, setInspecting] = useState(false);
  const [picked, setPicked] = useState<{
    threadId: string;
    pick: InspectPick;
    comment: string;
  } | null>(null);
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
    setInspecting(false);
    setPicked(null);
  }, [threadId]);

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
    el.addEventListener("did-navigate", onNav);
    el.addEventListener("did-navigate-in-page", onNav);
    el.addEventListener("did-stop-loading", onNav);
    return () => {
      cancelled = true;
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

  const cancelInspect = () => {
    if (preview) void preview.cancelInspect({ threadId }).catch(() => {});
  };

  const onInspect = async () => {
    if (!preview) return;
    if (inspecting) return cancelInspect();
    const originThreadId = threadId;
    const isLive = liveGuard(originThreadId);
    setInspecting(true);
    setPicked(null);
    setError(null);
    // Keys go to the guest, so Tab/Enter/Escape drive the picker there.
    webviewRef.current?.focus();
    try {
      const res = await preview.inspect({ threadId: originThreadId });
      if (!isLive() || res.cancelled) return;
      setPicked({ threadId: originThreadId, pick: res, comment: "" });
    } catch (err) {
      if (isLive()) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (isLive()) setInspecting(false);
    }
  };

  const addPicked = () => {
    if (!picked || !onAttachElement) return;
    setPicked(null);
    void onAttachElement(picked.pick, picked.comment.trim(), picked.threadId);
  };

  const showEmpty = !address;
  const canShot = Boolean(preview && onAttachScreenshot && bound && address);
  const canInspect = Boolean(preview && onAttachElement && bound && address);
  const pickedChip = picked
    ? elementChip(
        "preview",
        picked.threadId,
        picked.pick,
        Boolean(picked.pick.crop),
        picked.comment.trim(),
      )
    : null;

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
        {onAttachElement ? (
          <button
            type="button"
            className={styles.navBtn}
            data-browser-inspect=""
            aria-label="Inspect element"
            aria-pressed={inspecting}
            title="Inspect: pick an element to send as context"
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
          data-browser-external=""
          aria-label="Open in system browser"
          disabled={!address}
          onClick={() => {
            if (address) window.open(address);
          }}
        >
          ↗
        </button>
      </div>
      {error ? (
        <p className={styles.error} data-browser-error="" role="alert">
          {error}
        </p>
      ) : null}
      {inspecting ? (
        <p className={styles.hint} data-browser-inspect-hint="" role="status">
          Click an element, or Tab to one and press Enter. ↑ picks its parent.
          Esc cancels.
        </p>
      ) : null}
      {picked && pickedChip ? (
        <section
          className={styles.pick}
          data-browser-pick=""
          aria-label="Selected element"
        >
          <div className={styles.pickHead}>
            <strong className={styles.pickLabel}>{pickedChip.label}</strong>
            <span className={styles.pickUrl} title={picked.pick.url}>
              {picked.pick.url}
            </span>
          </div>
          <div className={styles.pickBody}>
            {picked.pick.crop ? (
              <img
                className={styles.pickCrop}
                data-browser-pick-crop=""
                src={picked.pick.crop}
                alt={`Crop of ${pickedChip.label}`}
              />
            ) : null}
            <textarea
              className={styles.pickComment}
              data-browser-pick-comment=""
              aria-label="Comment for the agent"
              placeholder="What should change? (optional)"
              rows={2}
              value={picked.comment}
              onChange={(e) => {
                const comment = e.target.value;
                setPicked((p) => (p ? { ...p, comment } : p));
              }}
            />
          </div>
          <div className={styles.pickActions}>
            <button
              type="button"
              className={styles.shot}
              data-primary="true"
              data-browser-pick-add=""
              onClick={addPicked}
            >
              Add to composer
            </button>
            <button
              type="button"
              className={styles.go}
              data-browser-pick-discard=""
              onClick={() => setPicked(null)}
            >
              Discard
            </button>
          </div>
          <details className={styles.pickDetails}>
            <summary>Exact text added to the message</summary>
            <pre data-browser-pick-preview="">
              {elementChipPrompt(pickedChip)}
            </pre>
          </details>
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
