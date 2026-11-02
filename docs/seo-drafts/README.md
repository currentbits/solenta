# Remaining SEO work for review

These are unpublished drafts for the remaining content tasks in
[issue #1837](https://github.com/currentbits/solenta/issues/1837). The technical
fixes shipped in PR #1838. This follow-up prepares the material that the audit
requires the owner to review before publication.

Read these in order:

1. [Parallel-agent guide](run-coding-agents-in-parallel.md), including its
   command-verification record. The guide is complete enough for copy review.
2. [Shared-memory draft](shared-memory.md), especially the separate MCP-server
   distinction and the connection recipe still needing verification.
3. [Comparison evidence](comparison-facts.md). Each proposed competitor fact
   links to a primary source and a checked date. Unknowns remain explicit.

## Proposed owner choices

These proposals are not recorded as approved until the owner answers.

| Decision reserved for the owner | Proposed choice |
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
schema, consistency, H1 and docs work; it does not silently approve unknown
comparison cells or the unfinished external-memory-client recipe.

## Implementation once choices are confirmed

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
