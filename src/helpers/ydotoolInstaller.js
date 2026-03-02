const { execFile, spawnSync } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const path = require("path");
const os = require("os");

const execFileAsync = promisify(execFile);

const UDEV_RULE = 'KERNEL=="uinput", GROUP="input", MODE="0660", TAG+="uaccess"';
const UDEV_RULE_PATH = "/etc/udev/rules.d/80-uinput.rules";

function getLogger() {
  return require("./debugLogger");
}

function commandExists(name) {
  try {
    const result = spawnSync("which", [name], { stdio: "pipe", timeout: 5000 });
    return result.status === 0;
  } catch (error) {
    getLogger().debug(`commandExists(${name}) failed`, { error: error.message }, "clipboard");
    return false;
  }
}

function getInstallArgs() {
  const managers = [
    { bin: "dnf", args: ["dnf", "install", "-y", "ydotool"] },
    { bin: "apt-get", args: ["apt-get", "install", "-y", "ydotool"] },
    { bin: "pacman", args: ["pacman", "-S", "--noconfirm", "ydotool"] },
    { bin: "zypper", args: ["zypper", "install", "-y", "ydotool"] },
  ];

  for (const { bin, args } of managers) {
    if (commandExists(bin)) return args;
  }
  return null;
}

async function installYdotool(log) {
  const args = getInstallArgs();
  if (!args) {
    log.warn("No supported package manager found for ydotool", {}, "clipboard");
    return;
  }

  log.info(`Installing ydotool via: pkexec ${args.join(" ")}`, {}, "clipboard");
  await execFileAsync("pkexec", args, { timeout: 120000 });
  log.info("ydotool installed", {}, "clipboard");
}

function udevRuleExists() {
  try {
    const content = fs.readFileSync(UDEV_RULE_PATH, "utf8");
    return content.includes("uinput");
  } catch (error) {
    getLogger().debug("udev rule check failed", { error: error.message }, "clipboard");
    return false;
  }
}

function userInInputGroup() {
  try {
    const result = spawnSync("groups", [], { stdio: "pipe", timeout: 5000 });
    return result.stdout?.toString().includes("input") ?? false;
  } catch (error) {
    getLogger().debug("groups check failed", { error: error.message }, "clipboard");
    return false;
  }
}

async function setupUinputAccess(log) {
  const needsRule = !udevRuleExists();
  const needsGroup = !userInInputGroup();

  if (!needsRule && !needsGroup) return;

  const lines = ["#!/bin/sh", "set -e"];

  if (needsRule) {
    lines.push(`printf '%s\\n' '${UDEV_RULE}' > '${UDEV_RULE_PATH}'`);
  }

  if (needsGroup) {
    const username = os.userInfo().username;
    if (/^[a-z_][a-z0-9_-]*\$?$/.test(username)) {
      lines.push(`usermod -aG input '${username}'`);
    } else {
      log.warn("Skipping group addition: invalid username", { username }, "clipboard");
    }
  }

  if (needsRule) {
    lines.push("udevadm control --reload-rules");
    lines.push("udevadm trigger /dev/uinput");
  }

  if (lines.length <= 2) return;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-"));
  fs.chmodSync(tmpDir, 0o700);
  const tmpScript = path.join(tmpDir, "uinput-setup.sh");
  fs.writeFileSync(tmpScript, lines.join("\n") + "\n", { mode: 0o700 });

  try {
    log.info("Setting up /dev/uinput via pkexec", {}, "clipboard");
    await execFileAsync("pkexec", [tmpScript], { timeout: 120000 });
    log.info("uinput permissions configured", {}, "clipboard");
  } finally {
    try {
      fs.unlinkSync(tmpScript);
      fs.rmdirSync(tmpDir);
    } catch (error) {
      log.debug("Setup script cleanup failed", { error: error.message }, "clipboard");
    }
  }
}

module.exports = { installYdotool, setupUinputAccess, commandExists };
