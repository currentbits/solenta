/**
 * Onboarding tour step (#631): seven docs-linked feature cards, plus starter
 * prompts on the no-thread empty state when a project exists.
 *
 * Run: node --import=./test/support/render.mjs --test test/onboardingTour.test.tsx
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mount, unmountAll } from "./support/dom.ts";
import { createFakeCoder, installFakeCoder } from "./support/fakeCoder.ts";
import App from "../src/App";
import { ThreadView } from "../src/components/ThreadView";
import type {
  ProjectInfo,
  ProviderInfo,
  WorkflowTemplateInfo,
} from "../src/shared/ipc";

const DOCS = "https://solenta.app/docs.html";

const TOUR_CARDS: ReadonlyArray<{ slug: string; href: string | null }> = [
  { slug: "threads", href: `${DOCS}#threads` },
  { slug: "workers", href: `${DOCS}#orchestration` },
  { slug: "worktrees", href: `${DOCS}#worktrees` },
  { slug: "review", href: `${DOCS}#review` },
  { slug: "memory", href: `${DOCS}#memory` },
  { slug: "modes", href: `${DOCS}#spec` },
  { slug: "shortcuts", href: null },
];

const project: ProjectInfo = {
  id: "p1",
  slug: "owner/repo",
  name: "repo",
  path: "/tmp/repo",
};

const providers: ProviderInfo[] = [
  {
    id: "claude",
    name: "Claude Code",
    available: true,
    supportsResume: true,
    models: [],
    modelInfo: [],
    efforts: [],
  },
];

const noopAsync = async () => {};
const noopSave = async () =>
  ({ id: "wf", name: "standard", phases: [] }) as WorkflowTemplateInfo;

function emptyView(over: { hasProjects?: boolean } = {}) {
  return (
    <ThreadView
      detail={null}
      project={over.hasProjects === false ? null : project}
      providers={providers}
      workflows={[]}
      hasProjects={over.hasProjects ?? true}
      onAddProject={() => {}}
      onStartRun={() => {}}
      onStartWorkflow={() => {}}
      onSaveWorkflow={noopSave}
      onRemoveWorkflow={noopAsync}
      onStopRun={() => {}}
      onSetPermissionMode={() => {}}
      onRespondPermission={() => {}}
      onSetProvider={() => {}}
      onSetReasoningEffort={() => {}}
      onSetArchived={() => {}}
      onDeleteThread={() => {}}
      changesOpen={false}
      changesNonce={0}
      onCloseChanges={() => {}}
      onFetchDiff={async () => ({ files: [], patch: "", truncated: false })}
      onCommitChanges={async () => ({ subject: "x" })}
      onRevertFile={async (path) => ({ path })}
      onSuggestCommitMessage={async () => ({ message: "feat: x" })}
      onPush={async () => ({ remote: "origin", branch: "main" })}
    />
  );
}

async function boot(
  fake: ReturnType<typeof createFakeCoder>,
): Promise<Awaited<ReturnType<typeof mount>>> {
  const shell = await mount(<div />);
  installFakeCoder(fake);
  shell.unmount();
  return mount(<App />);
}

afterEach(unmountAll);

describe("Onboarding tour step (#631)", () => {
  it("renders seven feature cards with docs hrefs after three Next clicks", async () => {
    const fake = createFakeCoder({ settings: { onboardingSeen: false } });
    const m = await boot(fake);
    const next = m.query("[data-onboarding-next]");
    assert.ok(next, "Next control must exist");

    await m.click(next);
    await m.click(next);
    await m.click(next);

    assert.equal(
      m.query("[data-onboarding-step]")?.getAttribute("data-onboarding-step"),
      "tour",
      "three Next clicks must land on the tour step",
    );
    assert.ok(
      m.query("[data-onboarding-tour]"),
      "tour step must expose data-onboarding-tour",
    );

    const cards = m.queryAll("[data-onboarding-tour-card]");
    assert.equal(
      cards.length,
      TOUR_CARDS.length,
      `tour must render ${TOUR_CARDS.length} cards, got ${cards.length}`,
    );

    for (const { slug, href } of TOUR_CARDS) {
      const card = m.query(`[data-onboarding-tour-card="${slug}"]`);
      assert.ok(card, `tour card "${slug}" must be present`);
      const link = card.querySelector("a");
      if (href) {
        assert.ok(link, `tour card "${slug}" must have a Learn more link`);
        assert.equal(
          link.getAttribute("href"),
          href,
          `tour card "${slug}" must link to ${href}`,
        );
        assert.equal(
          link.getAttribute("target"),
          "_blank",
          `tour card "${slug}" Learn more must open in a new tab`,
        );
        assert.equal(
          link.getAttribute("rel"),
          "noreferrer",
          `tour card "${slug}" Learn more must set rel=noreferrer`,
        );
      } else {
        assert.ok(
          !link,
          `tour card "${slug}" must not have an external docs link`,
        );
      }
    }
    m.unmount();
  });
});

describe("ThreadView empty-state starters (#631)", () => {
  it("shows three Try asking chips when a project exists and no thread is selected", async () => {
    const m = await mount(emptyView());
    const starters = m.query("[data-empty-starters]");
    assert.ok(
      starters,
      "no-thread empty state with a project must show data-empty-starters",
    );
    const items = starters.querySelectorAll("li");
    assert.equal(
      items.length,
      3,
      `starter list must have 3 items, got ${items.length}`,
    );
    m.unmount();
  });

  it("does not show starter prompts when no project is registered", async () => {
    const m = await mount(emptyView({ hasProjects: false }));
    assert.ok(
      !m.query("[data-empty-starters]"),
      "no-projects empty state must not show starter prompts",
    );
    m.unmount();
  });
});
