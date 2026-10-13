import { useEffect, useState } from "react";
import type {
  DiffScope,
  FileChange,
  ImageDiffInput,
  ImageDiffResult,
  ImageDiffSide,
} from "../../shared/ipc";
import { formatBytes } from "../../format";
import styles from "../ThreadView.module.css";

/** Rasters the host can size from the header (#1192). SVG keeps its text diff. */
export const isImagePath = (path: string) =>
  /\.(png|apng|jpe?g|gif|webp|bmp)$/i.test(path);

type Zoom = "fit" | 1 | 2;
const ZOOMS: Array<{ id: Zoom; label: string }> = [
  { id: "fit", label: "Fit" },
  { id: 1, label: "100%" },
  { id: 2, label: "200%" },
];

function Side({
  title,
  side,
  missing,
  zoom,
}: {
  title: string;
  side: ImageDiffSide;
  missing: string;
  zoom: Zoom;
}) {
  const meta = [
    side.width && side.height ? `${side.width} × ${side.height}` : "",
    side.bytes != null ? formatBytes(side.bytes) : "",
  ].filter(Boolean);
  return (
    <figure className={styles.imageSide} data-image-side={title.toLowerCase()}>
      <figcaption className={styles.imageSideHead}>
        <strong>{title}</strong>
        <span className={styles.imageSideRef}>{side.label}</span>
        {meta.length ? <span className={styles.imageSideMeta}>{meta.join(" · ")}</span> : null}
      </figcaption>
      <div className={styles.imageStage} data-zoom={zoom}>
        {!side.exists ? (
          <p className={styles.imageMissing}>{missing}</p>
        ) : side.dataUrl ? (
          <img
            src={side.dataUrl}
            alt={`${title}: ${side.label}`}
            draggable={false}
            style={zoom === "fit" ? undefined : { width: (side.width ?? 0) * zoom }}
          />
        ) : (
          <p className={styles.imageMissing}>{side.note ?? "No preview"}</p>
        )}
      </div>
    </figure>
  );
}

/**
 * Before/after of one changed image. `reloadKey` changes on every diff
 * load, so Refresh and commits re-read; a newer key or thread drops the
 * older read.
 */
export function ImageDiff({
  threadId,
  scope,
  file,
  reloadKey,
  onFetch,
}: {
  threadId: string | null;
  scope: DiffScope;
  file: FileChange;
  reloadKey: unknown;
  onFetch: (input: ImageDiffInput) => Promise<ImageDiffResult>;
}) {
  const [result, setResult] = useState<ImageDiffResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<Zoom>("fit");

  useEffect(() => {
    if (!threadId) return;
    let live = true;
    setResult(null);
    setError(null);
    onFetch({
      scope,
      path: file.path,
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
    }).then(
      (r) => {
        if (live) setResult(r);
      },
      (err: unknown) => {
        if (live) {
          setError(err instanceof Error && err.message ? err.message : "Failed to load images");
        }
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onFetch is a fresh closure per render
  }, [threadId, scope, file.path, file.oldPath, reloadKey]);

  if (error) {
    return (
      <p className={styles.inlineError} role="alert">
        {error}
      </p>
    );
  }
  if (!result) return <p className={styles.changesEmpty}>Loading images…</p>;
  return (
    <div data-image-diff={file.path}>
      <div className={styles.imageDiffBar}>
        <span className={styles.hunkPath}>
          {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        <div className={styles.diffSeg} role="group" aria-label="Image zoom">
          {ZOOMS.map((z) => (
            <button
              key={z.label}
              type="button"
              className={styles.diffSegBtn}
              data-image-zoom={z.label}
              aria-pressed={zoom === z.id}
              onClick={() => setZoom(z.id)}
            >
              {z.label}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.imageDiffSides}>
        <Side
          title="Before"
          side={result.before}
          missing={`Not in ${result.before.label}: added`}
          zoom={zoom}
        />
        <Side
          title="After"
          side={result.after}
          missing={`Not in ${result.after.label}: deleted`}
          zoom={zoom}
        />
      </div>
    </div>
  );
}
