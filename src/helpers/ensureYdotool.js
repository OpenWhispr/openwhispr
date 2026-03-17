const fs = require("fs");
const os = require("os");
const { spawnSync } = require("child_process");
const { dialog } = require("electron");

function getLogger() {
  return require("./debugLogger");
}

function commandExists(name) {
  try {
    return spawnSync("which", [name], { stdio: "pipe", timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

function isYdotooldRunning() {
  try {
    const result = spawnSync("systemctl", ["--user", "is-active", "ydotoold"], {
      stdio: "pipe",
      timeout: 5000,
    });
    if (result.stdout?.toString().trim() === "active") return true;
  } catch {}

  try {
    const result = spawnSync("systemctl", ["--user", "is-active", "ydotool"], {
      stdio: "pipe",
      timeout: 5000,
    });
    if (result.stdout?.toString().trim() === "active") return true;
  } catch {}

  try {
    return spawnSync("pgrep", ["-x", "ydotoold"], { stdio: "pipe", timeout: 5000 }).status === 0;
  } catch {}

  return false;
}

function serviceFileExists() {
  const paths = [
    "/usr/lib/systemd/user/ydotoold.service",
    "/usr/lib/systemd/user/ydotool.service",
    `${os.homedir()}/.config/systemd/user/ydotoold.service`,
  ];
  return paths.some((p) => fs.existsSync(p));
}

function isUinputAccessible() {
  try {
    fs.accessSync("/dev/uinput", fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function udevRuleExists() {
  const ruleDirs = ["/etc/udev/rules.d", "/usr/lib/udev/rules.d", "/lib/udev/rules.d"];
  for (const dir of ruleDirs) {
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (!file.endsWith(".rules")) continue;
        try {
          const content = fs.readFileSync(`${dir}/${file}`, "utf-8");
          if (content.includes("uinput")) return true;
        } catch {}
      }
    } catch {}
  }
  return false;
}

function userInInputGroup() {
  try {
    const result = spawnSync("groups", [], { stdio: "pipe", timeout: 5000 });
    return result.stdout?.toString().includes("input") ?? false;
  } catch {
    return false;
  }
}

async function ensureYdotool() {
  if (process.platform !== "linux") return;

  const sessionType = (process.env.XDG_SESSION_TYPE || "").toLowerCase();
  if (sessionType !== "wayland" && !process.env.WAYLAND_DISPLAY) return;

  const log = getLogger();

  const hasYdotool = commandExists("ydotool");
  const hasYdotoold = commandExists("ydotoold");
  const daemonRunning = isYdotooldRunning();
  const hasService = serviceFileExists();
  const hasUinput = isUinputAccessible();
  const hasGroup = userInInputGroup();

  log.debug(
    "ydotool check",
    { hasYdotool, hasYdotoold, daemonRunning, hasService, hasUinput, hasGroup },
    "clipboard"
  );

  // Everything is fine
  if (hasYdotool && hasYdotoold && daemonRunning && hasUinput) {
    log.debug("ydotool fully configured", {}, "clipboard");
    return;
  }

  // If the service exists and daemon is just not running, try to start it
  if (hasYdotoold && hasService && !daemonRunning) {
    try {
      spawnSync("systemctl", ["--user", "start", "ydotoold"], { stdio: "pipe", timeout: 10000 });
      if (isYdotooldRunning()) {
        log.info("ydotoold daemon started", {}, "clipboard");
        return;
      }
    } catch {}
    try {
      spawnSync("systemctl", ["--user", "start", "ydotool"], { stdio: "pipe", timeout: 10000 });
      if (isYdotooldRunning()) {
        log.info("ydotool daemon started", {}, "clipboard");
        return;
      }
    } catch {}
  }

  // Something is missing — build an informative message
  const missing = [];

  if (!hasYdotool) {
    missing.push("- ydotool is not installed. Install it with your package manager.");
  }
  if (!hasYdotoold) {
    missing.push(
      "- ydotoold (daemon) is not installed. On Ubuntu/Pop!_OS: sudo apt install ydotoold"
    );
  }
  if (!hasUinput) {
    missing.push(
      '- /dev/uinput is not accessible. Add a udev rule:\n  echo \'KERNEL=="uinput", GROUP="input", MODE="0660", TAG+="uaccess"\' | sudo tee /etc/udev/rules.d/70-uinput.rules\n  sudo udevadm control --reload-rules && sudo udevadm trigger /dev/uinput'
    );
  }
  if (!hasGroup) {
    missing.push(
      "- Your user is not in the 'input' group. Run: sudo usermod -aG input $USER\n  (requires logout/login to take effect)"
    );
  }
  if (hasYdotoold && !hasService) {
    missing.push(
      "- No systemd service found for ydotoold. Enable it with:\n  systemctl --user enable ydotoold && systemctl --user start ydotoold"
    );
  }
  if (hasYdotoold && hasService && !daemonRunning) {
    missing.push(
      "- ydotoold service exists but is not running. Start it with:\n  systemctl --user start ydotoold"
    );
  }

  if (missing.length > 0) {
    const detail = missing.join("\n\n");
    log.warn("ydotool setup incomplete", { missing: missing.length }, "clipboard");

    dialog.showMessageBox({
      type: "warning",
      title: "Wayland Paste Setup",
      message: "ydotool is not fully configured. Auto-paste on Wayland may not work.",
      detail: `The following issues were detected:\n\n${detail}\n\nAfter fixing, restart OpenWhispr.`,
    });
  }
}

function getYdotoolStatus() {
  const hasYdotool = commandExists("ydotool");
  const hasYdotoold = commandExists("ydotoold");
  const daemonRunning = isYdotooldRunning();
  const hasService = serviceFileExists();
  const hasUinput = isUinputAccessible();
  const hasUdevRule = udevRuleExists();
  const hasGroup = userInInputGroup();
  const isWayland =
    (process.env.XDG_SESSION_TYPE || "").toLowerCase() === "wayland" ||
    !!process.env.WAYLAND_DISPLAY;

  return {
    isLinux: process.platform === "linux",
    isWayland,
    hasYdotool,
    hasYdotoold,
    daemonRunning,
    hasService,
    hasUinput,
    hasUdevRule,
    hasGroup,
    allGood: hasYdotool && hasYdotoold && daemonRunning && hasUinput && hasGroup,
  };
}

module.exports = { ensureYdotool, getYdotoolStatus };
