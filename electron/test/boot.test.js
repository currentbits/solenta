"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { bootFirstPaint } = require("../boot.js");
const { Store } = require("../store.js");

function readMain() {
  return fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
}

describe("bootFirstPaint (#618)", () => {
  it("creates the window before a slow store load resolves", async () => {
    const order = [];
    let releaseStore;
    const gate = new Promise((r) => {
      releaseStore = r;
    });
    const done = bootFirstPaint({
      createWindow: () => order.push("window"),
      yieldPaint: async () => {},
      beforeStore: () => gate,
      startMemory: async () => {},
      loadStore: () => {
        order.push("store");
        return "STORE";
      },
    });
    assert.deepEqual(order, ["window"]);
    releaseStore();
    assert.equal(await done, "STORE");
    assert.ok(order.indexOf("window") < order.indexOf("store"));
  });

  it("does not delay createWindow when startMemory hangs", async () => {
    const order = [];
    const result = await Promise.race([
      bootFirstPaint({
        createWindow: () => order.push("window"),
        yieldPaint: async () => {},
        startMemory: () => new Promise(() => {}),
        loadStore: () => {
          order.push("store");
          return "ok";
        },
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("boot waited on memory")), 50),
      ),
    ]);
    assert.equal(result, "ok");
    assert.deepEqual(order, ["window", "store"]);
  });

  it("does not delay createWindow when startMemory rejects", async () => {
    const order = [];
    const errs = [];
    const store = await bootFirstPaint({
      createWindow: () => order.push("window"),
      yieldPaint: async () => {},
      startMemory: async () => {
        throw new Error("health timeout");
      },
      onMemoryError: (err) => errs.push(err),
      loadStore: () => {
        order.push("store");
        return "ok";
      },
    });
    assert.equal(store, "ok");
    assert.equal(order[0], "window");
    await new Promise((r) => setImmediate(r));
    assert.equal(errs.length, 1);
    assert.match(String(errs[0] && errs[0].message), /health timeout/);
  });

  it("writes .bak once per boot, after the window", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-boot-bak-"));
    const filePath = path.join(tmp, "coder-store.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        projects: [{ id: "p1", slug: "a/b", name: "b", path: "/x" }],
        threads: [],
        messagesByThread: {},
        workLogByThread: {},
      }),
      "utf8",
    );
    try {
      const store = await bootFirstPaint({
        createWindow: () => {
          assert.equal(fs.existsSync(`${filePath}.bak`), false);
        },
        yieldPaint: async () => {},
        startMemory: async () => {},
        loadStore: () => {
          assert.equal(fs.existsSync(`${filePath}.bak`), false);
          return new Store(filePath);
        },
      });
      assert.equal(
        fs.existsSync(`${filePath}.bak`),
        false,
        "bak must not land before bootFirstPaint returns",
      );
      await store._bakCopy;
      assert.equal(fs.existsSync(`${filePath}.bak`), true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not delay createWindow when startMemory throws synchronously", async () => {
    const order = [];
    const errs = [];
    const store = await bootFirstPaint({
      createWindow: () => order.push("window"),
      yieldPaint: async () => {},
      startMemory: () => {
        throw new Error("spawn failed");
      },
      onMemoryError: (err) => errs.push(err),
      loadStore: () => {
        order.push("store");
        return "ok";
      },
    });
    assert.equal(store, "ok");
    assert.deepEqual(order, ["window", "store"]);
    assert.equal(errs.length, 1);
  });
});

describe("main.js boot order (#618)", () => {
  it("opens the window through bootFirstPaint and does not await memory start", () => {
    const main = readMain();
    assert.match(main, /bootFirstPaint/);
    assert.match(main, /createWindow,/);
    assert.match(main, /startMemory:/);
    assert.match(main, /loadStore:/);
    assert.doesNotMatch(main, /await memorySupervisor\.start\(/);
    assert.match(main, /broadcast\("boot:ready"\)/);
    assert.ok(
      main.indexOf("registerIpc") < main.indexOf('broadcast("boot:ready")'),
      "boot:ready must fire after IPC handlers exist",
    );
  });
});
