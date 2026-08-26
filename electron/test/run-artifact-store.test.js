"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../store.js");
const {
  createRunArtifactStore,
  isValidArtifactMetadata,
  defaultSyncFile,
} = require("../run-artifact-store.js");

function box(type, body) {
  const buf = Buffer.alloc(8 + body.length);
  buf.writeUInt32BE(8 + body.length, 0);
  buf.write(type, 4, 4);
  body.copy(buf, 8);
  return buf;
}

function pngFixture(width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 2;
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdrType = Buffer.from("IHDR");
  const ihdrLen = Buffer.alloc(4);
  ihdrLen.writeUInt32BE(13);
  const crc = Buffer.alloc(4);
  return Buffer.concat([sig, ihdrLen, ihdrType, ihdrData, crc]);
}

function mp4Fixture(durationMs = 2000, timescale = 1000) {
  const ftypBody = Buffer.alloc(12);
  ftypBody.write("isom", 0, 4);
  ftypBody.writeUInt32BE(0, 4);
  ftypBody.write("isom", 8, 4);
  const ftyp = box("ftyp", ftypBody);
  const mvhdBody = Buffer.alloc(96);
  mvhdBody[0] = 0;
  mvhdBody.writeUInt32BE(timescale, 12);
  mvhdBody.writeUInt32BE(durationMs, 16);
  mvhdBody.writeUInt32BE(0x00010000, 20);
  mvhdBody.writeUInt16BE(0x0100, 24);
  const mvhd = box("mvhd", mvhdBody);
  const moov = box("moov", mvhd);
  return Buffer.concat([ftyp, moov]);
}

function makeThread(id = "t1") {
  return {
    id,
    projectId: "p1",
    title: "Test",
    branch: null,
    prNumber: null,
    prUrl: null,
    status: "idle",
    lastError: null,
    createdAt: 1,
    updatedAt: 2,
    runStartedAt: null,
    stoppedAt: null,
    archived: false,
    settledOverride: null,
    settledAt: null,
    prState: null,
    prMergeable: null,
    quotaWaitUntil: null,
    quotaWaitResumed: false,
    quotaWaitAutoResume: null,
    lastVisitedAt: null,
    pinnedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    provider: "claude",
    model: null,
    sessionId: null,
    permissionMode: "default",
    reasoningEffort: null,
    webSearch: false,
    worktreePath: null,
    handoffFrom: null,
    feltEstimate: null,
    replayContext: false,
    muted: false,
    notes: "",
    queued: null,
    verifyCommand: null,
    verify: null,
    issueNumber: null,
    postMergeVerify: null,
    reviewAcceptedHunks: [],
  };
}

