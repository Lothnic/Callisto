#!/usr/bin/env bash
# Build this checkout and register its stable launcher with a local MCP host.
set -euo pipefail
backend=${1:-}
host=${2:-}
case "$backend" in chromium|zen|firefox) ;; *) echo 'Usage: bash scripts/install-local.sh <chromium|zen|firefox> <codex|claude>' >&2; exit 2;; esac
case "$host" in codex|claude) ;; *) echo 'Choose codex or claude as the MCP host.' >&2; exit 2;; esac
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
command -v node >/dev/null
command -v "$host" >/dev/null
node -e 'if(Number(process.versions.node.split(".")[0])<20)process.exit(1)' || { echo 'Node.js 20+ is required.' >&2; exit 1; }
if [ "$backend" = chromium ]; then
  npm --prefix "$root/packages/mini" ci --no-audit --no-fund
  npm --prefix "$root/packages/mini" run build
else
  command -v cargo >/dev/null
  cargo build --locked --release --manifest-path "$root/packages/firefox-rs/Cargo.toml" --bin callisto-firefox-tab-mcp
fi
node "$root/scripts/callisto.mjs" setup "$backend" "$host"
