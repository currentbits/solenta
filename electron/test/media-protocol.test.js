const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  SCHEME,
  toolImageUrl,
  localImageUrl,
  artifactUrl,
  parseMediaUrl,
  resolveMediaUrl,
  installHandler,
} = require("../media-protocol.js");
const { saveToolImages, extractImages } = require("../tool-images.js");
const attachments = require("../attachments.js");

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("solenta-media protocol", () => {
  let dir;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-media-"));
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("builds and parses tool and local URLs", () => {
    assert.equal(toolImageUrl("shot.png"), `${SCHEME}://tool/shot.png`);
    assert.equal(
      toolImageUrl("tid/shot.png"),
      `${SCHEME}://tool/tid/shot.png`,
    );
    assert.deepEqual(parseMediaUrl(`${SCHEME}://tool/tid/shot.png`), {
      kind: "tool",
      name: "tid/shot.png",
    });

    const abs = path.join(dir, "pic.png");
    const url = localImageUrl(abs);
    assert.ok(url.startsWith(`${SCHEME}://local/?p=`));
    assert.deepEqual(parseMediaUrl(url), { kind: "local", path: abs });
  });

  it("rejects other hosts, credentials, and junk", () => {
    assert.equal(parseMediaUrl("https://tool/shot.png"), null);
    assert.equal(parseMediaUrl(`${SCHEME}://evil/shot.png`), null);
    assert.equal(parseMediaUrl(`${SCHEME}://user:pass@tool/shot.png`), null);
    assert.equal(parseMediaUrl("not a url"), null);
    assert.equal(toolImageUrl("../x.png"), null);
    assert.equal(toolImageUrl(""), null);
  });

  it("resolves a saved tool image and 404s traversal", async () => {
    const [name] = saveToolImages(
      dir,
      extractImages([
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: PNG_B64 },
        },
      ]),
      "t1",
    );
    const resolved = await resolveMediaUrl(toolImageUrl(name), dir);
    assert.ok(resolved);
    assert.equal(
      resolved.path,
      path.join(dir, "tool-images", ...name.split("/")),
    );

    assert.equal(
      await resolveMediaUrl(`${SCHEME}://tool/../../etc/passwd`, dir),
      null,
    );
    assert.equal(
      await resolveMediaUrl(toolImageUrl("missing.png"), dir),
      null,
    );
  });

  it("builds and parses artifact URLs", () => {
    assert.equal(artifactUrl("a1"), `${SCHEME}://artifact/a1`);
    assert.deepEqual(parseMediaUrl(`${SCHEME}://artifact/a1`), {
      kind: "artifact",
      id: "a1",
    });
    assert.equal(artifactUrl(""), null);
    assert.equal(artifactUrl("../evil"), null);
  });

  it("streams artifacts with exact range headers", async () => {
    const artifactPath = path.join(dir, "artifact.bin");
    const bytes = Buffer.from("0123456789");
    fs.writeFileSync(artifactPath, bytes);

    /** @type {((request: Request) => Promise<Response>) | null} */
    let handler = null;
    const fakeStore = {
      open: async ({ id }) => {
        if (id !== "a1") return null;
        return {
          info: { mimeType: "application/octet-stream" },
          path: artifactPath,
          size: bytes.length,
        };
      },
    };

    installHandler({
      protocol: {
        handle(_scheme, fn) {
          handler = fn;
        },
      },
      net: {
        fetch: async () => new Response("tool", { status: 200 }),
      },
      userDataPath: dir,
      getArtifactStore: () => fakeStore,
    });
    assert.ok(handler);

    const base = `${SCHEME}://artifact/a1`;

    const getFull = await handler(new Request(base, { method: "GET" }));
    assert.equal(getFull.status, 200);
    assert.equal(getFull.headers.get("Content-Type"), "application/octet-stream");
    assert.equal(getFull.headers.get("Accept-Ranges"), "bytes");
    assert.equal(getFull.headers.get("Content-Length"), "10");
    assert.equal(getFull.headers.get("Content-Range"), null);
    assert.equal(Buffer.from(await getFull.arrayBuffer()).toString(), bytes.toString());

    const headFull = await handler(new Request(base, { method: "HEAD" }));
    assert.equal(headFull.status, 200);
    assert.equal(headFull.headers.get("Content-Type"), "application/octet-stream");
    assert.equal(headFull.headers.get("Accept-Ranges"), "bytes");
    assert.equal(headFull.headers.get("Content-Length"), "10");
    assert.equal(await headFull.text(), "");

    const ranged = await handler(
      new Request(base, { method: "GET", headers: { Range: "bytes=2-5" } }),
    );
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get("Content-Type"), "application/octet-stream");
    assert.equal(ranged.headers.get("Accept-Ranges"), "bytes");
    assert.equal(ranged.headers.get("Content-Length"), "4");
    assert.equal(ranged.headers.get("Content-Range"), "bytes 2-5/10");
    assert.equal(Buffer.from(await ranged.arrayBuffer()).toString(), "2345");

    const missing = await handler(new Request(`${SCHEME}://artifact/missing`, { method: "GET" }));
    assert.equal(missing.status, 404);

    const unsatisfiable = await handler(
      new Request(base, { method: "GET", headers: { Range: "bytes=20-30" } }),
    );
    assert.equal(unsatisfiable.status, 416);
    assert.equal(unsatisfiable.headers.get("Content-Type"), "application/octet-stream");
    assert.equal(unsatisfiable.headers.get("Accept-Ranges"), "bytes");
    assert.equal(unsatisfiable.headers.get("Content-Length"), "0");
    assert.equal(unsatisfiable.headers.get("Content-Range"), "bytes */10");

    const headRange = await handler(
      new Request(base, { method: "HEAD", headers: { Range: "bytes=2-5" } }),
    );
    assert.equal(headRange.status, 206);
    assert.equal(headRange.headers.get("Content-Length"), "4");
    assert.equal(headRange.headers.get("Content-Range"), "bytes 2-5/10");
    assert.equal(await headRange.text(), "");
  });

  it("rejects non-GET/HEAD artifact methods with 405", async () => {
    let handler = null;
    installHandler({
      protocol: {
        handle(_scheme, fn) {
          handler = fn;
        },
      },
      net: {
        fetch: async () => new Response("tool", { status: 200 }),
      },
      userDataPath: dir,
      getArtifactStore: () => ({
        open: async () => ({
          info: { mimeType: "application/octet-stream" },
          path: path.join(dir, "artifact.bin"),
          size: 1,
        }),
      }),
    });
    const post = await handler(
      new Request(`${SCHEME}://artifact/a1`, { method: "POST" }),
    );
    assert.equal(post.status, 405);
  });

  it("still resolves tool images through net.fetch", async () => {
    let handler = null;
    let fetchCalled = false;
    const [name] = saveToolImages(
      dir,
      extractImages([
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: PNG_B64 },
        },
      ]),
      "t1",
    );

    installHandler({
      protocol: {
        handle(_scheme, fn) {
          handler = fn;
        },
      },
      net: {
        fetch: async (href) => {
          fetchCalled = true;
          return new Response("tool-bytes", { status: 200 });
        },
      },
      userDataPath: dir,
      getArtifactStore: () => ({
        open: async () => {
          throw new Error("artifact store should not be used");
        },
      }),
    });

    const res = await handler(new Request(toolImageUrl(name), { method: "GET" }));
    assert.equal(fetchCalled, true);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "tool-bytes");
  });

  it("resolves a pasted attachment and refuses non-images", async () => {
    const dataUrl = `data:image/png;base64,${Buffer.from("x").toString("base64")}`;
    const saved = attachments.saveImage(dir, "t1", dataUrl);
    const resolved = await resolveMediaUrl(localImageUrl(saved.path), dir);
    assert.ok(resolved);
    assert.equal(resolved.path, saved.path);

    const txt = path.join(dir, "notes.txt");
    fs.writeFileSync(txt, "hello");
    assert.equal(await resolveMediaUrl(localImageUrl(txt), dir), null);
    assert.equal(
      await resolveMediaUrl(localImageUrl("/etc/passwd"), dir),
      null,
    );
  });
});
