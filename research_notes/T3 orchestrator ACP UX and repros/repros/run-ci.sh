#!/bin/sh
# CI-comparable: empty env (no inherited CODER_*), minimal PATH.
cd /tmp/solenta-repro || exit 1
exec env -i HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" LANG=en_US.UTF-8 \
  PATH="/Users/willem/.hermes/node/bin:/tmp/solenta-ci-bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  CODER_GROK_MCP_DISABLE=1 CODER_CURSOR_MCP_DISABLE=1 CODER_KIMI_MCP_PATH=/tmp/solenta-ci-worker-kimi.json \
  node --import=./test/support/render.mjs --experimental-strip-types --test --test-concurrency=1 "$@"
