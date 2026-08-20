/**
 * Pure forge-readiness helpers (issue #608).
 *
 * Run: node --experimental-strip-types --test test/sourceControl.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addProjectRemoteSourceLabel,
  buildAddProjectRemoteSourceReadiness,
  forgeReadiness,
  sortAddProjectProviderSources,
} from "../src/sourceControl.ts";
import type {
  SourceControlDiscovery,
  SourceControlProvider,
} from "../src/shared/ipc.ts";

function provider(
  over: Partial<SourceControlProvider> & Pick<SourceControlProvider, "kind">,
): SourceControlProvider {
  return {
    label:
      over.kind === "github"
        ? "GitHub"
        : over.kind === "gitlab"
          ? "GitLab"
          : over.kind === "bitbucket"
            ? "Bitbucket"
            : "Azure DevOps",
    status: "available",
    installHint: "fix-me",
    version: null,
    auth: { status: "unauthenticated", detail: "Not signed in." },
    ...over,
  };
}

function discovery(
  providers: SourceControlProvider[],
): SourceControlDiscovery {
  return { sourceControlProviders: providers, probedAt: 1 };
}

describe("forgeReadiness", () => {
  it("is ready only when available and authenticated", () => {
    const ready = forgeReadiness(
      discovery([
        provider({
          kind: "github",
          auth: { status: "authenticated", detail: "me" },
        }),
      ]),
      "github",
    );
    assert.equal(ready.ready, true);
    assert.equal(ready.hint, null);
  });

  it("does not block on an unparseable or timed-out auth check", () => {
    const unknown = forgeReadiness(
      discovery([
        provider({
          kind: "github",
          auth: { status: "unknown", detail: "Timed out checking sign-in." },
        }),
      ]),
      "github",
    );
    assert.equal(unknown.ready, true);
    assert.equal(unknown.hint, null);
  });

  it("uses the install hint when the CLI is missing", () => {
    const next = forgeReadiness(
      discovery([
        provider({
          kind: "github",
          status: "missing",
          installHint: "brew install gh",
        }),
      ]),
      "github",
    );
    assert.equal(next.ready, false);
    assert.equal(next.hint, "brew install gh");
  });

  it("uses the login detail when installed but signed out", () => {
    const next = forgeReadiness(
      discovery([
        provider({
          kind: "github",
          auth: { status: "unauthenticated", detail: "Not signed in. Run gh auth login." },
        }),
      ]),
      "github",
    );
    assert.equal(next.ready, false);
    assert.match(String(next.hint), /Not signed in/);
  });
});

describe("buildAddProjectRemoteSourceReadiness", () => {
  it("keeps Git URL ready and floats authenticated forges first", () => {
    const readiness = buildAddProjectRemoteSourceReadiness(
      discovery([
        provider({ kind: "gitlab", status: "missing", installHint: "brew install glab" }),
        provider({
          kind: "github",
          auth: { status: "authenticated", detail: "me" },
        }),
        provider({ kind: "bitbucket" }),
        provider({ kind: "azure-devops", status: "missing", installHint: "brew install azure-cli" }),
      ]),
    );
    assert.equal(readiness.url.ready, true);
    assert.equal(readiness.github.ready, true);
    assert.equal(readiness.gitlab.ready, false);
    assert.equal(readiness.gitlab.hint, "brew install glab");
    assert.deepEqual(sortAddProjectProviderSources(readiness), [
      "github",
      "azure-devops",
      "bitbucket",
      "gitlab",
    ]);
    assert.equal(addProjectRemoteSourceLabel("github"), "GitHub");
  });

  it("marks every forge unready when discovery has not loaded", () => {
    const readiness = buildAddProjectRemoteSourceReadiness(null);
    assert.equal(readiness.url.ready, true);
    assert.equal(readiness.github.ready, false);
    assert.match(String(readiness.github.hint), /Source Control/);
  });
});
