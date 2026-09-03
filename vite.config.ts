import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Same stamp scripts/package-app.sh writes into the bundled package.json.
 * After downloadUpdate swaps the on-disk bundle, a renderer reload can load
 * new JS into an old main/preload; comparing this against app.status().build.sha
 * is how we catch that without a new IPC channel.
 */
function packagedBuildSha(): string | null {
  try {
    const sha = execSync("git rev-parse --short HEAD 2>/dev/null || echo unknown", {
      encoding: "utf8",
      shell: true,
    }).trim();
    let dirty = "";
    try {
      execSync("git diff --quiet 2>/dev/null", { shell: true });
    } catch {
      dirty = "+dirty";
    }
    return `${sha}${dirty}`;
  } catch {
    return null;
  }
}

export default defineConfig({
  plugins: [react()],
  define: { __BUILD_SHA__: JSON.stringify(packagedBuildSha()) },
  base: "./",
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // AudioWorklet addModule is a script load; CSP script-src 'self'
    // blocks data: URLs, so this file must stay a real same-origin asset.
    assetsInlineLimit(filePath, content) {
      if (String(filePath).includes("pcmWorklet")) return false;
      return content.length < 4096;
    },
  },
});
