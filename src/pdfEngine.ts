// pdf.js for the Files pane PDF viewer (#1938). A lazy chunk: pdf.js only
// loads the first time a PDF is opened. Parsing runs in pdf.js's worker so a
// large or broken document never blocks the UI thread.
//
// Ownership: each open document gets its own worker, and destroy() tears both
// down, so the preview that opened a document is its only cache.
// ponytail: no shared worker or cross-mount document cache; add one if
// profiling shows reopen cost matters.
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PdfDoc } from "./components/PdfPreview";

GlobalWorkerOptions.workerSrc = workerUrl;

/** CSS px per PDF point, so zoom 1 is the page's printed size. */
const CSS_PER_PT = 96 / 72;

export async function openPdf(data: Uint8Array): Promise<PdfDoc> {
  // ponytail: no cMapUrl/standardFontDataUrl/wasmUrl, so CJK cmaps, unembedded
  // standard fonts and JPX images degrade; ship those assets if users hit it.
  const task = getDocument({ data, verbosity: 0 });
  const [doc, first] = await task.promise
    .then(async (d) => [d, (await d.getPage(1)).getViewport({ scale: CSS_PER_PT })] as const)
    .catch((err) => {
      void task.destroy();
      throw err;
    });
  return {
    numPages: doc.numPages,
    pageWidth: first.width,
    render(n, zoom, canvas) {
      let cancelled = false;
      let cancel = () => {};
      const promise = doc.getPage(n).then(async (page) => {
        if (cancelled) return;
        const dpr = window.devicePixelRatio || 1;
        const vp = page.getViewport({ scale: zoom * CSS_PER_PT * dpr });
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        canvas.style.width = `${Math.floor(vp.width / dpr)}px`;
        canvas.style.height = `${Math.floor(vp.height / dpr)}px`;
        const task = page.render({ canvas, viewport: vp });
        cancel = () => task.cancel();
        await task.promise;
      });
      return {
        promise,
        cancel() {
          cancelled = true;
          cancel();
        },
      };
    },
    destroy() {
      void task.destroy();
    },
  };
}
