import { bootThemeFromStorage } from "./theme";
import { applyContrast } from "./contrast";
import { getHighContrastEnabled } from "./uiPrefs";

bootThemeFromStorage();
// Only forces the attribute ON when the user turned the toggle on; off/unset
// leaves src/index.css's `prefers-contrast: more` media query to decide.
if (getHighContrastEnabled()) applyContrast(true);
