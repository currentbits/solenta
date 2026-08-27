/**
 * Grok image_gen / image_edit replies with JSON
 * `{ type, path, filename, session_folder }` and then writes markdown
 * `![alt](images/N.jpg)`. The abs path is not in the worktree.
 */

const IMAGE_TYPES = new Set(["ImageGen", "ImageEdit"]);
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

export function sessionImagePathsFromMessages(
  messages: ReadonlyArray<{ tool?: { output?: string | null } | null }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of messages) {
    const rec = parseSessionImage(m.tool?.output);
    if (!rec) continue;
    if (rec.session_folder) {
      out[`${rec.session_folder}/${rec.filename}`] = rec.path;
    }
    out[rec.filename] = rec.path;
  }
  return out;
}

function parseSessionImage(
  raw: string | null | undefined,
): { path: string; filename: string; session_folder?: string } | null {
  if (!raw || raw[0] !== "{") return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  if (!IMAGE_TYPES.has(String(rec.type || ""))) return null;
  const imagePath = String(rec.path || "");
  const filename = String(rec.filename || "");
  if (!imagePath || !filename || !IMAGE_EXT.test(filename)) return null;
  const session_folder =
    typeof rec.session_folder === "string" && rec.session_folder
      ? rec.session_folder
      : undefined;
  return { path: imagePath, filename, session_folder };
}
