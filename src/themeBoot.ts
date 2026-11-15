import { bootThemeFromStorage } from "./theme";
import { applyContrast } from "./contrast";
import { getHighContrastEnabled } from "./uiPrefs";
import { applyPalette, PALETTE_STORAGE_KEY, readPaletteLibrary } from "./palettes";

bootThemeFromStorage();
// Only forces the attribute ON when the user turned the toggle on; off/unset
// leaves src/index.css's `prefers-contrast: more` media query to decide.
if (getHighContrastEnabled()) applyContrast(true);
applyPalette(readPaletteLibrary());
window.addEventListener("storage", (event) => {
  if (event.key === PALETTE_STORAGE_KEY || event.key === null) applyPalette(readPaletteLibrary());
});
