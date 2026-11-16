#!/usr/bin/env bash
# Install the pinned experimental Callisto MCP runtime from its public repository.
set -euo pipefail

revision='70f3eef9f20198ec0e14f5432c06b6757b1d284a'
repository='https://github.com/Lothnic/Callisto.git'
backend='zen'
host=''
usage() {
  printf 'Usage: bash install.sh [--backend zen|firefox|chromium] [--host codex|claude|opencode]\n'
  printf 'Default: build the Firefox/Zen extension bridge and print MCP configuration.\n'
  printf 'Requires Git, Node.js 20+ and Cargo/Rust (or npm for Chromium).\n'
  printf 'CALLISTO_INSTALL_DIR selects a new installation directory. Existing paths are preserved.\n'
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --backend|--host)
      if [ "$#" -lt 2 ]; then usage >&2; exit 2; fi
      if [ "$1" = --backend ]; then backend=$2; else host=$2; fi
      shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
case "$backend" in zen|firefox|chromium) ;; *) usage >&2; exit 2 ;; esac
case "$host" in ''|codex|claude|opencode) ;; *) usage >&2; exit 2 ;; esac
case "$(uname -s)" in
  Linux|Darwin) ;;
  *) printf 'This source installer supports Linux and macOS. The Firefox/Zen relay does not support Windows yet.\n' >&2; exit 1 ;;
esac
data_dir="${XDG_DATA_HOME:-${HOME:?HOME is required}/.local/share}"
if [ "$backend" = chromium ]; then default_dir="$data_dir/callisto"; else default_dir="$data_dir/callisto-$backend"; fi
install_dir="${CALLISTO_INSTALL_DIR:-$default_dir}"

build_tool='cargo'
if [ "$backend" = chromium ]; then build_tool='npm'; fi
for tool in git node "$build_tool" ${host:+"$host"}; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Callisto requires %s. Install it and try again.\n' "$tool" >&2
    exit 1
  fi
done
if [ "$build_tool" = cargo ]; then
  printf 'Building the Firefox/Zen bridge from source requires Rust and a native linker.\n'
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
  printf 'Callisto requires Node.js 20 or newer.\n' >&2
  exit 1
fi
if [ -e "$install_dir" ] || [ -L "$install_dir" ]; then
  printf 'Installation path already exists: %s\nChoose a new path with CALLISTO_INSTALL_DIR; no files were changed.\n' "$install_dir" >&2
  exit 1
fi

parent_dir=$(dirname "$install_dir")
mkdir -p "$parent_dir"
install_dir="$(cd -- "$parent_dir" && pwd)/$(basename "$install_dir")"
tmp_dir=$(mktemp -d "$parent_dir/.callisto-install.XXXXXXXX")
cleanup() { if [ -n "$tmp_dir" ]; then rm -rf -- "$tmp_dir"; fi; }
trap cleanup EXIT

echo 'Downloading the pinned Callisto source…'
git -C "$tmp_dir" init -q
git -C "$tmp_dir" remote add origin "$repository"
git -C "$tmp_dir" -c advice.detachedHead=false fetch -q --depth 1 origin "$revision"
git -C "$tmp_dir" -c advice.detachedHead=false checkout -q --detach FETCH_HEAD

if [ "$backend" = chromium ]; then
  echo 'Installing dependencies and building isolated Chromium Mini…'
  npm --prefix "$tmp_dir/packages/mini" ci --no-audit --no-fund
  npm --prefix "$tmp_dir/packages/mini" run build
  test -f "$tmp_dir/packages/mini/dist/mcp.js"
else
  echo 'Building the Firefox/Zen extension bridge…'
  cargo build --locked --release --manifest-path "$tmp_dir/packages/firefox-rs/Cargo.toml" --bin callisto-firefox-tab-mcp
  "$tmp_dir/packages/firefox-rs/target/release/callisto-firefox-tab-mcp" --version
fi

# Avoid moving into an existing destination if another process created it.
if [ -e "$install_dir" ] || [ -L "$install_dir" ]; then
  printf 'Installation path appeared during installation: %s\n' "$install_dir" >&2
  exit 1
fi
mv -- "$tmp_dir" "$install_dir"
tmp_dir=''

printf '\nCallisto %s is installed at %s\n' "$backend" "$install_dir"
printf '\nMCP configuration:\n'
node -e 'console.log(JSON.stringify({mcpServers:{["callisto-"+process.argv[2]]:{command:process.execPath,args:[process.argv[1]+"/scripts/callisto.mjs",process.argv[2]]}}},null,2))' "$install_dir" "$backend"
printf '\nOpenCode (run in the project that should use Callisto):\n'
printf 'opencode mcp add callisto-%s -- ' "$backend"
printf '%q ' "$(command -v node)" "$install_dir/scripts/callisto.mjs" "$backend"
printf '\n'
for target_host in codex claude; do
  printf '\n%s registration:\n' "$target_host"
  printf '%q ' "$(command -v node)" "$install_dir/scripts/callisto.mjs" setup "$backend" "$target_host"
  printf '\n'
done
if [ -n "$host" ]; then
  printf '\nRegistering with %s…\n' "$host"
  if [ "$host" = opencode ]; then
    opencode mcp add "callisto-$backend" -- "$(command -v node)" "$install_dir/scripts/callisto.mjs" "$backend"
  else
    node "$install_dir/scripts/callisto.mjs" setup "$backend" "$host"
  fi
else
  printf '\nAdd the configuration above to your host, or run its printed registration command.\n'
fi
if [ "$backend" = chromium ]; then
  printf '\nThis is isolated Chromium: install Chrome/Chromium separately; set CHROME_PATH if needed.\n'
  printf 'It does not pair with the Firefox/Zen extension. Use --backend zen for existing Firefox/Zen tabs.\n'
else
  printf '\nInstall Callisto Bridge in Firefox 140+ or a compatible Zen build:\nhttps://addons.mozilla.org/en-US/firefox/addon/callisto/\n'
  printf 'Restart your agent/MCP connection, ask it to call callisto_pair, then enter the code in the extension and Share this tab.\n'
  printf 'If you previously configured Chromium Mini, disable that old MCP entry or explicitly ask your agent to use callisto-%s.\n' "$backend"
fi
printf '\nSetup and troubleshooting: https://github.com/Lothnic/Callisto/blob/main/docs/getting-started.md\n'
