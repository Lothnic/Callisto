#!/usr/bin/env bash
# Build Callisto Browser for Linux using the BrowserOS build CLI.
#
# New BrowserOS CLI (bos_build):
#   browseros source ensure --root DIR
#   browseros build --preset release --chromium-src DIR/src ...
#
# Prerequisites:
#   - BROWSEROS_SRC or default clone at ~/src/BrowserOS/packages/browseros
#   - ./scripts/sync-upstream.sh (or use BROWSEROS_SRC directly)
#   - Chromium at CHROMIUM_VERSION (browseros source ensure)
#   - Linux deps: ./scripts/install-linux-deps.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BROWSEROS_SRC="${BROWSEROS_SRC:-$HOME/src/BrowserOS/packages/browseros}"
WORK="${CALLISTO_BROWSER_WORK:-$ROOT/.work/browseros}"
VENV="${CALLISTO_BROWSER_VENV:-$HOME/src/browseros-venv}"
CHROMIUM_ROOT="${CHROMIUM_ROOT:-$HOME/src/chromium}"

usage() {
  cat <<EOF
Usage: $0 [options]

Options:
  --chromium-src DIR   Path to chromium src/ (default: \$CHROMIUM_ROOT/src)
  --chromium-root DIR  gclient root for source ensure (default: $CHROMIUM_ROOT)
  --sync               Sync BrowserOS into .work and overlay Callisto branding
  --ensure-source      Run browseros source ensure (shallow) before build
  --prep-only          Sync + install CLI only
  --no-download        Skip R2 resource download (if credentials missing)
  --list               List build modules
  -h, --help
EOF
}

CHROMIUM_SRC="${CHROMIUM_SRC:-}"
DO_SYNC=0
ENSURE=0
PREP_ONLY=0
LIST=0
NO_DOWNLOAD=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --chromium-src) CHROMIUM_SRC="$2"; shift 2 ;;
    --chromium-root) CHROMIUM_ROOT="$2"; shift 2 ;;
    --sync) DO_SYNC=1; shift ;;
    --ensure-source) ENSURE=1; shift ;;
    --prep-only) PREP_ONLY=1; shift ;;
    --no-download) NO_DOWNLOAD=1; shift ;;
    --list) LIST=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage; exit 1 ;;
  esac
done

# Prefer Chromium-checkout depot_tools (bootstrapped by gclient) and the real
# `gn` under buildtools/linux64. A bare ~/src/depot_tools may lack
# python3_bin_reldir.txt; depot_tools' gn wrapper needs the real binary first.
_DT="${CHROMIUM_ROOT}/depot_tools"
_GN_DIR=""
if [[ -x "${CHROMIUM_ROOT}/src/buildtools/linux64/gn" ]]; then
  _GN_DIR="${CHROMIUM_ROOT}/src/buildtools/linux64"
elif [[ -n "${CHROMIUM_SRC:-}" && -x "${CHROMIUM_SRC}/buildtools/linux64/gn" ]]; then
  _GN_DIR="${CHROMIUM_SRC}/buildtools/linux64"
fi
_PATH_PREFIX="${HOME}/.local/bin"
[[ -n "$_GN_DIR" ]] && _PATH_PREFIX="${_GN_DIR}:${_PATH_PREFIX}"
[[ -d "$_DT" ]] && _PATH_PREFIX="${_PATH_PREFIX}:${_DT}"
export PATH="${_PATH_PREFIX}:${HOME}/src/depot_tools:${PATH:-}"
unset _DT _GN_DIR _PATH_PREFIX

if [[ -x "$ROOT/scripts/check-env.sh" ]]; then
  BROWSEROS_SRC="$BROWSEROS_SRC" "$ROOT/scripts/check-env.sh" || true
fi

if (( DO_SYNC )) || [[ ! -d "$WORK/bos_build" && ! -d "$WORK/build" ]]; then
  if [[ -x "$ROOT/scripts/sync-upstream.sh" ]]; then
    BROWSEROS_SRC="$BROWSEROS_SRC" "$ROOT/scripts/sync-upstream.sh"
  fi
