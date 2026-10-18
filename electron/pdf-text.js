"use strict";

/**
 * Child-process PDF text extractor for attachments.js (#466). Runs under
 * ELECTRON_RUN_AS_NODE so pdfjs parsing never blocks the main process and
 * the parent's execFile timeout can kill it. Usage:
 *   pdf-text.js <file.pdf> <maxPages>
 * Prints each page's text followed by "\n\f".
 */
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

async function main() {
  const [file, maxArg] = process.argv.slice(2);
  // The packaged bundle keeps only the two minified files (package-app.sh).
  const pdfjs = await import(
    pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.min.mjs")).href
  );
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
    require.resolve("pdfjs-dist/legacy/build/pdf.worker.min.mjs"),
  ).href;
  const task = pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(file)),
    isEvalSupported: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  const n = Math.min(doc.numPages, Number(maxArg) || 0);
  for (let i = 1; i <= n; i++) {
    const { items } = await (await doc.getPage(i)).getTextContent();
    const text = items
      .map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : "") : ""))
      .join("");
    process.stdout.write(text + "\n\f");
  }
  await task.destroy();
}

main().catch((err) => {
  process.stderr.write(String((err && err.message) || err));
  process.exitCode = 1;
});