describe("createRunArtifactStore", () => {
  let tmpDir;
  let filePath;
  let store;
  let root;
  let artifacts;
  let thread;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-artifact-store-"));
    filePath = path.join(tmpDir, "store.json");
    store = new Store(filePath);
    thread = makeThread();
    store.setThreads([thread]);
    root = path.join(tmpDir, "run-artifacts");
    artifacts = createRunArtifactStore({
      userDataPath: tmpDir,
      store,
      now: () => Date.parse("2026-08-25T12:00:00.000Z"),
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stages under .staging and commits a PNG batch", async () => {
    const staged = await artifacts.stage({
      kind: "image",
      mimeType: "image/png",
    });
    assert.ok(staged.path.includes(path.join("run-artifacts", ".staging")));
    assert.match(staged.token, /^[0-9a-f-]{36}$/i);

    await fs.promises.writeFile(staged.path, pngFixture(2, 3));
    const [info] = await artifacts.commitBatch({
      threadId: thread.id,
      runId: "r1",
      source: "simulator",
      items: [
        {
          key: "screen",
          stagingToken: staged.token,
          kind: "image",
          mimeType: "image/png",
          name: "Simulator screenshot.png",
        },
      ],
    });
    assert.equal(info.path, undefined);
    assert.match(info.id, /^[0-9a-f-]{36}$/i);
    assert.deepEqual(await artifacts.open({ id: info.id, threadId: thread.id }), {
      info,
      path: path.join(root, thread.id, "r1", `${info.id}.png`),
      size: info.size,
    });
  });

  it("rejects caller path and absolute names before metadata changes", async () => {
    const staged = await artifacts.stage({
      kind: "image",
      mimeType: "image/png",
    });
    await fs.promises.writeFile(staged.path, pngFixture(1, 1));

    await assert.rejects(
      artifacts.commitBatch({
        threadId: thread.id,
        runId: "r1",
        source: "simulator",
        items: [
          {
            key: "screen",
            stagingToken: staged.token,
            kind: "image",
            mimeType: "image/png",
            name: "/etc/passwd",
          },
        ],
      }),
      (err) => err.code === "invalid_artifact",
    );
    assert.equal(store.getRunArtifacts(thread.id).length, 0);

    await assert.rejects(
      artifacts.commitBatch({
        threadId: thread.id,
        runId: "r1",
        source: "simulator",
        items: [
          {
            key: "screen",
            stagingToken: staged.token,
            kind: "image",
            mimeType: "image/png",
            name: "screen.png",
            path: staged.path,
          },
        ],
      }),
      (err) => err.code === "invalid_artifact",
    );
    assert.equal(store.getRunArtifacts(thread.id).length, 0);
  });

  it("commits video and poster together with posterArtifactId", async () => {
    let uuid = 0;
    const ids = ["video-id", "poster-id"];
    artifacts = createRunArtifactStore({
      userDataPath: tmpDir,
      store,
      now: () => Date.parse("2026-08-25T12:00:00.000Z"),
      randomUUID: () => ids[uuid++],
    });

    const videoStaged = await artifacts.stage({
      kind: "video",
      mimeType: "video/mp4",
    });
    const posterStaged = await artifacts.stage({
      kind: "image",
      mimeType: "image/png",
    });
    await fs.promises.writeFile(videoStaged.path, mp4Fixture());
    await fs.promises.writeFile(posterStaged.path, pngFixture(4, 4));

    const [video, poster] = await artifacts.commitBatch({
      threadId: thread.id,
      runId: "r1",
      source: "simulator",
      items: [
        {
          key: "video",
          stagingToken: videoStaged.token,
          kind: "video",
          mimeType: "video/mp4",
          name: "Simulator recording.mp4",
          posterKey: "poster",
        },
        {
          key: "poster",
          stagingToken: posterStaged.token,
          kind: "image",
          mimeType: "image/png",
          name: "Simulator recording poster.png",
        },
      ],
    });

    assert.equal(video.posterArtifactId, poster.id);
    assert.equal(poster.posterArtifactId, undefined);
    assert.deepEqual(store.getRunArtifacts(thread.id).map((a) => a.id), [
      video.id,
      poster.id,
    ]);
  });

  it("returns null for wrong thread lookup and rejects symlink files", async () => {
    const staged = await artifacts.stage({
      kind: "image",
      mimeType: "image/png",
    });
    await fs.promises.writeFile(staged.path, pngFixture(1, 1));
    const [info] = await artifacts.commitBatch({
      threadId: thread.id,
      runId: "r1",
      source: "simulator",
      items: [
        {
          key: "screen",
          stagingToken: staged.token,
          kind: "image",
          mimeType: "image/png",
          name: "screen.png",
        },
      ],
    });

    assert.equal(await artifacts.open({ id: info.id, threadId: "other" }), null);

    const finalPath = path.join(root, thread.id, "r1", `${info.id}.png`);
    const symlink = path.join(root, thread.id, "r1", "evil.png");
    await fs.promises.rename(finalPath, finalPath + ".real");
    await fs.promises.symlink(finalPath + ".real", symlink);
    await fs.promises.rename(symlink, finalPath);

    assert.equal(await artifacts.open({ id: info.id, threadId: thread.id }), null);
  });

  it("rejects tiny caps without deleting referenced metadata", async () => {
    const existing = {
      id: "kept",
      threadId: thread.id,
      runId: "r0",
      source: "manual",
      kind: "image",
      mimeType: "image/png",
      name: "kept.png",
      size: 80,
      createdAt: "2026-08-25T11:00:00.000Z",
    };
    store.setRunArtifacts(thread.id, [existing]);
    const keptPath = path.join(root, thread.id, "r0", "kept.png");
    await fs.promises.mkdir(path.dirname(keptPath), { recursive: true });
    await fs.promises.writeFile(keptPath, pngFixture(1, 1));

    artifacts = createRunArtifactStore({
      userDataPath: tmpDir,
      store,
      limits: { maxThreadBytes: 100, maxGlobalBytes: 100 },
    });

    const staged = await artifacts.stage({
      kind: "image",
      mimeType: "image/png",
    });
    await fs.promises.writeFile(staged.path, pngFixture(2, 2));

    await assert.rejects(
      artifacts.commitBatch({
        threadId: thread.id,
        runId: "r1",
        source: "simulator",
        items: [
          {
            key: "screen",
            stagingToken: staged.token,
            kind: "image",
            mimeType: "image/png",
            name: "screen.png",
          },
        ],
      }),
      (err) => err.code === "artifact_limit",
    );

    assert.deepEqual(store.getRunArtifacts(thread.id), [existing]);
    assert.equal(fs.existsSync(keptPath), true);
  });

  it("cleanup removes stale staging and unreferenced finals only", async () => {
    const staged = await artifacts.stage({
      kind: "image",
      mimeType: "image/png",
    });
    const staleStaging = path.join(root, ".staging", "stale.bin");
    await fs.promises.mkdir(path.dirname(staleStaging), { recursive: true });
    await fs.promises.writeFile(staleStaging, Buffer.from("stale"));

    const referenced = {
      id: "ref",
      threadId: thread.id,
      runId: "r1",
      source: "simulator",
      kind: "image",
      mimeType: "image/png",
      name: "ref.png",
      size: 40,
      createdAt: "2026-08-25T12:00:00.000Z",
    };
    store.setRunArtifacts(thread.id, [referenced]);
    const refPath = path.join(root, thread.id, "r1", "ref.png");
    await fs.promises.mkdir(path.dirname(refPath), { recursive: true });
    await fs.promises.writeFile(refPath, pngFixture(1, 1));

    const orphanPath = path.join(root, thread.id, "r1", "orphan.png");
    await fs.promises.writeFile(orphanPath, pngFixture(1, 1));

    await artifacts.cleanup();

    assert.equal(fs.existsSync(staleStaging), false);
    assert.equal(fs.existsSync(orphanPath), false);
    assert.equal(fs.existsSync(refPath), true);
    assert.equal(fs.existsSync(staged.path), true);
  });

  it("rolls back metadata and files when saveNow throws", async () => {
    const existing = {
      id: "kept",
      threadId: thread.id,
      runId: "r0",
      source: "manual",
      kind: "image",
      mimeType: "image/png",
      name: "kept.png",
      size: 40,
      createdAt: "2026-08-25T11:00:00.000Z",
    };
    store.setRunArtifacts(thread.id, [existing]);

    const flakyStore = Object.create(store);
    flakyStore.saveNow = () => {
      throw new Error("disk full");
    };

    artifacts = createRunArtifactStore({
      userDataPath: tmpDir,
      store: flakyStore,
      randomUUID: () => "new-artifact-id",
    });

    const staged = await artifacts.stage({
      kind: "image",
      mimeType: "image/png",
    });
    await fs.promises.writeFile(staged.path, pngFixture(2, 2));

    await assert.rejects(
      artifacts.commitBatch({
        threadId: thread.id,
        runId: "r1",
        source: "simulator",
        items: [
          {
            key: "screen",
            stagingToken: staged.token,
            kind: "image",
            mimeType: "image/png",
            name: "screen.png",
          },
        ],
      }),
      (err) => err.message === "disk full",
    );

    assert.deepEqual(flakyStore.getRunArtifacts(thread.id), [existing]);
    assert.equal(
      fs.existsSync(path.join(root, thread.id, "r1", "new-artifact-id.png")),
      false,
    );
    assert.equal(fs.existsSync(staged.path), true);
  });

  it("rejects duplicate keys and duplicate staging tokens unchanged", async () => {
    const stagedA = await artifacts.stage({
      kind: "image",
      mimeType: "image/png",
    });
    const stagedB = await artifacts.stage({
      kind: "image",
      mimeType: "image/png",
    });
    await fs.promises.writeFile(stagedA.path, pngFixture(1, 1));
    await fs.promises.writeFile(stagedB.path, pngFixture(1, 1));

    await assert.rejects(
      artifacts.commitBatch({
        threadId: thread.id,
        runId: "r1",
        source: "simulator",
        items: [
          {
            key: "dup",
            stagingToken: stagedA.token,
            kind: "image",
            mimeType: "image/png",
            name: "a.png",
          },
          {
            key: "dup",
            stagingToken: stagedB.token,
            kind: "image",
            mimeType: "image/png",
            name: "b.png",
          },
        ],
      }),
      (err) =>
        err.code === "invalid_artifact" &&
        /duplicate commit item key/i.test(err.message),
    );

    await assert.rejects(
      artifacts.commitBatch({
        threadId: thread.id,
        runId: "r1",
        source: "simulator",
        items: [
          {
            key: "a",
            stagingToken: stagedA.token,
            kind: "image",
            mimeType: "image/png",
            name: "a.png",
          },
          {
            key: "b",
            stagingToken: stagedA.token,
            kind: "image",
            mimeType: "image/png",
            name: "b.png",
          },
        ],
      }),
      (err) =>
        err.code === "invalid_artifact" &&
        /duplicate staging token/i.test(err.message),
    );

    assert.equal(store.getRunArtifacts(thread.id).length, 0);
    assert.equal(fs.existsSync(stagedA.path), true);
    assert.equal(fs.existsSync(stagedB.path), true);
  });

  it("rejects traversal in runId and unsafe destination paths", async () => {
    const staged = await artifacts.stage({
      kind: "image",
      mimeType: "image/png",
    });
    await fs.promises.writeFile(staged.path, pngFixture(1, 1));

    await assert.rejects(
      artifacts.commitBatch({
        threadId: thread.id,
        runId: "../escape",
        source: "simulator",
        items: [
          {
            key: "screen",
            stagingToken: staged.token,
            kind: "image",
            mimeType: "image/png",
            name: "screen.png",
          },
        ],
      }),
      (err) => err.code === "invalid_artifact",
    );
    assert.equal(store.getRunArtifacts(thread.id).length, 0);
  });

  it("rejects invalid source and ignores invalid metadata in cap sums", async () => {
    store.setRunArtifacts(thread.id, [
      {
        id: "bad",
        threadId: thread.id,
        runId: "r0",
        source: "not-a-source",
        kind: "image",
        mimeType: "image/png",
        name: "bad.png",
        size: 90,
        createdAt: "2026-08-25T11:00:00.000Z",
      },
    ]);
    assert.equal(isValidArtifactMetadata(store.getRunArtifacts(thread.id)[0]), false);

    const staged = await artifacts.stage({
      kind: "image",
      mimeType: "image/png",
    });
    await fs.promises.writeFile(staged.path, pngFixture(1, 1));

    await assert.rejects(
      artifacts.commitBatch({
        threadId: thread.id,
        runId: "r1",
        source: "bogus",
        items: [
          {
            key: "screen",
            stagingToken: staged.token,
            kind: "image",
            mimeType: "image/png",
            name: "screen.png",
          },
        ],
      }),
      (err) => err.code === "invalid_artifact",
    );

    artifacts = createRunArtifactStore({
      userDataPath: tmpDir,
      store,
      limits: { maxThreadBytes: 100, maxGlobalBytes: 100 },
    });
    const staged2 = await artifacts.stage({
      kind: "image",
      mimeType: "image/png",
    });
    await fs.promises.writeFile(staged2.path, pngFixture(2, 2));
    const [info] = await artifacts.commitBatch({
      threadId: thread.id,
      runId: "r1",
      source: "verification",
      items: [
        {
          key: "screen",
          stagingToken: staged2.token,
          kind: "image",
          mimeType: "image/png",
          name: "screen.png",
        },
      ],
    });
    assert.equal(info.source, "verification");
  });

  it("syncs staged files before rename and rejects symlink replacement", async () => {
    const synced = [];
    artifacts = createRunArtifactStore({
      userDataPath: tmpDir,
      store,
      syncFile: async (filePath) => {
        synced.push(filePath);
        const stat = await fs.promises.lstat(filePath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          const { artifactError } = require("../run-artifact-media.js");
          throw artifactError(
            "invalid_artifact",
            "Artifact must be a regular file",
          );
        }
      },
    });

    const staged = await artifacts.stage({
      kind: "image",
      mimeType: "image/png",
    });
    await fs.promises.writeFile(staged.path, pngFixture(1, 1));
    await artifacts.commitBatch({
      threadId: thread.id,
      runId: "r1",
      source: "browser",
      items: [
        {
          key: "screen",
          stagingToken: staged.token,
          kind: "image",
          mimeType: "image/png",
          name: "screen.png",
        },
      ],
    });
    assert.deepEqual(synced, [staged.path]);

    const stagedSymlink = await artifacts.stage({
      kind: "image",
      mimeType: "image/png",
    });
    const real = path.join(root, ".staging", "real.png");
    await fs.promises.writeFile(real, pngFixture(1, 1));
    await fs.promises.unlink(stagedSymlink.path);
    await fs.promises.symlink(real, stagedSymlink.path);

    await assert.rejects(
      artifacts.commitBatch({
        threadId: thread.id,
        runId: "r1",
        source: "manual",
        items: [
          {
            key: "screen",
            stagingToken: stagedSymlink.token,
            kind: "image",
            mimeType: "image/png",
            name: "screen.png",
          },
        ],
      }),
      (err) => err.code === "invalid_artifact",
    );
  });

  it("cleanup during pre-persist keeps renamed-but-not-persisted files", async () => {
    const orphanPath = path.join(root, thread.id, "r1", "orphan.png");
    await fs.promises.mkdir(path.dirname(orphanPath), { recursive: true });
    await fs.promises.writeFile(orphanPath, pngFixture(1, 1));

    let destDuringCleanup = "";
    artifacts = createRunArtifactStore({
      userDataPath: tmpDir,
      store,
      randomUUID: () => "inflight-id",
      beforePersist: async ({ cleanupUnlocked, destPaths }) => {
        destDuringCleanup = destPaths[0];
        await cleanupUnlocked();
        assert.equal(fs.existsSync(destDuringCleanup), true);
        assert.equal(fs.existsSync(orphanPath), false);
      },
    });

    const staged = await artifacts.stage({
      kind: "image",
      mimeType: "image/png",
    });
    await fs.promises.writeFile(staged.path, pngFixture(2, 2));
    const [info] = await artifacts.commitBatch({
      threadId: thread.id,
      runId: "r1",
      source: "simulator",
      items: [
        {
          key: "screen",
          stagingToken: staged.token,
          kind: "image",
          mimeType: "image/png",
          name: "screen.png",
        },
      ],
    });

    assert.equal(
      destDuringCleanup,
      path.join(root, thread.id, "r1", "inflight-id.png"),
    );
    assert.equal(fs.existsSync(destDuringCleanup), true);
    assert.equal(info.id, "inflight-id");
  });

  it("defaultSyncFile treats sync failure as best-effort and still commits", async () => {
    const syncTarget = path.join(tmpDir, "sync-only.bin");
    await fs.promises.writeFile(syncTarget, pngFixture(1, 1));
    const open = fs.promises.open.bind(fs.promises);
    fs.promises.open = async (filePath, mode) => {
      const fh = await open(filePath, mode);
      if (filePath === syncTarget && mode === "r+") {
        fh.sync = async () => {
          throw new Error("sync failed");
        };
      }
      return fh;
    };
    try {
      await defaultSyncFile(syncTarget);
    } finally {
      fs.promises.open = open;
    }

    const staged = await artifacts.stage({
      kind: "image",
      mimeType: "image/png",
    });
    await fs.promises.writeFile(staged.path, pngFixture(2, 2));

    const openForCommit = fs.promises.open.bind(fs.promises);
    fs.promises.open = async (filePath, mode) => {
      const fh = await openForCommit(filePath, mode);
      if (filePath === staged.path && mode === "r+") {
        fh.sync = async () => {
          throw new Error("sync failed");
        };
      }
      return fh;
    };

    try {
      const [info] = await artifacts.commitBatch({
        threadId: thread.id,
        runId: "r1",
        source: "simulator",
        items: [
          {
            key: "screen",
            stagingToken: staged.token,
            kind: "image",
            mimeType: "image/png",
            name: "screen.png",
          },
        ],
      });
      assert.equal(info.size, pngFixture(2, 2).length);
      assert.equal(
        fs.existsSync(path.join(root, thread.id, "r1", `${info.id}.png`)),
        true,
      );
    } finally {
      fs.promises.open = openForCommit;
    }
  });

  it("rejects null commit items with invalid_artifact", async () => {
    const staged = await artifacts.stage({
      kind: "image",
      mimeType: "image/png",
    });
    await fs.promises.writeFile(staged.path, pngFixture(1, 1));

    await assert.rejects(
      artifacts.commitBatch({
        threadId: thread.id,
        runId: "r1",
        source: "simulator",
        items: [
          null,
          {
            key: "screen",
            stagingToken: staged.token,
            kind: "image",
            mimeType: "image/png",
            name: "screen.png",
          },
        ],
      }),
      (err) =>
        err.code === "invalid_artifact" &&
        /invalid commit item/i.test(err.message),
    );
    assert.equal(store.getRunArtifacts(thread.id).length, 0);
  });

  it("rolls back first rename and clears in-flight when second rename fails", async () => {
    let forwardRenames = 0;
    let artifactIds = 0;
    artifacts = createRunArtifactStore({
      userDataPath: tmpDir,
      store,
      randomUUID: () => `artifact-${++artifactIds}`,
      renameFile: async (src, dest) => {
        if (src.includes(".staging")) {
          forwardRenames += 1;
          if (forwardRenames === 2) {
            throw new Error("second rename failed");
          }
        }
        return fs.promises.rename(src, dest);
      },
    });

    const stagedA = await artifacts.stage({
      kind: "image",
      mimeType: "image/png",
    });
    const stagedB = await artifacts.stage({
      kind: "image",
      mimeType: "image/png",
    });
    await fs.promises.writeFile(stagedA.path, pngFixture(1, 1));
    await fs.promises.writeFile(stagedB.path, pngFixture(1, 1));

    const firstDest = path.join(root, thread.id, "r1", "artifact-3.png");
    await assert.rejects(
      artifacts.commitBatch({
        threadId: thread.id,
        runId: "r1",
        source: "simulator",
        items: [
          {
            key: "a",
            stagingToken: stagedA.token,
            kind: "image",
            mimeType: "image/png",
            name: "a.png",
          },
          {
            key: "b",
            stagingToken: stagedB.token,
            kind: "image",
            mimeType: "image/png",
            name: "b.png",
          },
        ],
      }),
      (err) => err.message === "second rename failed",
    );

    assert.equal(fs.existsSync(firstDest), false);
    assert.equal(fs.existsSync(stagedA.path), true);
    assert.equal(store.getRunArtifacts(thread.id).length, 0);
    await artifacts.cleanup();
    assert.equal(fs.existsSync(firstDest), false);
  });

  it("lets cleanup reclaim an unrecoverable orphan after rollback failure", async () => {
    let forwardRenames = 0;
    let artifactIds = 0;
    artifacts = createRunArtifactStore({
      userDataPath: tmpDir,
      store,
      randomUUID: () => `artifact-${++artifactIds}`,
      renameFile: async (src, dest) => {
        if (src.includes(".staging")) {
          forwardRenames += 1;
          if (forwardRenames === 2) {
            throw new Error("second rename failed");
          }
          return fs.promises.rename(src, dest);
        }
        throw new Error("rollback blocked");
      },
    });

    const stagedA = await artifacts.stage({
      kind: "image",
      mimeType: "image/png",
    });
    const stagedB = await artifacts.stage({
      kind: "image",
      mimeType: "image/png",
    });
    await fs.promises.writeFile(stagedA.path, pngFixture(1, 1));
    await fs.promises.writeFile(stagedB.path, pngFixture(1, 1));

    const orphanDest = path.join(root, thread.id, "r1", "artifact-3.png");
    await assert.rejects(
      artifacts.commitBatch({
        threadId: thread.id,
        runId: "r1",
        source: "simulator",
        items: [
          {
            key: "a",
            stagingToken: stagedA.token,
            kind: "image",
            mimeType: "image/png",
            name: "a.png",
          },
          {
            key: "b",
            stagingToken: stagedB.token,
            kind: "image",
            mimeType: "image/png",
            name: "b.png",
          },
        ],
      }),
      (err) => err.message === "second rename failed",
    );

    assert.equal(fs.existsSync(orphanDest), true);
    await artifacts.cleanup();
    assert.equal(fs.existsSync(orphanDest), false);
  });

  it("reserves staging tokens before file creation and drops them on failure", async () => {
    const seen = [];
    artifacts = createRunArtifactStore({
      userDataPath: tmpDir,
      store,
      openStagingFile: async (filePath) => {
        seen.push(filePath);
        throw new Error("staging create failed");
      },
    });

    await assert.rejects(
      artifacts.stage({ kind: "image", mimeType: "image/png" }),
      (err) => err.message === "staging create failed",
    );
    assert.equal(seen.length, 1);
    assert.equal(fs.existsSync(seen[0]), false);

    const okArtifacts = createRunArtifactStore({
      userDataPath: tmpDir,
      store,
    });
    const staged = await okArtifacts.stage({
      kind: "image",
      mimeType: "image/png",
    });
    const stat = await fs.promises.stat(staged.path);
    assert.equal(stat.mode & 0o777, 0o600);
  });
});
