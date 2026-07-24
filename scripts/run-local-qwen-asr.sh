#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${PROJECT_DIR}/.venv-asr"

if [[ ! -x "${VENV_DIR}/bin/python" ]]; then
  echo "Missing local ASR environment. Run: npm run asr:setup" >&2
  exit 1
fi

export PYTHONUNBUFFERED=1
export HF_HUB_OFFLINE="${HF_HUB_OFFLINE:-1}"
exec "${VENV_DIR}/bin/python" "${PROJECT_DIR}/local-asr/server.py"
