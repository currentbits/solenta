# Shared memory for AI coding agents

Review draft for SL-BRIEF-04 in issue #1837. This file is outside `site/` and is
not published. Page location, publisher identity and owner fact review are
pending.

HTML title: `Shared Memory for Claude Code, Codex and Cursor Agents`

Meta description: `One local memory server every agent in Solenta reads and writes over MCP, so the next agent starts where the last one stopped. Free and open source.`

Solenta supervises a local memory server that stores project decisions and
gotchas in SQLite with full-text and vector search. When the server is healthy,
Solenta injects it into agent sessions automatically, so a later thread can
recall what an earlier thread stored.

The server exposes HTTP and MCP on localhost and requires a bearer token. The
Memory tab lets you search, read and store entries yourself.

## What gets remembered

Entries can hold project knowledge, conventions, strategies and tasks. They
record which agent wrote them and can carry file, thread or commit citations.
Before injecting a fact with a file citation, Solenta checks it against the
current worktree and invalidates a contradicted entry.

An agent can record what it tried and ruled out in the hypothesis ledger.
Strategies preserve procedural lessons across threads. The code index gives
dispatched workers a map of project symbols.

## When a memory appears

An entry's inclusion mode controls when it is injected:

- Always includes the entry in bootstrap context.
- Glob includes it when a file in play matches its configured patterns.
- Auto uses the prompt's overlap with the entry title.
- Manual includes it when the prompt names its shortened memory ID.

Conditional entries remain searchable. You can browse older entries, filter by
type, read citations and review maintenance suggestions in the Memory tab.

Save as memory in a finished thread's menu drafts an entry for you to review
and edit before it is stored. Repositories with the same folder name receive
separate memory scopes.

## Where the data goes

The shared memory database is local. Solenta does not send it to a Solenta
cloud. Your chosen agent CLI still sends its prompts to its provider, as it
would when you ran that CLI yourself. Recalled memory included in those prompts
therefore follows that provider's normal request path.

## Using an external MCP client

The memory server exposes MCP, but a connection recipe still needs verification
before publication. The existing
[Integrations section](https://solenta.app/docs.html#integrations) documents
pairing with the separate coder-threads task server. Those pairing instructions
must not be described as memory-server configuration.

TODO: owner reviews a memory-server-specific client recipe. The repository's
`memory-server/README.md` describes the server configuration, but its default
application path still uses the former Coder name. Do not publish that path or
infer that a task-server pairing token authenticates to memory.

## Limits

Automatic injection depends on a healthy server. Stored facts can become stale,
and checking file citations does not prove every remembered statement is still
correct. Review recalled context and the resulting code changes.

Memory does not isolate working files or make a test pass. Use worktrees for
parallel edits and a verify command for checks.

## Questions

### Is memory shared across agent providers?

Solenta injects its local memory server into agent sessions when it is healthy.
Entries one thread stores can be recalled by a later thread.

### Can I inspect what agents remember?

Yes. The Memory tab lets you search, read and store entries, browse older
memories and inspect their citations. Save as memory drafts an entry for review
before storing it.

### Does local memory mean my chosen model provider receives no code or context?

No. Your chosen CLI sends prompts to its provider. Solenta keeps the memory
database local, while recalled entries included in a prompt follow that prompt.

## Sources and publication gates

All product descriptions above derive from the existing
[memory section](https://solenta.app/docs.html#memory),
[llms index](https://solenta.app/llms.txt),
[verification section](https://solenta.app/docs.html#guardrails), and
[Integrations section](https://solenta.app/docs.html#integrations).

Owner review must confirm the privacy wording and external-client recipe,
choose `/shared-memory` or `/docs/memory`, and approve the content. Then add
TechArticle, FAQPage and BreadcrumbList with the confirmed publisher, canonical,
sitemap entry, home-memory link and llms entry. If this expands a split docs
topic, retain the original section text and review this additional material
separately.
