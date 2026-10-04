/**
 * Code map + config doctor, now in Settings → Memory → Project tools
 * (inspector tabs redesign). Moved verbatim from test/memoryTab.test.tsx;
 * only the mount changed to <MemoryProjectTools …>,
 * dropping the memory-list props it no longer takes.
 *
 * Run: node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types --test test/memoryProjectTools.test.tsx
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { inAct, mount, unmountAll } from "./support/dom.ts";
import { MemoryProjectTools } from "../src/components/MemoryTab";
import type {
  AgentConfigDoctorReport,
  AgentConfigPreview,
  AgentConfigWriteResult,
  ProjectCodeMap,
} from "../src/shared/ipc";

afterEach(unmountAll);

async function openDoctor(m: Awaited<ReturnType<typeof mount>>) {
  const summary = m.query("[data-config-doctor] summary");
  assert.ok(summary, "config doctor disclosure must exist");
  await m.click(summary);
}

async function openMap(m: Awaited<ReturnType<typeof mount>>) {
  const summary = m.query("[data-code-map] summary");
  assert.ok(summary, "code map disclosure must exist");
  await m.click(summary);
}

const SAMPLE_REPORT: AgentConfigDoctorReport = {
  projectId: "p1",
  files: [
    {
      path: "AGENTS.md",
      bytes: 120,
      score: 42,
      grade: "D",
      axes: [],
      issues: [],
      recommendations: [],
    },
  ],
  score: 42,
  grade: "D",
  memory: {
    considered: 3,
    covered: 1,
    missing: [
      { id: "c1", type: "convention", title: "Fail closed on worktrees" },
    ],
  },
  issues: [],
  recommendations: [],
};

describe("MemoryProjectTools config doctor", () => {
  it("is absent when no lint callback is wired", async () => {
    const m = await mount(<MemoryProjectTools projectId="p1" projectSlug="coder" />);
    assert.equal(m.query("[data-config-doctor]"), null);
    m.unmount();
  });

  it("lints the selected project and shows grade + memory gap", async () => {
    const linted: string[] = [];
    const m = await mount(
      <MemoryProjectTools
        projectSlug="coder"
        projectId="p1"
        lintAgentConfig={async (input) => {
          linted.push(input.projectId);
          return SAMPLE_REPORT;
        }}
      />,
    );
    assert.deepEqual(linted, []);
    await openDoctor(m);
    assert.deepEqual(linted, ["p1"]);
    const card = m.query("[data-config-doctor]");
    assert.ok(card, "doctor card must render");
    assert.ok(card.textContent?.includes("D 42"));
    assert.ok(card.textContent?.includes("AGENTS.md"));
    assert.ok(card.textContent?.includes("1/3 memory"));
    assert.ok(card.textContent?.includes("1 memory not in the files"));
    m.unmount();
  });

  it("previews then confirms before writing", async () => {
    const written: string[] = [];
    const preview: AgentConfigPreview = {
      projectId: "p1",
      files: [{ path: "AGENTS.md", content: "# generated\n", exists: true }],
    };
    const m = await mount(
      <MemoryProjectTools
        projectSlug="coder"
        projectId="p1"
        lintAgentConfig={async () => SAMPLE_REPORT}
        previewAgentConfig={async () => preview}
        writeAgentConfig={async (input) => {
          written.push(input.projectId);
          return { projectId: input.projectId, written: ["AGENTS.md"] };
        }}
      />,
    );
    await openDoctor(m);
    await m.click(m.byText("Preview"));
    assert.ok(m.query("[data-config-preview]"));
    assert.ok(m.text().includes("# generated"));
    await m.click(m.byText("Write AGENTS.md"));
    assert.equal(written.length, 0, "first click is confirm");
    await m.click(m.byText("Confirm write"));
    assert.deepEqual(written, ["p1"]);
    assert.ok(m.query("[data-config-wrote]"));
    m.unmount();
  });
});

const REPORT_A: AgentConfigDoctorReport = {
  ...SAMPLE_REPORT,
  projectId: "proj-a",
  grade: "D",
  score: 42,
};
const REPORT_B: AgentConfigDoctorReport = {
  ...SAMPLE_REPORT,
  projectId: "proj-b",
  grade: "B",
  score: 80,
  files: [
    {
      ...SAMPLE_REPORT.files[0]!,
      path: "CLAUDE.md",
      grade: "B",
      score: 80,
    },
  ],
};
const PREVIEW_A: AgentConfigPreview = {
  projectId: "proj-a",
  files: [{ path: "AGENTS.md", content: "# generated-A\n", exists: true }],
};
const PREVIEW_B: AgentConfigPreview = {
  projectId: "proj-b",
  files: [{ path: "CLAUDE.md", content: "# generated-B\n", exists: true }],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function doctorTab(
  projectId: "proj-a" | "proj-b",
  handlers: {
    lint: (input: { projectId: string }) => Promise<AgentConfigDoctorReport>;
    preview: (input: { projectId: string }) => Promise<AgentConfigPreview>;
    write: (input: { projectId: string }) => Promise<AgentConfigWriteResult>;
  },
) {
  return (
    <MemoryProjectTools
      projectSlug={projectId === "proj-a" ? "alpha" : "beta"}
      projectId={projectId}
      lintAgentConfig={handlers.lint}
      previewAgentConfig={handlers.preview}
      writeAgentConfig={handlers.write}
    />
  );
}

describe("MemoryProjectTools config doctor project switch #1136", () => {
  it("drops A's preview when the same card is shown for B", async () => {
    const handlers = {
      lint: async (input: { projectId: string }) =>
        input.projectId === "proj-a" ? REPORT_A : REPORT_B,
      preview: async (input: { projectId: string }) =>
        input.projectId === "proj-a" ? PREVIEW_A : PREVIEW_B,
      write: async (input: { projectId: string }) => ({
        projectId: input.projectId,
        written: ["AGENTS.md"],
      }),
    };
    const m = await mount(doctorTab("proj-a", handlers));
    await openDoctor(m);
    await m.click(m.byText("Preview"));
    assert.ok(m.text().includes("# generated-A"));
    await m.rerender(doctorTab("proj-b", handlers));
    assert.ok(
      !m.query("[data-config-preview]"),
      "B must not keep A's generated files on screen",
    );
    assert.equal(m.text().includes("# generated-A"), false);
    assert.ok(m.text().includes("B 80"), "B should lint as itself");
    assert.ok(m.byText("Preview"), "writing is not available until B is previewed");
    m.unmount();
  });

  it("disarms confirmation so Confirm write cannot target B", async () => {
    const written: string[] = [];
    const handlers = {
      lint: async (input: { projectId: string }) =>
        input.projectId === "proj-a" ? REPORT_A : REPORT_B,
      preview: async (input: { projectId: string }) =>
        input.projectId === "proj-a" ? PREVIEW_A : PREVIEW_B,
      write: async (input: { projectId: string }) => {
        written.push(input.projectId);
        return { projectId: input.projectId, written: ["AGENTS.md"] };
      },
    };
    const m = await mount(doctorTab("proj-a", handlers));
    await openDoctor(m);
    await m.click(m.byText("Preview"));
    await m.click(m.byText("Write AGENTS.md"));
    assert.ok(m.byText("Confirm write"));
    assert.ok(
      m.byText("Confirm write")?.textContent?.includes("alpha"),
      `confirmation must name the bound project, got: ${m.byText("Confirm write")?.textContent}`,
    );
    await m.rerender(doctorTab("proj-b", handlers));
    assert.ok(
      !m.byText("Confirm write"),
      "A's armed confirm must not survive on B",
    );
    await m.click(m.byText("Write from memory"));
    assert.equal(written.length, 0, "first B click is a fresh confirmation");
    assert.ok(
      m.byText("Confirm write")?.textContent?.includes("beta"),
      `B confirmation must name B, got: ${m.byText("Confirm write")?.textContent}`,
    );
    assert.deepEqual(written, []);
    m.unmount();
  });

  it("ignores A's deferred lint after the card is showing B", async () => {
    const held = deferred<AgentConfigDoctorReport>();
    const handlers = {
      lint: async (input: { projectId: string }) =>
        input.projectId === "proj-a" ? held.promise : REPORT_B,
      preview: async (input: { projectId: string }) =>
        input.projectId === "proj-a" ? PREVIEW_A : PREVIEW_B,
      write: async (input: { projectId: string }) => ({
        projectId: input.projectId,
        written: ["AGENTS.md"],
      }),
    };
    const m = await mount(doctorTab("proj-a", handlers));
    await openDoctor(m);
    await m.rerender(doctorTab("proj-b", handlers));
    await inAct(async () => {
      held.resolve(REPORT_A);
    });
    await m.flush();
    assert.equal(m.text().includes("D 42"), false);
    assert.ok(m.text().includes("B 80"));
    m.unmount();
  });

  it("ignores A's deferred preview after the card is showing B", async () => {
    const held = deferred<AgentConfigPreview>();
    const handlers = {
      lint: async (input: { projectId: string }) =>
        input.projectId === "proj-a" ? REPORT_A : REPORT_B,
      preview: async (input: { projectId: string }) =>
        input.projectId === "proj-a" ? held.promise : PREVIEW_B,
      write: async (input: { projectId: string }) => ({
        projectId: input.projectId,
        written: ["AGENTS.md"],
      }),
    };
    const m = await mount(doctorTab("proj-a", handlers));
    await openDoctor(m);
    await m.click(m.byText("Preview"));
    await m.rerender(doctorTab("proj-b", handlers));
    await inAct(async () => {
      held.resolve(PREVIEW_A);
    });
    await m.flush();
    assert.ok(!m.query("[data-config-preview]"));
    assert.equal(m.text().includes("# generated-A"), false);
    assert.ok(m.text().includes("B 80"));
    m.unmount();
  });

  it("does not restore A's preview or confirm when returning A→B→A", async () => {
    const written: string[] = [];
    const handlers = {
      lint: async (input: { projectId: string }) =>
        input.projectId === "proj-a" ? REPORT_A : REPORT_B,
      preview: async (input: { projectId: string }) =>
        input.projectId === "proj-a" ? PREVIEW_A : PREVIEW_B,
      write: async (input: { projectId: string }) => {
        written.push(input.projectId);
        return { projectId: input.projectId, written: ["AGENTS.md"] };
      },
    };
    const m = await mount(doctorTab("proj-a", handlers));
    await openDoctor(m);
    await m.click(m.byText("Preview"));
    await m.click(m.byText("Write AGENTS.md"));
    await m.rerender(doctorTab("proj-b", handlers));
    await m.rerender(doctorTab("proj-a", handlers));
    assert.ok(!m.query("[data-config-preview]"));
    assert.ok(!m.byText("Confirm write"));
    assert.equal(m.text().includes("# generated-A"), false);
    assert.ok(m.byText("Write from memory"));
    assert.deepEqual(written, []);
    m.unmount();
  });

  it("keeps A's completed write on A without painting it onto B", async () => {
    const held = deferred<AgentConfigWriteResult>();
    const written: string[] = [];
    const handlers = {
      lint: async (input: { projectId: string }) =>
        input.projectId === "proj-a" ? REPORT_A : REPORT_B,
      preview: async (input: { projectId: string }) =>
        input.projectId === "proj-a" ? PREVIEW_A : PREVIEW_B,
      write: async (input: { projectId: string }) => {
        written.push(input.projectId);
        if (input.projectId === "proj-a") return held.promise;
        return { projectId: input.projectId, written: ["CLAUDE.md"] };
      },
    };
    const m = await mount(doctorTab("proj-a", handlers));
    await openDoctor(m);
    await m.click(m.byText("Preview"));
    await m.click(m.byText("Write AGENTS.md"));
    await m.click(m.byText("Confirm write"));
    await m.rerender(doctorTab("proj-b", handlers));
    await inAct(async () => {
      held.resolve({ projectId: "proj-a", written: ["AGENTS.md"] });
    });
    await m.flush();
    assert.deepEqual(written, ["proj-a"]);
    assert.ok(
      !m.query("[data-config-wrote]"),
      "A's write must not appear as B's status",
    );
    await m.rerender(doctorTab("proj-a", handlers));
    assert.ok(m.query("[data-config-wrote]"));
    assert.ok(m.text().includes("Wrote AGENTS.md"));
    m.unmount();
  });
});

describe("MemoryProjectTools code map", () => {
  const wiki: ProjectCodeMap = {
    projectId: "p1",
    updatedAt: Date.now() - 5 * 60_000,
    fileCount: 2,
    symbolCount: 3,
    headSha: "abc1234ffff",
    defaultBranch: "main",
    modules: [
      {
        name: "src",
        fileCount: 2,
        symbolCount: 3,
        hot: [{ path: "src/App.tsx", symbols: ["App", "useNarrow"], rank: 4 }],
      },
    ],
    dependencies: ["react"],
  };

  it("renders the wiki and expands a module", async () => {
    const calls: unknown[] = [];
    const m = await mount(
      <MemoryProjectTools
        projectSlug="coder"
        projectId="p1"
        loadCodeMap={async (input) => {
          calls.push(input);
          return wiki;
        }}
      />,
    );
    await m.flush();
    assert.deepEqual(calls, []);
    await openMap(m);
    assert.deepEqual(calls, [{ projectId: "p1" }]);
    assert.ok(m.query("[data-code-map]"));
    assert.match(m.text(), /Code map/);
    assert.match(m.text(), /not agent memory/);
    assert.match(m.text(), /2 files/);
    assert.match(m.text(), /react/);
    assert.equal(m.text().includes("src/App.tsx"), false);
    await m.click(m.byText("src/"));
    assert.match(m.text(), /src\/App\.tsx/);
    assert.match(m.text(), /App, useNarrow/);
    m.unmount();
  });

  it("renders the map with no memory server involved", async () => {
    const m = await mount(
      <MemoryProjectTools
        projectSlug="coder"
        projectId="p1"
        loadCodeMap={async () => wiki}
      />,
    );
    await m.flush();
    assert.ok(m.query("[data-code-map]"));
    await openMap(m);
    assert.match(m.text(), /src\//);
    m.unmount();
  });

  const wikiA: ProjectCodeMap = {
    projectId: "proj-a",
    updatedAt: Date.now() - 5 * 60_000,
    fileCount: 12,
    symbolCount: 40,
    headSha: "aaaaaaa1111",
    defaultBranch: "main",
    modules: [
      {
        name: "alpha",
        fileCount: 12,
        symbolCount: 40,
        hot: [{ path: "alpha/Kernel.ts", symbols: ["bootA"], rank: 9 }],
      },
    ],
    dependencies: ["alpha-only-dep"],
  };

  const wikiB: ProjectCodeMap = {
    projectId: "proj-b",
    updatedAt: Date.now() - 2 * 60_000,
    fileCount: 3,
    symbolCount: 7,
    headSha: "bbbbbbb2222",
    defaultBranch: "trunk",
    modules: [
      {
        name: "beta",
        fileCount: 3,
        symbolCount: 7,
        hot: [{ path: "beta/Main.ts", symbols: ["bootB"], rank: 2 }],
      },
    ],
    dependencies: ["beta-only-dep"],
  };

  function mapTab(
    projectId: string,
    loadCodeMap: (input: { projectId: string }) => Promise<ProjectCodeMap>,
  ) {
    return (
      <MemoryProjectTools
        projectSlug="coder"
        projectId={projectId}
        loadCodeMap={loadCodeMap}
      />
    );
  }

  function deferredMap() {
    let resolve!: (value: ProjectCodeMap) => void;
    const promise = new Promise<ProjectCodeMap>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  function showsA(text: string): boolean {
    return (
      text.includes("12 files") ||
      text.includes("40 symbols") ||
      text.includes("alpha/") ||
      text.includes("alpha-only-dep") ||
      text.includes("Kernel.ts") ||
      text.includes("bootA")
    );
  }

  function showsB(text: string): boolean {
    return (
      text.includes("3 files") ||
      text.includes("7 symbols") ||
      text.includes("beta/") ||
      text.includes("beta-only-dep") ||
      text.includes("Main.ts") ||
      text.includes("bootB")
    );
  }

  it("drops A's wiki as soon as projectId changes, before B arrives", async () => {
    const pendingB = deferredMap();
    const load = async (input: { projectId: string }) => {
      if (input.projectId === "proj-a") return wikiA;
      return pendingB.promise;
    };
    const m = await mount(mapTab("proj-a", load));
    await openMap(m);
    const onA = m.query("[data-code-map]")?.textContent ?? "";
    assert.equal(showsA(onA), true, "A's map must load first");
    await m.rerender(mapTab("proj-b", load));
    const onB = m.query("[data-code-map]")?.textContent ?? "";
    assert.equal(showsA(onB), false, "B must not keep A's counts or modules");
    assert.equal(showsB(onB), false, "B has not arrived yet");
    m.unmount();
  });

  it("does not paint A's wiki on B's first render, before effects flush", async () => {
    const pendingB = deferredMap();
    let paintedAWhenBLoadStarted = false;
    let readMap: (() => string) | null = null;
    const load = async (input: { projectId: string }) => {
      if (input.projectId === "proj-a") return wikiA;
      // loadCodeMap(B) runs in the load effect, after the first render of B.
      // If that render still holds A's state, the wiki is on screen until
      // a later setState. AgentsPanel updates MemoryTab without a key, so
      // this is the user-visible project-switch frame.
      paintedAWhenBLoadStarted = showsA(readMap?.() ?? "");
      return pendingB.promise;
    };
    const m = await mount(mapTab("proj-a", load));
    readMap = () => m.query("[data-code-map]")?.textContent ?? "";
    await openMap(m);
    await m.rerender(mapTab("proj-b", load));
    assert.equal(
      paintedAWhenBLoadStarted,
      false,
      "B must not show A's counts or modules on the first paint after projectId changes",
    );
    m.unmount();
  });

  it("collapses A's expanded module when projectId changes", async () => {
    const pendingB = deferredMap();
    const wikiBSameName: ProjectCodeMap = {
      ...wikiB,
      modules: [
        {
          name: "alpha",
          fileCount: 3,
          symbolCount: 7,
          hot: [{ path: "alpha/Other.ts", symbols: ["bootB"], rank: 2 }],
        },
      ],
    };
    const load = async (input: { projectId: string }) => {
      if (input.projectId === "proj-a") return wikiA;
      return pendingB.promise;
    };
    const m = await mount(mapTab("proj-a", load));
    await openMap(m);
    await m.click(m.byText("alpha/"));
    assert.equal(
      (m.query("[data-code-map]")?.textContent ?? "").includes("Kernel.ts"),
      true,
    );
    await m.rerender(mapTab("proj-b", load));
    const onB = m.query("[data-code-map]")?.textContent ?? "";
    assert.equal(onB.includes("Kernel.ts"), false);
    assert.equal(onB.includes("alpha/"), false);
    pendingB.resolve(wikiBSameName);
    await m.flush();
    const afterB = m.query("[data-code-map]")?.textContent ?? "";
    assert.equal(afterB.includes("alpha/"), true);
    assert.equal(
      afterB.includes("Other.ts"),
      false,
      "B's module must start collapsed even if A had the same name open",
    );
    m.unmount();
  });

  it("ignores a late A map after switching to B", async () => {
    const pendingA = deferredMap();
    const pendingB = deferredMap();
    const load = async (input: { projectId: string }) => {
      if (input.projectId === "proj-a") return pendingA.promise;
      return pendingB.promise;
    };
    const m = await mount(mapTab("proj-a", load));
    await openMap(m);
    await m.rerender(mapTab("proj-b", load));
    pendingA.resolve(wikiA);
    await m.flush();
    const onB = m.query("[data-code-map]")?.textContent ?? "";
    assert.equal(showsA(onB), false, "in-flight A must not paint on B");
    pendingB.resolve(wikiB);
    await m.flush();
    const afterB = m.query("[data-code-map]")?.textContent ?? "";
    assert.equal(showsB(afterB), true);
    assert.equal(showsA(afterB), false);
    m.unmount();
  });

  it("reloads A after A→B→A and ignores a late B map", async () => {
    const pendingB = deferredMap();
    const load = async (input: { projectId: string }) => {
      if (input.projectId === "proj-a") return wikiA;
      return pendingB.promise;
    };
    const m = await mount(mapTab("proj-a", load));
    await openMap(m);
    assert.equal(showsA(m.query("[data-code-map]")?.textContent ?? ""), true);
    await m.rerender(mapTab("proj-b", load));
    assert.equal(showsA(m.query("[data-code-map]")?.textContent ?? ""), false);
    await m.rerender(mapTab("proj-a", load));
    const backOnA = m.query("[data-code-map]")?.textContent ?? "";
    assert.equal(showsA(backOnA), true, "returning to A must load A's wiki");
    assert.equal(showsB(backOnA), false);
    pendingB.resolve(wikiB);
    await m.flush();
    const stillA = m.query("[data-code-map]")?.textContent ?? "";
    assert.equal(showsA(stillA), true);
    assert.equal(showsB(stillA), false, "late B must not paint after return to A");
    m.unmount();
  });
});

describe("MemoryProjectTools browsing #1123", () => {
  it("does not fetch map or doctor detail until those disclosures open", async () => {
    const maps: string[] = [];
    const lints: string[] = [];
    const m = await mount(
      <MemoryProjectTools
        projectSlug="coder"
        projectId="p1"
        loadCodeMap={async (input) => {
          maps.push(input.projectId);
          return {
            projectId: input.projectId,
            updatedAt: Date.now(),
            fileCount: 0,
            symbolCount: 0,
            modules: [],
            dependencies: [],
          };
        }}
        lintAgentConfig={async (input) => {
          lints.push(input.projectId);
          return SAMPLE_REPORT;
        }}
      />,
    );
    await m.flush();
    assert.deepEqual(maps, []);
    assert.deepEqual(lints, []);
    m.unmount();
  });
});
