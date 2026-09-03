#!/usr/bin/env bash
# Capture muse exec --json fixtures for Solenta's muse-json parser.
# Spec: docs/superpowers/specs/2026-09-03-muse-code-provider-design.md
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/electron/test/fixtures/muse"
mkdir -p "$OUT"

export PATH="${HOME}/.local/bin:${PATH}"
if ! command -v muse >/dev/null 2>&1; then
  echo "STOP: muse is not on PATH. Install Muse Code yourself, then rerun." >&2
  echo "Human install (do not pipe this from an agent): see https://dev.meta.ai/docs/muse-code" >&2
  exit 1
fi

muse --help > "$OUT/help.txt" 2>&1 || true
{ muse exec --help || true; } >> "$OUT/help.txt" 2>&1

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/muse-capture.XXXXXX")"
printf 'console.log("hi")\n' > "$WORKDIR/hi.js"
(
  cd "$WORKDIR"
  muse exec --json --provider echo --trust-workspace --approval-mode never \
    "Reply with the single word hello and do not use tools." \
    > "$OUT/echo-hello.jsonl" 2>"$OUT/echo-hello.stderr"
  muse exec --json --provider echo --trust-workspace --approval-mode never \
    "List the files in this directory using your tools, then stop." \
    > "$OUT/echo-tools.jsonl" 2>"$OUT/echo-tools.stderr"
  if [[ -n "${META_API_KEY:-}" ]]; then
    muse exec --json --trust-workspace --approval-mode never \
      --model muse-spark-1.3 \
      "Reply with the single word hello." \
      > "$OUT/spark-hello.jsonl" 2>"$OUT/spark-hello.stderr" || true
  fi
)
rm -rf "$WORKDIR"

{
  echo "# Muse capture notes"
  echo
  for name in MUSE_HOME XDG_CONFIG_HOME XDG_DATA_HOME HOME; do
    if grep -q "$name" "$OUT/help.txt"; then
      echo "- help mentions $name: yes"
    else
      echo "- help mentions $name: no"
    fi
  done
  echo
  echo "- echo-hello lines: $(grep -c . "$OUT/echo-hello.jsonl" || true)"
  echo "- echo-tools lines: $(grep -c . "$OUT/echo-tools.jsonl" || true)"
  echo "- Record the JSON path of the session id and tool names here after reading the files."
  echo "- Record the hooks.json / managed_hooks_path shape from help or docs."
} > "$OUT/CAPTURE.md"
echo "wrote $OUT"
