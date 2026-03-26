// electron-builder afterPack hook
// Wraps the Linux Electron binary in a shell script that:
// 1. Forces XWayland on Wayland sessions (overlay positioning requires X11)
// 2. Reads user flags from ~/.config/open-whispr-flags.conf

const fs = require("fs");
const path = require("path");

exports.default = async function (context) {
  if (context.electronPlatformName !== "linux") return;

  const appDir = context.appOutDir;
  const binaryName = context.packager.executableName;
  const binaryPath = path.join(appDir, binaryName);
  const realBinaryPath = path.join(appDir, binaryName + "-app");

  fs.renameSync(binaryPath, realBinaryPath);

  const wrapper = `#!/bin/bash
# OpenWhispr launcher
# User flags: ~/.config/${binaryName}-flags.conf (one per line, # = comment)

HERE="\${BASH_SOURCE%/*}"
FLAGS=()

# Wayland: forces XWayland (overlay positioning requires X11)
if [ "$XDG_SESSION_TYPE" = "wayland" ]; then
  FLAGS+=(--ozone-platform=x11)
fi

# User flags
FLAGS_FILE="\${XDG_CONFIG_HOME:-$HOME/.config}/${binaryName}-flags.conf"
if [ -f "$FLAGS_FILE" ]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    FLAGS+=("$line")
  done < "$FLAGS_FILE"
fi

exec -a "$0" "$HERE/${binaryName}-app" "\${FLAGS[@]}" "$@"
`;

  fs.writeFileSync(binaryPath, wrapper, { mode: 0o755 });
};
