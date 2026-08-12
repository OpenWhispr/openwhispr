#!/bin/bash
# Post-remove script for OpenWhispr (deb)
# Best-effort: must never fail package removal, and must never run on upgrade.

set -uo pipefail

# dpkg also invokes the old version's postrm during upgrades (arg: upgrade /
# failed-upgrade). Only clean up when the package is really going away.
case "${1:-remove}" in
  remove|purge) ;;
  *) exit 0 ;;
esac

REAL_USER="${SUDO_USER:-}"
if [ -z "$REAL_USER" ] || [ "$REAL_USER" = "root" ]; then
  REAL_USER=$(logname 2>/dev/null || echo "")
fi
if [ "$REAL_USER" = "root" ]; then
  REAL_USER=""
fi

REAL_HOME=""
if [ -n "$REAL_USER" ]; then
  REAL_HOME=$(getent passwd "$REAL_USER" 2>/dev/null | cut -d: -f6 || echo "")
fi
if [ -z "$REAL_HOME" ]; then
  exit 0
fi

CACHE_DIR="$REAL_HOME/.cache/openwhispr"
MODELS_DIR="$CACHE_DIR/models"

if [ -d "$MODELS_DIR" ]; then
  rm -rf "$MODELS_DIR" 2>/dev/null || true
  echo "Removed OpenWhispr cached models"
fi

if [ -d "$CACHE_DIR" ]; then
  rmdir "$CACHE_DIR" 2>/dev/null || true
fi

exit 0