fi

# Prefer work tree; fall back to BROWSEROS_SRC
BUILD_PKG="$WORK"
if [[ ! -d "$BUILD_PKG/bos_build" && ! -d "$BUILD_PKG/build" ]]; then
  BUILD_PKG="$BROWSEROS_SRC"
fi

if [[ ! -d "$BUILD_PKG" ]]; then
  echo "error: BrowserOS browser package not found. Clone BrowserOS and set BROWSEROS_SRC." >&2
  exit 1
fi

if [[ ! -d "$VENV" ]]; then
  echo "→ creating venv at $VENV"
  uv venv "$VENV" 2>/dev/null || python3 -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"
echo "→ install browseros CLI from $BUILD_PKG"
uv pip install -e "$BUILD_PKG" -q 2>/dev/null || pip install -e "$BUILD_PKG" -q

if (( LIST )); then
  browseros build --list
  exit 0
fi

if (( PREP_ONLY )); then
  echo "Prep complete."
  echo "  BUILD_PKG=$BUILD_PKG"
  echo "  VENV=$VENV"
  echo "Next: $0 --ensure-source   # fetch chromium (~hours)"
  echo "Then: $0 --chromium-src \"\$HOME/src/chromium/src\""
  exit 0
fi

if (( ENSURE )); then
  echo "→ ensuring Chromium source at $CHROMIUM_ROOT (shallow, multi-hour)"
  browseros source ensure \
    --root "$CHROMIUM_ROOT" \
    --strategy shallow \
    --version-file "$BUILD_PKG/CHROMIUM_VERSION"
fi

if [[ -z "$CHROMIUM_SRC" ]]; then
  if [[ -d "$CHROMIUM_ROOT/src" ]]; then
    CHROMIUM_SRC="$CHROMIUM_ROOT/src"
  fi
fi

if [[ -z "${CHROMIUM_SRC:-}" || ! -d "${CHROMIUM_SRC}" ]]; then
  echo "error: chromium src missing. Run with --ensure-source first, or pass --chromium-src." >&2
  exit 1
fi

EXTRA=()
if (( NO_DOWNLOAD )); then
  EXTRA+=(--no-download)
fi

echo "→ building Callisto Browser via BrowserOS pipeline"
echo "  CHROMIUM_SRC=$CHROMIUM_SRC"
echo "  BUILD_PKG=$BUILD_PKG"

# Cap ninja parallelism on low-RAM Linux (WSL ~15 GB). Default autoninja uses
# ~nproc jobs; clang++ OOMs and the host dies/reboots. Override with
# BROWSEROS_NINJA_JOBS. See scripts/compile-resilient.sh for auto-retry.
if [[ -z "${BROWSEROS_NINJA_JOBS:-}" ]]; then
  if [[ -r /proc/meminfo ]]; then
    _mem_gb=$(awk '/MemTotal/ {printf "%d", $2/1024/1024}' /proc/meminfo)
    # ~4 GB peak per clang job (same heuristic BrowserOS uses on Windows)
    if ((_mem_gb > 0)); then
      _jobs=$((_mem_gb / 4))
      ((_jobs < 1)) && _jobs=1
      ((_jobs > 8)) && _jobs=8
      export BROWSEROS_NINJA_JOBS="$_jobs"
      echo "  BROWSEROS_NINJA_JOBS=$BROWSEROS_NINJA_JOBS (auto from ${_mem_gb}G RAM)"
    fi
    unset _mem_gb _jobs
  fi
else
  echo "  BROWSEROS_NINJA_JOBS=$BROWSEROS_NINJA_JOBS"
fi

# Prefer no-sign/no-upload for local operator builds
browseros build \
  --preset release \
  --product browseros \
  --chromium-src "$CHROMIUM_SRC" \
  --provision none \
  --no-sign \
  --no-upload \
  --no-clean \
  "${EXTRA[@]}"

echo
echo "Build finished (if no errors)."
echo "Binary is under \$CHROMIUM_SRC/out/…/browseros or callisto"
echo "export CALLISTO_BROWSER_PATH=… for Mini/run.sh"
