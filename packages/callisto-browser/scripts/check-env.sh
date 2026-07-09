#!/usr/bin/env bash
# Verify machine readiness for Callisto Browser builds.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ok=0
warn=0

check() {
  local name="$1" cond="$2" msg="$3"
  if eval "$cond"; then
    echo "  OK   $name"
  else
    echo "  FAIL $name — $msg"
    ok=1
  fi
}

echo "Callisto Browser environment check"
echo "  package: $ROOT"
echo

check "python3" "command -v python3 >/dev/null" "install Python 3.12+"
check "git" "command -v git >/dev/null" "install git"
if command -v python3 >/dev/null; then
  pyver=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
  echo "  info python $pyver"
fi

BROWSEROS_SRC="${BROWSEROS_SRC:-$HOME/Desktop/OpenSource/BrowserOS/packages/browseros}"
if [[ -d "$BROWSEROS_SRC" ]]; then
  echo "  OK   BROWSEROS_SRC=$BROWSEROS_SRC"
else
  echo "  FAIL BROWSEROS_SRC missing ($BROWSEROS_SRC)"
  echo "       clone BrowserOS or set BROWSEROS_SRC"
  ok=1
fi

if [[ -n "${CHROMIUM_SRC:-}" && -d "${CHROMIUM_SRC}" ]]; then
  echo "  OK   CHROMIUM_SRC=$CHROMIUM_SRC"
else
  echo "  WARN CHROMIUM_SRC not set — required for compile (~100GB)"
  warn=1
fi

disk_gb=$(df -BG "$ROOT" 2>/dev/null | awk 'NR==2{gsub(/G/,"",$4); print $4}')
if [[ -n "${disk_gb:-}" ]]; then
  if (( disk_gb < 80 )); then
    echo "  WARN free disk ~${disk_gb}G (recommend 100G+ for Chromium)"
    warn=1
  else
    echo "  OK   free disk ~${disk_gb}G"
  fi
fi

echo
if (( ok != 0 )); then
  echo "Environment not ready (failures above)."
  exit 1
fi
if (( warn != 0 )); then
  echo "Environment OK for scaffolding; compile needs CHROMIUM_SRC + disk."
  exit 0
fi
echo "Environment looks ready for a full Linux build."
