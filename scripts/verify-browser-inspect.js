// Verify the Browser pane element inspector (#1193) in real Electron: a
// synthetic click on a submit button picks it without submitting the form,
// the reported rect matches the layout, and the crop is cut from the right
// place (inner pixels are the button's red, padding is the page's white), at
// zoom 1 and 1.5. Escape cancels. Unit tests cannot see any of this.
//
//   npx electron scripts/verify-browser-inspect.js
"use strict";
const { app, BrowserWindow, nativeImage } = require("electron");
const preview = require("../electron/preview.js");

app.setPath(
  "userData",
  require("node:fs").mkdtempSync(
    require("node:path").join(require("node:os").tmpdir(), "solenta-inspect-verify-"),
  ),
);

const PAGE = `<!doctype html><html><body style="margin:0;background:#fff">
<form id="f" onsubmit="document.title='SUBMITTED';return false">
  <button id="go" type="submit" style="position:absolute;left:200px;top:150px;width:160px;height:48px;border:0;background:#f00">Sign in</button>
</form></body></html>`;

const failures = [];
function check(label, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pixel(image, fx, fy) {
  const { width, height } = image.getSize();
  const bmp = image.toBitmap(); // BGRA
  const x = Math.min(width - 1, Math.floor(width * fx));
  const y = Math.min(height - 1, Math.floor(height * fy));
  const i = (y * width + x) * 4;
  return { r: bmp[i + 2], g: bmp[i + 1], b: bmp[i] };
}

async function pickByClick(wc, x, y) {
  const pending = preview.inspect({ threadId: "verify" });
  await sleep(300);
  wc.sendInputEvent({ type: "mouseMove", x, y });
  wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
  wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
  return pending;
}

async function verifyAt(wc, zoom) {
  wc.setZoomFactor(zoom);
  await sleep(300);
  // Button centre in CSS px is (280, 174); input events are in DIP.
  const res = await pickByClick(wc, Math.round(280 * zoom), Math.round(174 * zoom));
  const tag = `zoom ${zoom}`;
  check(`${tag}: picked the button`, !res.cancelled && res.element.tag === "button",
    res.cancelled ? "cancelled" : `${res.element.tag} "${res.element.name}"`);
  if (res.cancelled) return;
  const r = res.element.rect;
  check(`${tag}: rect matches layout`, r.x === 200 && r.y === 150 && r.width === 160 && r.height === 48,
    JSON.stringify(r));
  const expected = {
    x: Math.floor(192 * zoom),
    y: Math.floor(142 * zoom),
    width: Math.ceil(176 * zoom),
    height: Math.ceil(64 * zoom),
  };
  check(`${tag}: crop rect is the padded element in DIP`,
    JSON.stringify(res.cropRect) === JSON.stringify(expected), JSON.stringify(res.cropRect));
  check(`${tag}: crop captured`, typeof res.crop === "string", res.cropNote);
  if (!res.crop) return;
  const img = nativeImage.createFromDataURL(res.crop);
  const size = img.getSize();
  const ratio = size.width / size.height;
  check(`${tag}: crop aspect matches`, Math.abs(ratio - expected.width / expected.height) < 0.05,
    `${size.width}x${size.height}`);
  check(`${tag}: crop within 800px`, size.width <= 800 && size.height <= 800);
  // Either side of the centred label: the button's red fill.
  for (const fx of [0.12, 0.88]) {
    const fill = pixel(img, fx, 0.5);
    // Colour management shifts #f00 (e.g. to 224,64,26); still clearly red.
    check(`${tag}: crop at x=${fx} is the button`, fill.r > 180 && fill.g < 110 && fill.b < 110,
      JSON.stringify(fill));
  }
  const corner = pixel(img, 0.01, 0.02);
  check(`${tag}: crop padding is page background`, corner.r > 200 && corner.g > 200 && corner.b > 200,
    JSON.stringify(corner));
  const title = await wc.executeJavaScript("document.title");
  check(`${tag}: form was not submitted`, title !== "SUBMITTED", title);
  const overlay = await wc.executeJavaScript("document.body.lastElementChild.id");
  check(`${tag}: overlay removed`, overlay === "f", String(overlay));
}

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      webPreferences: { sandbox: true, contextIsolation: true, partition: "solenta-preview:verify" },
    });
    const wc = win.webContents;
    await wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
    preview.setWebContentsLookup((id) => (id === wc.id ? wc : null));
    preview.bind({ threadId: "verify", webContentsId: wc.id });

    await verifyAt(wc, 1);
    await verifyAt(wc, 1.5);

    wc.setZoomFactor(1);
    const pending = preview.inspect({ threadId: "verify" });
    await sleep(300);
    wc.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    const res = await Promise.race([pending, sleep(3000).then(() => ({ timeout: true }))]);
    check("Escape cancels", res.cancelled === true, JSON.stringify(res).slice(0, 80));
  } catch (err) {
    check("no exceptions", false, err && err.stack);
  }
  console.log(failures.length ? "BROWSER-INSPECT-VERIFY-FAILED" : "BROWSER-INSPECT-VERIFY-OK");
  app.exit(failures.length ? 1 : 0);
});
