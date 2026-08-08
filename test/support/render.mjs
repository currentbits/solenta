// Entry for --import: registers the hooks in test/support/render-hooks.mjs.
import { register } from "node:module";
register("./render-hooks.mjs", import.meta.url);
