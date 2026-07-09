#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

CALLISTO_HARNESS="$(pwd)/harness/.venv/bin/callisto"
CHROME_PATH="$(pwd)/packages/mini/browseros/browseros"
export CHROME_PATH
LD_LIBRARY_PATH="$(pwd)/packages/mini/browseros:${LD_LIBRARY_PATH:-}"
export LD_LIBRARY_PATH


if [ ! -f "$CALLISTO_HARNESS" ]; then
  echo "Error: callisto not built. Run: cd harness && python3 -m venv .venv && .venv/bin/pip install -e ."
  exit 1
fi

PROVIDER="groq"
MODEL="meta-llama/llama-4-scout-17b-16e-instruct"

if [ $# -eq 0 ]; then
  echo "Usage: $0 <task>"
  echo ""
  echo "Examples:"
  echo "  $0 \"Find MrBeast's YouTube channel and play the latest video\""
  echo "  $0 --chat"
  echo "  $0 --ollama \"open skyscanner for flights from delhi to goa\""
  echo ""
  echo "Options:"
  echo "  --chat           Start interactive multi-turn chat session"
  echo "  --visible        Run with visible browser (not headless)"
  echo "  --no-sandbox     Pass --no-sandbox to Chrome (Docker/CI only)"
  echo "  --no-approval    Skip approval prompts (CI / non-interactive)"
  echo "  --ollama         Use local Ollama inference (no API key needed)"
  echo "  --groq           Use Groq API (default)"
  echo "  --openrouter     Use OpenRouter API"
  echo "  --siliconflow    Use SiliconFlow API"
  echo "  --generalcompute Use General Compute API"
  echo "  --model NAME     Set model (default: meta-llama/llama-4-scout-17b-16e-instruct)"
  echo "  --steps N        Max tool-call turns (default: 40)"
  echo ""
  echo "Safety defaults: Chrome sandbox ON, human approval ON, cost unlimited (0)."
  echo "Opt into weaker defaults only when you understand the tradeoff."
  echo ""
  echo "Environment:"
  echo "  GROQ_API_KEY        Required for Groq provider"
  echo "  OPENROUTER_API_KEY  Required for OpenRouter provider"
  echo "  SILICONFLOW_KEY     Required for SiliconFlow provider"
  echo "  GENERALCOMPUTE_API_KEY  Required for General Compute provider"
  exit 0
fi

HEADLESS="--headless"
MAX_STEPS=40
MODE="run"
VERBOSE=""
NO_SANDBOX=""
NO_APPROVAL=""

args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --chat) MODE="chat" ;;
    --verbose) VERBOSE="--verbose" ;;
    --visible) HEADLESS="--no-headless" ;;
    --no-sandbox) NO_SANDBOX="--no-sandbox" ;;
    --no-approval) NO_APPROVAL="--no-approval" ;;
    --ollama)
      PROVIDER="ollama"
      MODEL="llama3.2:3b"
      ;;
    --groq)
      PROVIDER="groq"
      MODEL="meta-llama/llama-4-scout-17b-16e-instruct"
      ;;
    --openrouter)
      PROVIDER="openrouter"
      MODEL="meta-llama/llama-3.3-70b-instruct:free"
      ;;
    --siliconflow)
      PROVIDER="siliconflow"
      MODEL="tencent/Hy3"
      ;;
    --generalcompute)
      PROVIDER="generalcompute"
      MODEL="minimax-m2.7"
      ;;
    --model) shift; MODEL="$1" ;;
    --steps) shift; MAX_STEPS="$1" ;;
    --help) $0; exit 0 ;;
    *) args+=("$1") ;;
  esac
  shift
done

if [ "$MODE" = "chat" ]; then
  exec "$CALLISTO_HARNESS" chat \
    $HEADLESS $NO_SANDBOX $NO_APPROVAL $VERBOSE \
    --provider "$PROVIDER" --model "$MODEL" \
    --max-steps "$MAX_STEPS" --max-cost 0
else
  if [ ${#args[@]} -eq 0 ]; then
    echo "Error: missing task string. See $0 --help" >&2
    exit 1
  fi
  exec "$CALLISTO_HARNESS" run-task "${args[0]}" \
    $HEADLESS $NO_SANDBOX $NO_APPROVAL $VERBOSE \
    --provider "$PROVIDER" --model "$MODEL" \
    --max-steps "$MAX_STEPS" --max-cost 0
fi
