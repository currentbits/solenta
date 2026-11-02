# Remaining SEO work for review

These are unpublished drafts for the remaining content tasks in
[issue #1837](https://github.com/currentbits/solenta/issues/1837). The technical
fixes shipped in PR #1838. This follow-up prepares the material that the audit
requires the owner to review before publication.

Read these in order:

1. [Parallel-agent guide](run-coding-agents-in-parallel.md), including its
   command-verification record. The implemented version is in `site-content/`.
2. [Shared-memory draft](shared-memory.md), especially the separate MCP-server
   distinction. The implemented connection recipe passed a local MCP handshake.
3. [Comparison evidence](comparison-facts.md). Each proposed competitor fact
   links to a primary source and a checked date. Unknowns remain explicit.

## Approved owner choices, 2 November 2026

The owner answered “Approve proposed set” in thread
90c66c3d-9bd1-4a14-a4c6-7935a759cf67. These choices are approved and implemented
in draft PR #1839.

| Decision | Approved choice |
| --- | --- |
| Advertised providers and issue trackers | Include Muse Code; advertise GitHub and GitLab consistently with current docs |
| Publisher name | Solenta |
| Organization logo | `https://solenta.app/assets/icon.svg`, the existing square icon |
| Organization profiles | `https://github.com/currentbits/solenta` and `https://x.com/currentbitsNET` |
| Home H1 | Option B: `Run AI coding agents in parallel, with shared memory`; move the slogan above it |
| Docs URL scheme | `/docs/<id>` using existing H2 IDs |
| Shared-memory location | Expand `/docs/memory` after the docs split |
| First comparisons | Conductor and Claude Squad at the URLs in the evidence document |

The original issue says the owner must make these decisions before the
dependent implementation. It separately requires owner review of new copy and
competitor facts before publishing. Approval of the choices above unlocks the
schema, consistency, H1 and docs work; it does not silently approve new copy,
verdicts or unknown comparison cells.

## Implementation prepared in PR #1839

- Apply the provider and tracker wording together across home, its visible FAQ,
  FAQ schema, docs and llms.txt. Preserve the FAQ mirror and rebuild llms-full.
- Add the confirmed Organization and publisher references, docs TechArticle and
  breadcrumbs, and changelog WebPage. Validate release version and dates.
- Change the H1 using the selected wording.
- Split existing docs sections without rewriting their content. Preserve old
  section links, the Pages mirror and generated llms content, then update the
  sitemap and internal links.
- Prepare the new content as static pages in a reviewable PR. Keep publication
  gated on the required fact and copy sign-off.

## Verification status

All shell commands in the guide passed in a disposable repository on 2 November
2026, using Git 2.55.0. Distinct branches and working files were checked, and
non-forced cleanup left only the original checkout. All links to existing docs
anchors resolve in the current source. The drafts contain no em dashes.

The production web reader returned cached content and could not read the XML
sitemap. It cannot establish the current public response headers or substitute
for a new production Lighthouse run. The earlier Solenta shell-egress rejection
therefore remains a verification limit, not a passed acceptance check. Origin
deployment, health, file hashes and headers were verified through Girder after
the first PR shipped.

Cloudflare www redirects, respect-origin cache TTL, HSTS and later CSP
enforcement remain the owner dashboard steps listed in the original audit.

## Concrete publication review

Review the generated pages through the Markdown and HTML sources in
`site-content/`. The comparison opening verdicts and choose-if lists are
proposals for the owner to edit or adopt; they are not recorded as owner-written.
Unassessed competitor capabilities must be resolved or approved as a narrower
comparison scope before publication. Approving competitors alone does not close
the audit's fact-review gate.

The external memory recipe passed a real SDK Streamable HTTP MCP connection to
an isolated in-memory fixture: unauthenticated requests returned 401;
authenticated initialization and tools/list worked. No user database or model
request was used.

The docs tests preserve every original section and nested ID. They compare
llms-full with the source after removing additive expansions and normalizing
changed link destinations. nginx verifies all 36 canonical pages, topic
slash/index redirects with queries, headers and real missing-page 404s.
