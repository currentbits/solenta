# Marketing site sources

Run `npm run build:site` after editing these files. Generated HTML, llms-full.txt
and sitemap.xml are committed under `site/`; nginx and GitHub Pages serve those
files without a build step. CI regenerates the site and rejects stale output.

- `docs.html` is the full docs source and the shared page-shell template. Keep
  its H2 IDs stable: they determine `/docs/<id>` URLs and legacy anchor redirects.
  Edit existing documentation here, rather than in generated `site/docs.html`
  or `site/docs/*/index.html`. Topic order also determines llms-full.txt order.
- `docs-metadata.json` holds the topic descriptions. The split preserves the
  existing section bodies; generated introductions repeat source sentences.
- `docs-<id>.html` adds content to a topic without rewriting its source section.
- Markdown files provide the guide, comparisons and alternatives page. Their
  metadata lives beside the rendering calls in `scripts/build-site-content.js`.
  The guide and comparisons' Questions sections become visible FAQ details and
  matching FAQPage schema. Use one H3 question followed by one answer paragraph.

The homepage and changelog remain authored in `site/`. The metadata builder
updates their schema, release version and old docs links. When changing the
shared footer, update those two pages and this directory's docs.html template.
Changing shared CSS requires bumping its version in the template and authored
pages. Keep the canonical PNGs and their capture version unchanged when only
editing content.

Nested pages are directory indexes for the GitHub Pages mirror. Their relative
base resolves assets to the site's root on either host. nginx serves the clean
canonical path and redirects the trailing slash and index.html variants.

New comparison copy and competitor facts require owner review before these
candidate files ship. The review record and unresolved research are in
`docs/seo-drafts/`; those files are outside the published site.
