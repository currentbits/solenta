# Light-mode website screenshots

## Goal

Replace every tracked Solenta product screenshot with a deterministic light-mode capture of the same seeded product state. The public website and its social previews should show the light product UI that now matches the site's paper-and-ink presentation.

## Scope

Recapture these four assets:

- `site/assets/screen-main.png`
- `site/assets/screen-agents.png`
- `site/assets/screen-automations.png`
- `site/assets/screen-kanban.png`

Regenerate these two derived social-preview assets after `screen-main.png` changes:

- `site/assets/og.png`
- `site/assets/card.png`

The website layout, screenshot frames, social-card layout, social-card copy, and fixture content remain unchanged.

## Capture source

Use the existing browser-development fixture started with:

```sh
VITE_TRAILER=1 npm run dev:browser
```

The fixture already supplies the `acme/nebula` project, seeded threads, work log, workflow, pull request, Automations view, and Kanban view shown in the current screenshots. A fixture capture is deterministic, contains no private project data, and can be repeated when the UI changes.

The capture process must set the `solenta-theme` local-storage preference to `light`, reload the page, and wait until the document reports `data-theme="light"` before navigating or capturing.

## Capture scenes

All output screenshots use a 1680 by 1050 pixel canvas.

1. **Main:** select “Modernize Per-Device Provider Settings” and show the Environment tab.
2. **Agents:** keep the same selected thread and show the Agents tab with the seeded workflow summary.
3. **Automations:** open the Automations view and retain the Environment side panel.
4. **Kanban:** open the Kanban view and retain the Environment side panel.

The captures preserve the current seeded content and overall composition. Normalizing the output removes the current mixture of standard-resolution, Retina-resolution, and cropped assets without changing the scenes themselves.

## Capture tooling

Add a dedicated site-screenshot capture script rather than relying on ad hoc manual clicks or recoloring existing pixels. The script will:

1. Open the fixture in a hidden Electron window.
2. persist and apply the light theme;
3. remove the browser token gate used by the fixture;
4. wait for the seeded UI and fonts;
5. navigate to each named scene;
6. capture and normalize each PNG to 1680 by 1050;
7. fail if the light theme or expected view is missing.

This keeps future recaptures repeatable and avoids private data entering public assets.

## Social previews

Run `scripts/render-og.sh` after replacing `screen-main.png`. It renders the existing `site/og-card.html` template to `og.png` and copies the same result to `card.png`.

Only the embedded product screenshot changes. The existing dark card background, layout, and copy remain as they are.

## Cache behavior

The screenshot filenames stay stable, so public references need a new query version:

- `screen-main.png?v=2`
- `screen-agents.png?v=2`
- `card.png?v=2`

Update the `card.png` metadata references in `index.html`, `docs.html`, and `changelog.html` consistently. Update the visible `screen-main.png` and `screen-agents.png` references in `index.html`. The unused Automations and Kanban assets need no public query version until a page references them.

The query change is required because Girder and Cloudflare retain assets, while social crawlers cache preview images aggressively.

## Verification

Before deployment:

1. Confirm all four `screen-*.png` files are 1680 by 1050.
2. Inspect all four captures and both social cards visually.
3. Confirm the captures show light backgrounds and the expected selected view.
4. Run the existing site download tests.
5. Confirm all website screenshot and social metadata references use the new query version.

After deployment:

1. Request each versioned public image and require HTTP 200.
2. Confirm the live page references the versioned assets.
3. Inspect the live homepage at desktop and mobile widths.
4. Confirm the deployed social-card URL returns the regenerated image.

## Non-goals

- Redesigning the website or screenshot frames
- Changing social-card copy or art direction
- Replacing seeded fixture content with live user data
- Adding new screenshot sections to the website
- Changing the application's light-theme tokens
