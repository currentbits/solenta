// Files pane PDF viewer (#1938): one page at a time on a canvas, with page
// and zoom controls. pdf.js loads lazily (src/pdfEngine.ts) and parses in its
// worker; the page/zoom the reader lands on goes back out through onView so
// the pane can restore it after a thread switch.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import styles from "./FilesPane.module.css";

export interface PdfDoc {
  numPages: number;
  /** CSS px width of page 1 at zoom 1, for fit-to-width. */
  pageWidth: number;
  render(
    page: number,
    zoom: number,
    canvas: HTMLCanvasElement,
  ): { promise: Promise<void>; cancel(): void };
  destroy(): void;
}

export type PdfView = { page: number; zoom: number };

/** Swappable so tests run without pdf.js or a canvas. */
export const pdfEngine = {
  open: (data: Uint8Array): Promise<PdfDoc> =>
    import("../pdfEngine").then((m) => m.openPdf(data)),
};

const ZOOMS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const clampZoom = (z: number) => Math.min(4, Math.max(0.25, z));

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function PdfPreview({
  data,
  view,
  onView,
}: {
  /** File bytes, base64 (FilePreview kind "pdf"). */
  data: string;
  /** Where the reader was last time; null opens page 1 fit to width. */
  view: PdfView | null;
  onView: (view: PdfView) => void;
}) {
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [page, setPage] = useState(view?.page ?? 1);
  const [zoom, setZoom] = useState<number | null>(view?.zoom ?? null);
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const fitZoom = (d: PdfDoc) => {
    const width = (boxRef.current?.clientWidth ?? 0) - 32;
    return width > 0 && d.pageWidth > 0
      ? clampZoom(Math.floor((width / d.pageWidth) * 100) / 100)
      : 1;
  };

  useEffect(() => {
    let live = true;
    let opened: PdfDoc | null = null;
    Promise.resolve()
      .then(() => pdfEngine.open(decodeBase64(data)))
      .then(
        (d) => {
          if (!live) return d.destroy();
          opened = d;
          setDoc(d);
          setZoom((z) => z ?? fitZoom(d));
        },
        (err) => live && setError(errorText(err)),
      );
    return () => {
      live = false;
      opened?.destroy();
    };
    // fitZoom only reads refs.
  }, [data]);

  // A file that shrank since it was last read keeps the reader in range.
  const n = doc ? Math.min(Math.max(1, page), doc.numPages) : page;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!doc || zoom == null || !canvas) return;
    setRenderError(null);
    const job = doc.render(n, zoom, canvas);
    job.promise.catch((err: unknown) => {
      if ((err as { name?: string })?.name !== "RenderingCancelledException") {
        setRenderError(errorText(err));
      }
    });
    return () => job.cancel();
  }, [doc, n, zoom]);

  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = 0;
  }, [n]);

  useEffect(() => {
    if (doc && zoom != null) onView({ page: n, zoom });
  }, [doc, n, zoom, onView]);

  if (error) {
    return (
      <div className={styles.empty} role="alert" data-files-pdf-error="">
        Could not open this PDF: {error}
      </div>
    );
  }
  const total = doc?.numPages ?? 0;
  const z = zoom ?? 1;
  const go = (to: number) => setPage(Math.min(Math.max(1, to), total || 1));
  const zoomIn = () => setZoom(ZOOMS.find((s) => s > z + 0.001) ?? 4);
  const zoomOut = () => setZoom([...ZOOMS].reverse().find((s) => s < z - 0.001) ?? 0.25);

  const onKeyDown = (e: KeyboardEvent) => {
    if (!doc) return;
    if (e.key === "ArrowLeft" || e.key === "PageUp") go(n - 1);
    else if (e.key === "ArrowRight" || e.key === "PageDown") go(n + 1);
    else if (e.key === "Home") go(1);
    else if (e.key === "End") go(total);
    else if (e.key === "+" || e.key === "=") zoomIn();
    else if (e.key === "-") zoomOut();
    else return;
    e.preventDefault();
  };

  return (
    <div className={styles.pdf} data-files-pdf="">
      <div className={styles.toolbar} data-files-pdf-bar="">
        <button
          type="button"
          className={styles.textBtn}
          aria-label="Previous page"
          disabled={!doc || n <= 1}
          onClick={() => go(n - 1)}
          data-files-pdf-prev=""
        >
          ‹
        </button>
        <span className={styles.size} aria-live="polite" data-files-pdf-page="">
          {doc ? `${n} / ${total}` : "Loading PDF…"}
        </span>
        <button
          type="button"
          className={styles.textBtn}
          aria-label="Next page"
          disabled={!doc || n >= total}
          onClick={() => go(n + 1)}
          data-files-pdf-next=""
        >
          ›
        </button>
        <span className={styles.pdfSpacer} />
        <button
          type="button"
          className={styles.textBtn}
          aria-label="Zoom out"
          disabled={!doc || z <= 0.25}
          onClick={zoomOut}
          data-files-pdf-zoom-out=""
        >
          −
        </button>
        <span className={styles.size} data-files-pdf-zoom="">
          {Math.round(z * 100)}%
        </span>
        <button
          type="button"
          className={styles.textBtn}
          aria-label="Zoom in"
          disabled={!doc || z >= 4}
          onClick={zoomIn}
          data-files-pdf-zoom-in=""
        >
          +
        </button>
        <button
          type="button"
          className={styles.textBtn}
          disabled={!doc}
          onClick={() => doc && setZoom(fitZoom(doc))}
          data-files-pdf-fit=""
        >
          Fit width
        </button>
      </div>
      {renderError ? (
        <div className={styles.notice} role="alert">
          Could not draw page {n}: {renderError}
        </div>
      ) : null}
      <div
        ref={boxRef}
        className={styles.pdfPages}
        tabIndex={0}
        role="document"
        aria-label={doc ? `PDF page ${n} of ${total}` : "PDF loading"}
        onKeyDown={onKeyDown}
      >
        <canvas ref={canvasRef} className={styles.pdfCanvas} data-files-pdf-canvas="" />
      </div>
    </div>
  );
}
