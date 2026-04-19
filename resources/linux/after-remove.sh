#!/bin/bash
set -euo pipefail

REAL_USER="${SUDO_USER:-}"
if [ -z "$REAL_USER" ] || [ "$REAL_USER" = "root" ]; then
  REAL_USER=$(logname 2>/dev/null || echo "")
fi

if [ -n "$REAL_USER" ]; then
  REAL_HOME=$(getent passwd "$REAL_USER" | cut -d: -f6)
else
  REAL_HOME="$HOME"
fi

CACHE_DIR="$REAL_HOME/.cache/openwhispr"
MODELS_DIR="$CACHE_DIR/models"

if [ -d "$MODELS_DIR" ]; then
  rm -rf "$MODELS_DIR"
  echo "Removed OpenWhispr cached models"
fi

if [ -d "$CACHE_DIR" ]; then
  rmdir "$CACHE_DIR" 2>/dev/null || true
fi
