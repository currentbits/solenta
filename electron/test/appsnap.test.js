const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const appsnap = require("../appsnap.js");

describe("appsnap", () => {
  afterEach(() => {
    appsnap.setGetSources(null);
  });

  it("lists named windows and skips blank ids", async () => {
    appsnap.setGetSources(async () => [
      { id: "window:1:0", name: "Finder" },
      { id: "", name: "ghost" },
      { id: "window:2:0", name: "  " },
      { id: "window:3:0", name: "Solenta" },
    ]);
    const { windows } = await appsnap.listWindows();
    assert.deepEqual(windows, [
      { id: "window:1:0", name: "Finder" },
      { id: "window:3:0", name: "Solenta" },
    ]);
  });

  it("captures the matching window PNG", async () => {
    const png = Buffer.from("png-bytes");
    appsnap.setGetSources(async () => [
      { id: "window:1:0", name: "Finder", thumbnail: { toPNG: () => png } },
    ]);
    const buf = await appsnap.captureWindowPng("window:1:0");
    assert.equal(buf, png);
  });

  it("rejects a vanished window", async () => {
    appsnap.setGetSources(async () => []);
    await assert.rejects(
      () => appsnap.captureWindowPng("window:9:0"),
      /no longer available/i,
    );
  });
});

describe("appsnap window text (#1531)", () => {
  const png = Buffer.from("png-bytes");
  const finder = [
    { id: "window:42:0", name: "Downloads", thumbnail: { toPNG: () => png } },
  ];
  const tree = {
    r: "AXWindow",
    t: "Downloads",
    c: [
      {
        r: "AXGroup",
        c: [
          { r: "AXButton", t: "Back", d: "Back" },
          { r: "AXTextField", v: "line one\nline two", d: "Search" },
          { r: "AXCheckBox", v: 1 },
        ],
      },
      { r: "AXStaticText", v: "3 items" },
    ],
  };
  const stubExec = (reply, seen = []) => (file, args, opts, cb) => {
    seen.push({ file, args, opts });
    if (reply instanceof Error) cb(reply, "", "");
    else cb(null, JSON.stringify(reply), "");
  };

  afterEach(() => {
    appsnap.setGetSources(null);
    appsnap.setExecFile(null);
  });

  it("flattens roles and text, dropping textless groups", () => {
    assert.equal(
      appsnap.flattenAxTree(tree),
      [
        'window "Downloads"',
        '  button "Back"',
        '  textfield "line one\\nline two" "Search"',
        '  checkbox "1"',
        '  statictext "3 items"',
      ].join("\n"),
    );
  });

  it("caps the text and notes the truncation", () => {
    const big = {
      r: "AXList",
      c: Array.from({ length: 50 }, (_, i) => ({
        r: "AXStaticText",
        v: `row ${i}`,
      })),
    };
    const text = appsnap.flattenAxTree(big, { maxChars: 100 });
    const lines = text.split("\n");
    assert.match(lines.at(-1), /truncated/);
    assert.ok(lines.slice(0, -1).join("\n").length <= 100);
    assert.equal(lines[0], 'statictext "row 0"');
    assert.match(
      appsnap.flattenAxTree({ r: "AXButton", t: "Ok" }, { truncated: true }),
      /^button "Ok"\n\[truncated/,
    );
  });

  it("attaches the AX text with the PNG on macOS", async () => {
    const seen = [];
    appsnap.setGetSources(async () => finder);
    appsnap.setExecFile(stubExec({ tree, truncated: false }, seen));
    const shot = await appsnap.captureWindow("window:42:0", {
      platform: "darwin",
    });
    assert.equal(shot.png, png);
    assert.equal(shot.name, "Downloads");
    assert.match(shot.text, /^window "Downloads"\n {2}button "Back"/);
    assert.equal(seen[0].file, "/usr/bin/osascript");
    assert.deepEqual(seen[0].args.slice(-3), ["42", "Downloads", "3000"]);
    assert.ok(seen[0].opts.timeout > 0);
  });

  it("keeps the PNG and gives a reason without Accessibility", async () => {
    appsnap.setGetSources(async () => finder);
    appsnap.setExecFile(stubExec({ error: "untrusted" }));
    const shot = await appsnap.captureWindow("window:42:0", {
      platform: "darwin",
    });
    assert.equal(shot.png, png);
    assert.equal(shot.text, undefined);
    assert.match(shot.textSkipped, /Accessibility/);
    assert.doesNotMatch(shot.textSkipped, /\n/);
  });

  it("keeps the PNG when osascript fails or times out", async () => {
    appsnap.setGetSources(async () => finder);
    const killed = Object.assign(new Error("timeout"), { killed: true });
    appsnap.setExecFile(stubExec(killed));
    const shot = await appsnap.captureWindow("window:42:0", {
      platform: "darwin",
    });
    assert.equal(shot.png, png);
    assert.match(shot.textSkipped, /timed out/);
    appsnap.setExecFile(stubExec(new Error("boom")));
    assert.match(
      (await appsnap.readWindowText("window:42:0", "x", { platform: "darwin" }))
        .skipped,
      /failed/,
    );
  });

  it("skips silently off macOS without running osascript", async () => {
    const seen = [];
    appsnap.setGetSources(async () => finder);
    appsnap.setExecFile(stubExec({ tree }, seen));
    const shot = await appsnap.captureWindow("window:42:0", {
      platform: "win32",
    });
    assert.deepEqual(shot, { png, name: "Downloads" });
    assert.equal(seen.length, 0);
  });
});
