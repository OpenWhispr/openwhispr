function buildLinuxWrapperScript(binaryName) {
  if (typeof binaryName !== "string" || !/^[A-Za-z0-9._-]+$/.test(binaryName)) {
    throw new Error(`Invalid Linux executable name: ${JSON.stringify(binaryName)}`);
  }

  return `#!/bin/bash
# OpenWhispr launcher
# User flags: ~/.config/${binaryName}-flags.conf (one per line, # = comment)

HERE="$(dirname "$(readlink -f "\${BASH_SOURCE[0]}")")"
FLAGS=()

# Wayland: forces XWayland (overlay positioning requires X11)
if [ "$XDG_SESSION_TYPE" = "wayland" ]; then
  FLAGS+=(--ozone-platform=x11)
fi

# Chromium needs unprivileged user namespaces (restricted since Ubuntu 23.10)
# or a root-owned setuid chrome-sandbox; with neither it aborts at launch.
if ! { [ "$(stat -c %u "$HERE/chrome-sandbox" 2>/dev/null)" = "0" ] && [ -u "$HERE/chrome-sandbox" ] && [ -x "$HERE/chrome-sandbox" ]; }; then
  if command -v unshare >/dev/null 2>&1 && ! unshare --user --map-root-user true >/dev/null 2>&1; then
    echo "${binaryName}: user namespaces are restricted, starting with --no-sandbox" >&2
    FLAGS+=(--no-sandbox)
  fi
fi

# User flags
FLAGS_FILE="\${XDG_CONFIG_HOME:-$HOME/.config}/${binaryName}-flags.conf"
if [ -f "$FLAGS_FILE" ]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    FLAGS+=("$line")
  done < "$FLAGS_FILE"
fi

# A compositor that hands XWayland the panel's raw pixel resolution instead of
# upscaling its surfaces leaves Chromium with no scale to read, so the UI
# renders at 1x on a fractionally scaled display. Only Hyprland is probed:
# forcing a scale on a compositor that already upscales (Mutter, KWin) would
# apply it twice. Runs after the user flags so an explicit one wins.
if [ "$XDG_SESSION_TYPE" = "wayland" ] && [ -n "$HYPRLAND_INSTANCE_SIGNATURE" ] &&
  ! printf '%s\\n' "\${FLAGS[@]}" | grep -q '^--force-device-scale-factor=' &&
  command -v hyprctl >/dev/null 2>&1 &&
  hyprctl getoption xwayland:force_zero_scaling 2>/dev/null | grep -qE '^(bool|int): (1|true)$'; then
  SCALE="$(hyprctl monitors 2>/dev/null | awk '
    /^Monitor/ { current = "" }
    /^[[:space:]]*scale:/ { current = $2; if (first == "") first = $2 }
    /^[[:space:]]*focused: yes/ { if (current != "") focused = current }
    END { print (focused != "" ? focused : first) }')"
  if [ -n "$SCALE" ] && awk -v s="$SCALE" 'BEGIN { exit !(s > 1.01) }'; then
    FLAGS+=("--force-device-scale-factor=$SCALE")
  fi
fi

exec -a "$0" "$HERE/${binaryName}-app" "\${FLAGS[@]}" "$@"
`;
}

module.exports = { buildLinuxWrapperScript };
