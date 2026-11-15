# Color palettes

In **Settings → General → Color palette**, choose Solenta, Midnight or Forest. Each has light and dark colors; **Theme** still controls whether the app follows the OS or stays Light/Dark.

Selecting a palette previews it immediately, including mounted terminals and Mermaid diagrams. **Apply palette** saves it on this device. **Cancel preview**, closing Settings or leaving General restores the saved palette. Other display preferences still save separately. Increased contrast, whether enabled in Solenta or by the OS, uses the default Solenta colors without forgetting the selected palette.

## Import and export

Export a preset as a starting point. Edit its `id`, `name` and colors, then use **Import JSON**. The import is a preview until applied. Imported palettes are listed separately; importing the same custom ID replaces its saved definition only after Apply. Built-in definitions are never replaced. **Remove palette** also needs Apply; Cancel restores it.

The version 1 format has exactly these top-level fields:

| Field | Value |
| --- | --- |
| `format` | `"solenta-palette"` |
| `version` | `1` |
| `id` | A lowercase letter followed by lowercase letters, digits or hyphens; at most 40 characters |
| `name` | A nonempty name, at most 60 characters |
| `light`, `dark` | Objects containing every color role below, each as a solid `#RRGGBB` color |

Color roles: `bg`, `bg-elevated`, `panel`, `card`, `card-hover`, `border`, `border-soft`, `text`, `text-body`, `text-muted`, `text-dim`, `text-on-accent`, `accent`, `accent-hover`, `accent-edge`.

Imports are limited to 16 KiB and the library to 20 custom palettes. Text must meet 4.5:1 contrast against the core surfaces, primary button text must meet 4.5:1 against both accent colors, and accent edges must meet 3:1. Core surfaces must also keep the existing status hues readable. Invalid imports leave the current preview unchanged. A storage failure stays visible and leaves the saved library unchanged.

Palettes change core surfaces, text, accents and derived accent washes. Status, diff and syntax hues continue to follow the existing light/dark appearance. Contrast validation is a guard for these core roles, not a full accessibility certification of every composed surface.

The palette library is a local display preference in this client. It is not written to project files, sent to an agent or published to other computers. Windows sharing the same browser storage adopt a saved palette change. Solenta falls back to its built-in palette if stored data is corrupt or inaccessible.

Arbitrary CSS, VS Code theme conversion, an interactive color editor and agent theme tools are outside this version.
