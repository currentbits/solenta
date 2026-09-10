/**
 * Tokenize the Skills local-MCP arguments field.
 *
 * Documented formats:
 * - POSIX-like argv: whitespace separates tokens; `'single'` is literal;
 *   `"double"` treats `\"` and `\\` as escapes; a bare `\` escapes the next
 *   character. No shell expansion or substitution.
 * - A JSON array of strings, when the trimmed field parses as one.
 *
 * Invalid quoting or a JSON array that is not all strings is an error.
 */

export type ParseMcpArgvResult =
  | { ok: true; args: string[] }
  | { ok: false; error: string };

const BAD_CHARS_RE = /[\0\r\n]/;

export function parseMcpArgv(raw: string): ParseMcpArgvResult {
  if (BAD_CHARS_RE.test(raw)) {
    return { ok: false, error: "Arguments must not contain CR, LF, or NUL" };
  }
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, args: [] };

  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        if (!parsed.every((item) => typeof item === "string")) {
          return {
            ok: false,
            error: "Arguments JSON must be an array of strings",
          };
        }
        if (parsed.some((item) => BAD_CHARS_RE.test(item))) {
          return {
            ok: false,
            error: "Arguments must not contain CR, LF, or NUL",
          };
        }
        return { ok: true, args: parsed };
      }
    } catch {
      // Not a JSON array; fall through to argv tokenization.
    }
  }

  return tokenizeArgv(trimmed);
}

function tokenizeArgv(input: string): ParseMcpArgvResult {
  const args: string[] = [];
  let current = "";
  let started = false;
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  const flush = () => {
    if (!started) return;
    args.push(current);
    current = "";
    started = false;
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escaped) {
      current += ch;
      escaped = false;
      started = true;
      continue;
    }

    if (ch === "\\" && !inSingle) {
      if (inDouble) {
        const next = input[i + 1];
        if (next === '"' || next === "\\") {
          escaped = true;
          started = true;
          continue;
        }
        current += ch;
        started = true;
        continue;
      }
      escaped = true;
      started = true;
      continue;
    }

    if (!inSingle && !inDouble && (ch === " " || ch === "\t")) {
      flush();
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      started = true;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      started = true;
      continue;
    }

    current += ch;
    started = true;
  }

  if (escaped) {
    return { ok: false, error: "Arguments end with a dangling backslash escape" };
  }
  if (inSingle || inDouble) {
    return { ok: false, error: "Unclosed quote in arguments" };
  }
  flush();
  return { ok: true, args };
}
