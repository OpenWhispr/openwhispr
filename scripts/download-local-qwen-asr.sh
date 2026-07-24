#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${PROJECT_DIR}/.venv-asr"
MODEL_ID="${QWEN_ASR_MODEL:-Qwen/Qwen3-ASR-0.6B}"

if [[ ! -x "${VENV_DIR}/bin/hf" ]]; then
  echo "Missing local ASR environment. Run: npm run asr:setup" >&2
  exit 1
fi

exec "${VENV_DIR}/bin/hf" download "${MODEL_ID}"
