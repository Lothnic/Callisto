#!/usr/bin/env bash
# Install the pinned experimental Callisto MCP runtime from its public repository.
set -euo pipefail

revision='f36ee0fe625ca842773671089f3b8ac8cf342291'
repository='https://github.com/Lothnic/Callisto.git'
install_dir="${CALLISTO_INSTALL_DIR:-${XDG_DATA_HOME:-${HOME:?HOME is required}/.local/share}/callisto}"

for tool in git node npm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Callisto requires %s. Install it and try again.\n' "$tool" >&2
    exit 1
  fi
done
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
tmp_dir=$(mktemp -d "$parent_dir/.callisto-install.XXXXXXXX")
cleanup() { if [ -n "$tmp_dir" ]; then rm -rf -- "$tmp_dir"; fi; }
trap cleanup EXIT

echo 'Downloading the pinned Callisto source…'
git -C "$tmp_dir" init -q
git -C "$tmp_dir" remote add origin "$repository"
git -C "$tmp_dir" -c advice.detachedHead=false fetch -q --depth 1 origin "$revision"
git -C "$tmp_dir" -c advice.detachedHead=false checkout -q --detach FETCH_HEAD

echo 'Installing dependencies and building Mini…'
npm --prefix "$tmp_dir/packages/mini" ci --no-audit --no-fund
npm --prefix "$tmp_dir/packages/mini" run build

# Avoid moving into an existing destination if another process created it.
if [ -e "$install_dir" ] || [ -L "$install_dir" ]; then
  printf 'Installation path appeared during installation: %s\n' "$install_dir" >&2
  exit 1
fi
mv -- "$tmp_dir" "$install_dir"
tmp_dir=''

printf '\nCallisto is installed at %s\n' "$install_dir"
printf 'Chrome or Chromium must be installed separately. Set CHROME_PATH if needed.\n'
printf '\nAdd this to a compatible stdio MCP host (adapt the wrapper to your host):\n'
node -e 'console.log(JSON.stringify({mcpServers:{callisto:{command:process.execPath,args:[process.argv[1]+"/packages/mini/dist/mcp.js"]}}},null,2))' "$install_dir"
printf '\nFor OpenCode and troubleshooting, see https://github.com/Lothnic/Callisto#readme\n'
