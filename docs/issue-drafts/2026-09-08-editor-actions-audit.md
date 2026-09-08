# Editor and settings action audit

Commit: `6c7a6fbebb066942f7f5702084f1af1e0730319d`. Roadmap: https://github.com/currentbits/solenta/issues/1135

- **P1** Config doctor can write to a different project using a stale preview and confirmation
- **P2** Workflow editor silently discards drafts and lets an old save overwrite a reopened editor
- **P2** Successful workflow saves are reported as failures when refresh rejects, causing duplicates on retry
- **P2** Local MCP setup corrupts quoted paths and arguments containing spaces

Five current-defect assertions passed (exit 0) using real React components in jsdom, real useCoder for the workflow save/refresh case, and real MCP argument validation. All callbacks and stored rows were synthetic. No actual config files, workflows, MCP settings, agents or commands were changed/launched. This is functional interaction evidence, not desktop visual verification.

```sh
node --import=./test/support/disable-grok-mcp.mjs --import=./test/support/render.mjs --experimental-strip-types docs/issue-drafts/2026-09-08-editor-actions-evidence.mjs
```

MemoryTab, WorkflowsModal, SkillsTab and useCoder file blobs matched the default branch during verification. The issue bodies contain reproductions, root causes, acceptance criteria and duplicate distinctions. Canonical URLs are recorded in [publication metadata](2026-09-08-editor-actions-publication.json); full drafts are in [audit JSON](2026-09-08-editor-actions-audit.json).

Scope stayed on new behavior: Memory browsing/navigation is already #1123, Skills layout is #1125, pending automation duplicates are #941, Composer drafts are #921 and thread notes are #935. No production source edits were made.

