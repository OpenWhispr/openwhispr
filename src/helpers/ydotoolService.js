const { execFile, spawnSync } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const path = require("path");
const os = require("os");

const execFileAsync = promisify(execFile);

function getLogger() {
  return require("./debugLogger");
}

function findBinary(name) {
  try {
    const result = spawnSync("which", [name], { stdio: "pipe", timeout: 5000 });
    if (result.status === 0) return result.stdout.toString().trim();
  } catch (error) {
    getLogger().debug(`findBinary(${name}) failed`, { error: error.message }, "clipboard");
  }

  for (const p of [`/usr/bin/${name}`, `/usr/local/bin/${name}`]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function isYdotooldRunning() {
  try {
    const result = spawnSync("systemctl", ["--user", "is-active", "ydotoold"], {
      stdio: "pipe",
      timeout: 5000,
    });
    if (result.stdout?.toString().trim() === "active") return true;
  } catch (error) {
    getLogger().debug("systemctl user check failed", { error: error.message }, "clipboard");
  }

  try {
    const result = spawnSync("systemctl", ["is-active", "ydotoold"], {
      stdio: "pipe",
      timeout: 5000,
    });
    if (result.stdout?.toString().trim() === "active") return true;
  } catch (error) {
    getLogger().debug("systemctl system check failed", { error: error.message }, "clipboard");
  }

  try {
    const result = spawnSync("pgrep", ["-x", "ydotoold"], { stdio: "pipe", timeout: 5000 });
    if (result.status === 0) return true;
  } catch (error) {
    getLogger().debug("pgrep check failed", { error: error.message }, "clipboard");
  }

  return false;
}

function createUserService(ydotooldPath, log) {
  const serviceDir = path.join(os.homedir(), ".config", "systemd", "user");
  const servicePath = path.join(serviceDir, "ydotoold.service");

  if (fs.existsSync(servicePath)) {
    log.debug("ydotoold user service already exists", {}, "clipboard");
    return;
  }

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
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "pipe", timeout: 10000 });
    log.info("ydotoold service file created", {}, "clipboard");
  } catch (error) {
    log.warn("Failed to create ydotoold service", { error: error.message }, "clipboard");
  }
}

async function tryStartYdotoold(log) {
  try {
    await execFileAsync("systemctl", ["--user", "enable", "ydotoold"], { timeout: 10000 });
  } catch (error) {
    log.debug("ydotoold enable failed", { error: error.message }, "clipboard");
  }

  try {
    await execFileAsync("systemctl", ["--user", "start", "ydotoold"], { timeout: 10000 });
    log.info("ydotoold started", {}, "clipboard");
    return;
  } catch (error) {
    log.debug("ydotoold start failed, retrying after cleanup", { error: error.message }, "clipboard");
  }

  // Cleanup stale state — scoped to current user via systemctl
  try {
    await execFileAsync("systemctl", ["--user", "stop", "ydotoold"], { timeout: 10000 });
  } catch (error) {
    log.debug("ydotoold stop failed", { error: error.message }, "clipboard");
  }

  const socketPath = path.join(os.tmpdir(), ".ydotool_socket");
  try {
    const stat = fs.statSync(socketPath);
    if (stat.uid === process.getuid()) {
      fs.unlinkSync(socketPath);
    }
  } catch (error) {
    log.debug("Socket cleanup skipped", { error: error.message }, "clipboard");
  }

  try {
    await execFileAsync("systemctl", ["--user", "start", "ydotoold"], { timeout: 10000 });
    log.info("ydotoold started after cleanup", {}, "clipboard");
  } catch (error) {
    log.warn("ydotoold failed to start", { error: error.message }, "clipboard");
  }
}

async function ensureYdotooldDaemon(log, { hasUserConsent = false } = {}) {
  const { commandExists } = require("./ydotoolInstaller");

  let ydotooldPath = findBinary("ydotoold");

  // On some distros (Ubuntu 24.04) ydotoold is a separate package
  if (!ydotooldPath && hasUserConsent && commandExists("apt-get")) {
    log.info("Installing ydotoold package separately", {}, "clipboard");
    try {
      await execFileAsync("pkexec", ["apt-get", "install", "-y", "ydotoold"], {
        timeout: 120000,
      });
    } catch (error) {
      log.debug("ydotoold package install failed", { error: error.message }, "clipboard");
    }
    ydotooldPath = findBinary("ydotoold");
  }

  if (!ydotooldPath) {
    log.warn("ydotoold binary not found", {}, "clipboard");
    return;
  }

  createUserService(ydotooldPath, log);
  await tryStartYdotoold(log);
}

module.exports = { isYdotooldRunning, tryStartYdotoold, ensureYdotooldDaemon };
