#!/usr/bin/env bash
# Resilient Callisto Browser compile for low-RAM hosts (e.g. 16 GB WSL).
#
# Root cause of "crashes": OOM-killer. autoninja defaults to ~nproc jobs
# (often -j 20+); clang++ peaks ~2–4 GB each → host dies or reboots.
#
# Usage:
#   ./scripts/compile-resilient.sh              # default -j 3
#   BROWSEROS_NINJA_JOBS=2 ./scripts/compile-resilient.sh
#   ./scripts/compile-resilient.sh --jobs 4
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHROMIUM_SRC="${CHROMIUM_SRC:-$HOME/src/chromium/src}"
CHROMIUM_ROOT="${CHROMIUM_ROOT:-$HOME/src/chromium}"
VENV="${CALLISTO_BROWSER_VENV:-$HOME/src/browseros-venv}"
LOG="${CALLISTO_BUILD_LOG:-$HOME/src/logs/callisto-browser-build.log}"
JOBS="${BROWSEROS_NINJA_JOBS:-3}"
MAX_RETRIES="${CALLISTO_COMPILE_RETRIES:-50}"
SLEEP_BETWEEN="${CALLISTO_COMPILE_RETRY_SLEEP:-30}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --jobs|-j) JOBS="$2"; shift 2 ;;
    --chromium-src) CHROMIUM_SRC="$2"; shift 2 ;;
    --log) LOG="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

mkdir -p "$(dirname "$LOG")"

# Prefer real gn + checkout depot_tools
export PATH="${CHROMIUM_SRC}/buildtools/linux64:${CHROMIUM_ROOT}/depot_tools:${HOME}/.local/bin:${HOME}/src/depot_tools:${PATH:-}"
# shellcheck disable=SC1091
source "$VENV/bin/activate"

export BROWSEROS_NINJA_JOBS="$JOBS"
# Extra belt-and-suspenders for raw autoninja if used
export NINJA_CORE_LIMIT="$JOBS"

OUT="$CHROMIUM_SRC/out/Default_browseros_x64"
LOCK_DIR="$CHROMIUM_ROOT/.browseros-build-locks"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG"; }

chrome_ready() {
  [[ -x "$OUT/chrome" ]] && [[ -s "$OUT/chrome" ]]
}

clear_stale_lock() {
  rm -f "$LOCK_DIR"/src-*.lock 2>/dev/null || true
}

# Drop page cache pressure a bit between retries (best-effort, no sudo)
sync 2>/dev/null || true

_mem_av=$(awk '/MemAvailable/ {printf "%dG", $2/1024/1024}' /proc/meminfo 2>/dev/null || echo "?")
log "=== resilient compile start jobs=$JOBS mem_available=${_mem_av} ==="
unset _mem_av
log "CHROMIUM_SRC=$CHROMIUM_SRC LOG=$LOG"

attempt=0
while (( attempt < MAX_RETRIES )); do
  attempt=$((attempt + 1))

  if chrome_ready; then
    log "chrome already present at $OUT/chrome — running package only if needed"
    break
  fi

  clear_stale_lock
  log "=== attempt $attempt/$MAX_RETRIES BROWSEROS_NINJA_JOBS=$JOBS ==="

  set +e
  (
    cd "$ROOT"
    browseros build \
      --preset release \
      --product browseros \
      --chromium-src "$CHROMIUM_SRC" \
      --provision none \
      --no-sign \
      --no-upload \
      --no-clean \
      --no-download \
      --from compile
  ) >>"$LOG" 2>&1
  code=$?
  set -e

  log "attempt $attempt exit=$code"

  if (( code == 0 )) || chrome_ready; then
    log "compile finished successfully"
    exit 0
  fi

  # Detect OOM-style death: ninja gone, incomplete chrome
  if journalctl -k --since "10 min ago" --no-pager 2>/dev/null | grep -qi 'Out of memory'; then
    # Halve jobs down to 1 on OOM
    if (( JOBS > 1 )); then
      JOBS=$(( JOBS > 2 ? JOBS - 1 : 1 ))
      export BROWSEROS_NINJA_JOBS="$JOBS"
      export NINJA_CORE_LIMIT="$JOBS"
      log "OOM observed — reducing jobs to $JOBS"
    fi
  fi

  log "retrying in ${SLEEP_BETWEEN}s (partial ninja state is kept)"
  sleep "$SLEEP_BETWEEN"
done

if chrome_ready; then
  log "success: $OUT/chrome"
  exit 0
fi

log "FAILED after $attempt attempts — see $LOG"
exit 1
