import { useEffect, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { useEscapeClose } from "../../useEscapeClose";
import { useModalFocus } from "../../useModalFocus";
import styles from "./ImageMarkup.module.css";

type Point = { x: number; y: number };
export type Mark =
  | { kind: "pin"; x: number; y: number; text: string }
  | { kind: "stroke"; points: Point[] };
export type Rect = { x: number; y: number; w: number; h: number };
type Tool = "pin" | "draw" | "crop";

const INK = "#ff3b30";

/** Drag corners in any direction to a positive rect clamped to the image. */
export function normalizeRect(a: Point, b: Point, w: number, h: number): Rect {
  const x0 = Math.max(0, Math.min(a.x, b.x));
  const y0 = Math.max(0, Math.min(a.y, b.y));
  const x1 = Math.min(w, Math.max(a.x, b.x));
  const y1 = Math.min(h, Math.max(a.y, b.y));
  return {
    x: Math.round(x0),
    y: Math.round(y0),
    w: Math.round(Math.max(0, x1 - x0)),
    h: Math.round(Math.max(0, y1 - y0)),
  };
}

/** Prompt text for the numbered pins that carry a note; "" when none do. */
export function markupNotes(name: string, marks: Mark[]): string {
  const lines: string[] = [];
  let n = 0;
  for (const m of marks) {
    if (m.kind !== "pin") continue;
    n += 1;
    if (m.text.trim()) lines.push(`${n}. ${m.text.trim()}`);
  }
  return lines.length
    ? `Markup on ${name} (numbered red pins):\n${lines.join("\n")}`
    : "";
}

/** Draws strokes and numbered pins in image pixel space. */
function paintMarks(ctx: CanvasRenderingContext2D, marks: Mark[], size: number) {
  const line = Math.max(3, size / 300);
  const r = Math.max(12, size / 80);
  ctx.strokeStyle = INK;
  ctx.lineWidth = line;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  let n = 0;
  for (const m of marks) {
    if (m.kind === "stroke") {
      ctx.beginPath();
      m.points.forEach((p, i) =>
        i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y),
      );
      if (m.points.length === 1) ctx.lineTo(m.points[0].x, m.points[0].y);
      ctx.stroke();
      continue;
    }
    n += 1;
    ctx.beginPath();
    ctx.arc(m.x, m.y, r, 0, Math.PI * 2);
    ctx.fillStyle = INK;
    ctx.fill();
    ctx.lineWidth = Math.max(2, r / 6);
    ctx.strokeStyle = "#fff";
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${Math.round(r * 1.1)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(n), m.x, m.y + 1);
    ctx.strokeStyle = INK;
    ctx.lineWidth = line;
  }
}

/**
 * Pin / draw / crop on a still image before it is sent (issue #460). Save
 * flattens the markup into a PNG so every provider sees it, and returns the
 * pin notes as prompt text.
 */
