const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const debugLogger = require("./debugLogger");

const UDEV_RULE = 'KERNEL=="uinput", GROUP="input", MODE="0660", TAG+="uaccess"';
const UDEV_RULE_PATH = "/etc/udev/rules.d/80-uinput.rules";

/**
 * Ensures ydotool is installed and ydotoold daemon is running
 * on Linux Wayland systems.
 *
 * For AppImage and tar.gz distributions (which lack package manager
 * dependency resolution), this prompts for root via pkexec and
 * auto-installs ydotool using the detected package manager.
 *
 * For .deb and .rpm packages, ydotool is declared as a required
 * dependency in electron-builder.json.
 *
 * In all cases, ensures:
 * - /dev/uinput is accessible (udev rule + input group)
 * - ydotoold systemd user service exists, is enabled and running
 */
function ensureYdotool() {
  if (process.platform !== "linux") return;

  // Only needed on Wayland
  const sessionType = (process.env.XDG_SESSION_TYPE || "").toLowerCase();
  const waylandDisplay = process.env.WAYLAND_DISPLAY;
  if (sessionType !== "wayland" && !waylandDisplay) return;

  // 1. Ensure ydotool binary is installed
  if (!commandExists("ydotool")) {
    installYdotool();
  }

  // 2. Ensure ydotoold daemon is set up and running
  ensureYdotoold();
}

