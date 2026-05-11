#!/bin/bash
# Post-install script for OpenWhispr (deb/rpm)
# Sets up chrome-sandbox permissions and ydotool daemon prerequisites

set -euo pipefail

# 0. Set SUID bit on chrome-sandbox (required by Electron for Linux sandboxing)
#    Find it wherever dpkg placed the package files, rather than hardcoding /opt/...
CHROME_SANDBOX=$(dpkg -L open-whispr 2>/dev/null | grep chrome-sandbox || echo "")
if [ -z "$CHROME_SANDBOX" ]; then
  # Fallback: conventional electron-builder install path
  CHROME_SANDBOX="/opt/OpenWhispr/chrome-sandbox"
fi
if [ -f "$CHROME_SANDBOX" ]; then
  chown root:root "$CHROME_SANDBOX"
  chmod 4755 "$CHROME_SANDBOX"
fi

UDEV_RULE='KERNEL=="uinput", GROUP="input", MODE="0660", TAG+="uaccess"'
UDEV_RULE_PATH="/etc/udev/rules.d/70-uinput.rules"
SERVICE_PATH="/usr/lib/systemd/user/ydotoold.service"

# Detect the real user (not root) who triggered the install
REAL_USER="${SUDO_USER:-}"
if [ -z "$REAL_USER" ] || [ "$REAL_USER" = "root" ]; then
  REAL_USER=$(logname 2>/dev/null || echo "")
fi

# 1. udev rule for /dev/uinput
if [ ! -f "$UDEV_RULE_PATH" ] || ! grep -q uinput "$UDEV_RULE_PATH" 2>/dev/null; then
  echo "$UDEV_RULE" > "$UDEV_RULE_PATH"
  udevadm control --reload-rules 2>/dev/null || true
  udevadm trigger /dev/uinput 2>/dev/null || true
fi

# 2. Add user to input group
if [ -n "$REAL_USER" ]; then
  if ! id -nG "$REAL_USER" 2>/dev/null | grep -qw input; then
    usermod -aG input "$REAL_USER" 2>/dev/null || true
  fi
fi

# 3. systemd user service for ydotoold
# Skip if a service already exists (e.g. Fedora ships one with the ydotool package)
if [ ! -f "$SERVICE_PATH" ] && [ ! -f "/usr/lib/systemd/user/ydotool.service" ]; then
  YDOTOOLD_BIN=$(command -v ydotoold 2>/dev/null || echo "/usr/bin/ydotoold")
  if [ -x "$YDOTOOLD_BIN" ] || [ -f "$YDOTOOLD_BIN" ]; then
    mkdir -p "$(dirname "$SERVICE_PATH")"
    cat > "$SERVICE_PATH" << SERVICEEOF
[Unit]
Description=ydotoold - ydotool daemon
After=graphical-session.target
PartOf=graphical-session.target

[Service]
ExecStartPre=/usr/bin/sleep 2
ExecStart=$YDOTOOLD_BIN
Restart=on-failure
RestartSec=1s

[Install]
WantedBy=graphical-session.target
SERVICEEOF
  fi
fi

# 4. Enable the service for the installing user
if [ -n "$REAL_USER" ]; then
  REAL_UID=$(id -u "$REAL_USER" 2>/dev/null || echo "")
  if [ -n "$REAL_UID" ]; then
    # systemctl --user requires XDG_RUNTIME_DIR
    export XDG_RUNTIME_DIR="/run/user/$REAL_UID"
    if [ -d "$XDG_RUNTIME_DIR" ]; then
      # Determine the correct service name
      SERVICE_NAME=""
      if [ -f "/usr/lib/systemd/user/ydotoold.service" ]; then
        SERVICE_NAME="ydotoold"
      elif [ -f "/usr/lib/systemd/user/ydotool.service" ]; then
        SERVICE_NAME="ydotool"
      fi
      if [ -n "$SERVICE_NAME" ]; then
        su - "$REAL_USER" -c "XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR systemctl --user daemon-reload" 2>/dev/null || true
        su - "$REAL_USER" -c "XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR systemctl --user enable $SERVICE_NAME" 2>/dev/null || true
      fi
    fi
  fi
fi

# 5. NVIDIA CUDA runtime for GPU-accelerated speaker diarization
# Only installs if NVIDIA GPU is detected. cuDNN is bundled with the app.
# Falls back silently on failure; the app uses CPU diarization as fallback.
if lspci 2>/dev/null | grep -qi nvidia; then
  if ! ldconfig -p 2>/dev/null | grep -q libcublas.so.12; then
    if [ -f /etc/debian_version ]; then
      # Debian/Ubuntu: CUDA runtime libs available in standard repos
      apt-get install -y --no-install-recommends \
        libcudart12 libcublas12 libcufft11 libcurand10 2>/dev/null || true
    elif [ -f /etc/fedora-release ] || [ -f /etc/redhat-release ]; then
      # Fedora/RHEL: needs NVIDIA CUDA repo (try current version, fall back to older)
      if ! dnf repolist 2>/dev/null | grep -qi cuda; then
        FEDORA_VER=$(rpm -E %fedora 2>/dev/null || echo "41")
        for VER in "$FEDORA_VER" $((FEDORA_VER - 1)) $((FEDORA_VER - 2)) $((FEDORA_VER - 3)); do
          REPO_URL="https://developer.download.nvidia.com/compute/cuda/repos/fedora$VER/x86_64/cuda-fedora$VER.repo"
          if dnf config-manager addrepo --from-repofile="$REPO_URL" 2>/dev/null; then
            break
          fi
        done
      fi
      dnf install -y --setopt=install_weak_deps=False \
        cuda-cudart libcublas libcufft libcurand 2>/dev/null || true
    elif [ -f /etc/SuSE-release ] || [ -f /etc/SUSE-brand ] || grep -qi suse /etc/os-release 2>/dev/null; then
      # openSUSE: needs NVIDIA CUDA repo
      if ! zypper repos 2>/dev/null | grep -qi cuda; then
        SUSE_VER=$(. /etc/os-release 2>/dev/null && echo "${VERSION_ID%%.*}" || echo "15")
        zypper addrepo --gpgcheck "https://developer.download.nvidia.com/compute/cuda/repos/opensuse$SUSE_VER/x86_64/cuda-opensuse$SUSE_VER.repo" 2>/dev/null || true
      fi
      zypper install -y --no-recommends \
        cuda-cudart libcublas libcufft libcurand 2>/dev/null || true
    elif command -v pacman >/dev/null 2>&1; then
      pacman -S --noconfirm --needed cuda 2>/dev/null || true
    fi
  fi
fi

exit 0