export function ImageMarkup({
  src,
  name,
  onCancel,
  onSave,
}: {
  src: string;
  name: string;
  onCancel: () => void;
  onSave: (dataUrl: string, notes: string) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [tool, setTool] = useState<Tool>("pin");
  const [marks, setMarks] = useState<Mark[]>([]);
  const [crop, setCrop] = useState<Rect | null>(null);
  const dragRef = useRef<Point | null>(null);
  const [focusPin, setFocusPin] = useState<number | null>(null);
  useEscapeClose(true, onCancel);
  useModalFocus(true, dialogRef);

  useEffect(() => {
    const el = new Image();
    el.onload = () => setImg(el);
    el.src = src;
  }, [src]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !img) return;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(img, 0, 0);
    paintMarks(ctx, marks, Math.max(w, h));
    if (crop && crop.w && crop.h) {
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.beginPath();
      ctx.rect(0, 0, w, h);
      ctx.rect(crop.x, crop.y, crop.w, crop.h);
      ctx.fill("evenodd");
    }
  }, [img, marks, crop]);

  const toImage = (e: PointerEvent<HTMLCanvasElement>): Point => {
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) * canvas.width) / (rect.width || 1),
      y: ((e.clientY - rect.top) * canvas.height) / (rect.height || 1),
    };
  };

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!img || e.button !== 0) return;
    const p = toImage(e);
    if (tool === "pin") {
      const index = marks.filter((m) => m.kind === "pin").length;
      setMarks((prev) => [...prev, { kind: "pin", ...p, text: "" }]);
      setFocusPin(index);
      return;
    }
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = p;
    if (tool === "draw") {
      setMarks((prev) => [...prev, { kind: "stroke", points: [p] }]);
    } else {
      setCrop(null);
    }
  };

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const start = dragRef.current;
    if (!start || !img) return;
    const p = toImage(e);
    if (tool === "draw") {
      setMarks((prev) => {
        const last = prev[prev.length - 1];
        if (last?.kind !== "stroke") return prev;
        return [
          ...prev.slice(0, -1),
          { kind: "stroke", points: [...last.points, p] },
        ];
      });
    } else if (tool === "crop") {
      setCrop(normalizeRect(start, p, img.naturalWidth, img.naturalHeight));
    }
  };

  const onPointerUp = () => {
    dragRef.current = null;
    // A click without a drag is not a crop.
    setCrop((c) => (c && c.w > 4 && c.h > 4 ? c : null));
  };

  const save = () => {
    if (!img) return;
    const area = crop ?? {
      x: 0,
      y: 0,
      w: img.naturalWidth,
      h: img.naturalHeight,
    };
    const out = document.createElement("canvas");
    out.width = area.w;
    out.height = area.h;
    const ctx = out.getContext("2d");
    if (!ctx) return;
    ctx.translate(-area.x, -area.y);
    ctx.drawImage(img, 0, 0);
    paintMarks(ctx, marks, Math.max(img.naturalWidth, img.naturalHeight));
    onSave(out.toDataURL("image/png"), markupNotes(name, marks));
  };

  const pins = marks.flatMap((m, i) => (m.kind === "pin" ? [{ m, i }] : []));
  const edited = marks.length > 0 || crop !== null;

  // Portal: a transformed composer ancestor would trap position: fixed.
  return createPortal(
    <div className={styles.backdrop} onClick={onCancel}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={`Mark up ${name}`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.toolbar} role="toolbar" aria-label="Markup tools">
          {(
            [
              ["pin", "Pin", "Click to drop a numbered pin"],
              ["draw", "Draw", "Drag to draw freehand"],
              ["crop", "Crop", "Drag to keep a region"],
            ] as const
          ).map(([id, label, hint]) => (
            <button
              key={id}
              type="button"
              className={styles.tool}
              aria-pressed={tool === id}
              title={hint}
              onClick={() => setTool(id)}
            >
              {label}
            </button>
          ))}
          <span className={styles.spacer} />
          <button
            type="button"
            className={styles.tool}
            disabled={marks.length === 0}
            onClick={() => setMarks((prev) => prev.slice(0, -1))}
          >
            Undo
          </button>
          <button
            type="button"
            className={styles.tool}
            disabled={!edited}
            onClick={() => {
              setMarks([]);
              setCrop(null);
            }}
          >
            Clear
          </button>
        </div>
        <div className={styles.body}>
          <div className={styles.stage}>
            <canvas
              ref={canvasRef}
              className={styles.canvas}
              data-tool={tool}
              aria-label={name}
              // Keep focus on the new pin's note: mousedown would move it to the dialog.
              onMouseDown={(e) => e.preventDefault()}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
          </div>
          {pins.length > 0 && (
            <ol className={styles.pins} aria-label="Pin notes">
              {pins.map(({ m, i }, n) => (
                <li key={i} className={styles.pinRow}>
                  <span className={styles.pinBadge}>{n + 1}</span>
                  <input
                    className={styles.pinInput}
                    aria-label={`Note for pin ${n + 1}`}
                    placeholder="What's wrong here?"
                    value={m.kind === "pin" ? m.text : ""}
                    autoFocus={focusPin === n}
                    onChange={(e) => {
                      const text = e.target.value;
                      setMarks((prev) =>
                        prev.map((x, j) =>
                          j === i && x.kind === "pin" ? { ...x, text } : x,
                        ),
                      );
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        save();
                      }
                    }}
                  />
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={styles.primary}
            disabled={!img || !edited}
            onClick={save}
          >
            Save markup
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