function commandExists(name) {
  try {
    execSync(`which ${name}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function installYdotool() {
  const installCmd = detectInstallCommand();
  if (!installCmd) {
    debugLogger.warn(
      "Cannot auto-install ydotool: no supported package manager found",
      {},
      "clipboard"
    );
    return;
  }

  debugLogger.info(`Auto-installing ydotool via: pkexec ${installCmd}`, {}, "clipboard");

  try {
    const result = spawnSync("pkexec", installCmd.split(" "), {
      stdio: "pipe",
      timeout: 120000,
    });

    if (result.status === 0) {
      debugLogger.info("ydotool installed successfully", {}, "clipboard");
    } else {
      const stderr = result.stderr?.toString().trim();
      debugLogger.warn(
        "ydotool installation failed",
        { exitCode: result.status, stderr },
        "clipboard"
      );
    }
  } catch (error) {
    debugLogger.warn(
      "ydotool installation error",
      { error: error.message },
      "clipboard"
    );
  }
}

function ensureYdotoold() {
  // Check if already running (user or system service, or bare process)
  if (isYdotooldRunning()) {
    debugLogger.debug("ydotoold already running", {}, "clipboard");
    return;
  }

  // Find ydotoold binary
  const ydotooldPath = findBinary("ydotoold");
  if (!ydotooldPath) {
    // On some distros (Ubuntu 24.04) ydotoold is a separate package
    tryInstallYdotoold();
    const retryPath = findBinary("ydotoold");
    if (!retryPath) {
      debugLogger.warn("ydotoold binary not found, cannot start daemon", {}, "clipboard");
      return;
    }
    return ensureYdotooldWithPath(retryPath);
  }

  ensureYdotooldWithPath(ydotooldPath);
}

function ensureYdotooldWithPath(ydotooldPath) {
  // Set up /dev/uinput permissions if needed
  ensureUinputAccess();

  // Create systemd user service if missing
  createUserService(ydotooldPath);

  // Enable and start the service
  startYdotoold();
}

function isYdotooldRunning() {
  // Check user service first
  try {
    const result = spawnSync("systemctl", ["--user", "is-active", "ydotoold"], {
      stdio: "pipe",
    });
    if (result.stdout?.toString().trim() === "active") return true;
  } catch {}

  // Check system service
  try {
    const result = spawnSync("systemctl", ["is-active", "ydotoold"], {
      stdio: "pipe",
    });
    if (result.stdout?.toString().trim() === "active") return true;
  } catch {}

  // Check bare process
  try {
    const result = spawnSync("pgrep", ["-x", "ydotoold"], { stdio: "pipe" });
    if (result.status === 0) return true;
  } catch {}

  return false;
}

function findBinary(name) {
  try {
    return execSync(`which ${name}`, { stdio: "pipe" }).toString().trim();
  } catch {}

  const paths = [`/usr/bin/${name}`, `/usr/local/bin/${name}`];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function tryInstallYdotoold() {
  // Only relevant for apt-based systems where ydotoold is a separate package
  if (!commandExists("apt-get")) return;

  debugLogger.info("Trying to install ydotoold package separately", {}, "clipboard");
  try {
    const result = spawnSync("pkexec", ["apt-get", "install", "-y", "ydotoold"], {
      stdio: "pipe",
      timeout: 120000,
    });
    if (result.status === 0) {
      debugLogger.info("ydotoold package installed", {}, "clipboard");
    }
  } catch {}
}

function ensureUinputAccess() {
  // Check if /dev/uinput is already writable
  try {
    fs.accessSync("/dev/uinput", fs.constants.W_OK);
    debugLogger.debug("/dev/uinput already accessible", {}, "clipboard");
    return;
  } catch {
    // Not accessible, need to set up
  }

  const rootCommands = [];

  // Check if udev rule already exists
  let needsUdevRule = true;
  try {
    const existing = fs.readFileSync(UDEV_RULE_PATH, "utf8");
    if (existing.includes("uinput")) needsUdevRule = false;
  } catch {}

  if (needsUdevRule) {
    rootCommands.push(`echo '${UDEV_RULE}' > ${UDEV_RULE_PATH}`);
  }

  // Check if user is in input group
  try {
    const groups = execSync("groups", { stdio: "pipe" }).toString();
    if (!groups.includes("input")) {
      rootCommands.push(`usermod -aG input ${os.userInfo().username}`);
    }
  } catch {}

  if (needsUdevRule) {
    rootCommands.push("udevadm control --reload-rules");
    rootCommands.push("udevadm trigger /dev/uinput");
  }

  if (rootCommands.length === 0) return;

  debugLogger.info("Setting up /dev/uinput permissions via pkexec", {}, "clipboard");

  try {
    const result = spawnSync("pkexec", ["sh", "-c", rootCommands.join(" && ")], {
      stdio: "pipe",
      timeout: 120000,
    });

    if (result.status === 0) {
      debugLogger.info("uinput permissions configured", {}, "clipboard");
    } else {
      const stderr = result.stderr?.toString().trim();
      debugLogger.warn(
        "uinput permission setup failed",
        { exitCode: result.status, stderr },
        "clipboard"
      );
    }
  } catch (error) {
    debugLogger.warn(
      "uinput permission setup error",
      { error: error.message },
      "clipboard"
    );
  }
}

function createUserService(ydotooldPath) {
  const serviceDir = path.join(os.homedir(), ".config", "systemd", "user");
  const servicePath = path.join(serviceDir, "ydotoold.service");

  if (fs.existsSync(servicePath)) {
    debugLogger.debug("ydotoold user service file already exists", {}, "clipboard");
    return;
  }

  debugLogger.info("Creating ydotoold systemd user service", {}, "clipboard");

  const serviceContent = [
    "[Unit]",
    "Description=ydotoold - ydotool daemon",
    "Documentation=man:ydotoold(8)",
    "After=graphical-session.target",
    "",
    "[Service]",
    `ExecStart=${ydotooldPath}`,
    "Restart=on-failure",
    "RestartSec=3",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");

  try {
    fs.mkdirSync(serviceDir, { recursive: true });
    fs.writeFileSync(servicePath, serviceContent);
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "pipe" });
    debugLogger.info("ydotoold service file created", {}, "clipboard");
  } catch (error) {
    debugLogger.warn(
      "Failed to create ydotoold service file",
      { error: error.message },
      "clipboard"
    );
  }
}

function startYdotoold() {
  // Enable the service for future logins
  spawnSync("systemctl", ["--user", "enable", "ydotoold"], { stdio: "pipe" });

  // Start now
  const result = spawnSync("systemctl", ["--user", "start", "ydotoold"], {
    stdio: "pipe",
    timeout: 10000,
  });

  if (result.status === 0) {
    debugLogger.info("ydotoold service started successfully", {}, "clipboard");
    return;
  }

  // Start failed — clean up stale instances and retry
  const stderr = result.stderr?.toString().trim();
  debugLogger.warn(
    "ydotoold start failed, cleaning up stale instances",
    { exitCode: result.status, stderr },
    "clipboard"
  );

  spawnSync("pkill", ["-f", "ydotoold"], { stdio: "pipe" });
  try {
    fs.unlinkSync("/tmp/.ydotool_socket");
  } catch {}

  const retry = spawnSync("systemctl", ["--user", "start", "ydotoold"], {
    stdio: "pipe",
    timeout: 10000,
  });

  if (retry.status === 0) {
    debugLogger.info("ydotoold started after cleanup", {}, "clipboard");
  } else {
    debugLogger.warn(
      "ydotoold failed to start after cleanup",
      { stderr: retry.stderr?.toString().trim() },
      "clipboard"
    );
  }
}

function detectInstallCommand() {
  const managers = [
    { check: "dnf", cmd: "dnf install -y ydotool" },
    { check: "apt-get", cmd: "apt-get install -y ydotool" },
    { check: "pacman", cmd: "pacman -S --noconfirm ydotool" },
    { check: "zypper", cmd: "zypper install -y ydotool" },
  ];

  for (const { check, cmd } of managers) {
    try {
      execSync(`which ${check}`, { stdio: "pipe" });
      return cmd;
    } catch {
      continue;
    }
  }
  return null;
}

module.exports = { ensureYdotool };
