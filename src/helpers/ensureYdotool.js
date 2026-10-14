const fs = require("fs");
const os = require("os");
const { execFile, spawnSync } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const { dialog } = require("electron");
const { getLinuxSessionInfo } = require("./linuxSession");

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
      "- ydotoold (daemon) is not installed. On Ubuntu/Pop!_OS: sudo apt install ydotoold. On Arch: included in the ydotool package."
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

async function getYdotoolStatus() {
  const { isWayland, isKde, isWlroots, isCosmic } = getLinuxSessionInfo();
  const isLinux = process.platform === "linux";
  const status = {
    isLinux,
    isWayland,
    isKde,
    isWlroots,
    isCosmic,
    hasYdotool: false,
    hasYdotoold: false,
    hasWtype: false,
    daemonRunning: false,
    hasService: false,
    hasUinput: false,
    hasUdevRule: false,
    hasGroup: false,
    isNixOS: false,
    hasXclip: false,
    hasXsel: false,
  };
  if (!isLinux || !isWayland) return status;

  const run = async (file, args, timeout = 5000) => {
    try {
      const { stdout } = await execFileAsync(file, args, { timeout });
      return stdout.trim();
    } catch {
      return "";
    }
  };
  const exists = (file, mode) =>
    fs.promises.access(file, mode).then(
      () => true,
      () => false
    );
  const servicePaths = [
    "/usr/lib/systemd/user/ydotoold.service",
    "/usr/lib/systemd/user/ydotool.service",
    `${os.homedir()}/.config/systemd/user/ydotoold.service`,
  ];
  const checkRules = async () => {
    for (const dir of ["/etc/udev/rules.d", "/usr/lib/udev/rules.d", "/lib/udev/rules.d"]) {
      for (const file of await fs.promises.readdir(dir).catch(() => [])) {
        if (!file.endsWith(".rules")) continue;
        const rule = await fs.promises.readFile(`${dir}/${file}`, "utf8").catch(() => "");
        if (rule.includes("uinput")) return true;
      }
    }
    return false;
  };
  const checkDaemon = async () =>
    (await run("systemctl", ["--user", "is-active", "ydotoold"])) === "active" ||
    (await run("systemctl", ["--user", "is-active", "ydotool"])) === "active" ||
    !!(await run("pgrep", ["-x", "ydotoold"]));
  const checkNixOS = async () =>
    (await exists("/etc/NIXOS")) ||
    /^ID=("?)nixos\1$/m.test(await fs.promises.readFile("/etc/os-release", "utf8").catch(() => ""));

  const [
    hasYdotool,
    hasYdotoold,
    hasWtype,
    daemonRunning,
    hasService,
    hasUinput,
    hasUdevRule,
    hasGroup,
    nixOS,
    hasXclip,
    hasXsel,
  ] = await Promise.all([
    run("which", ["ydotool"]).then(Boolean),
    run("which", ["ydotoold"]).then(Boolean),
    run("which", ["wtype"]).then(Boolean),
    checkDaemon(),
    Promise.all(servicePaths.map((file) => exists(file))).then((results) => results.some(Boolean)),
    exists("/dev/uinput", fs.constants.W_OK),
    checkRules(),
    run("groups", []).then((groups) => groups.includes("input")),
    checkNixOS(),
    isKde && run("which", ["xclip"], 1000).then(Boolean),
    isKde && run("which", ["xsel"], 1000).then(Boolean),
  ]);
  return {
    ...status,
    hasYdotool,
    hasYdotoold,
    hasWtype,
    daemonRunning,
    hasService,
    hasUinput,
    hasUdevRule,
    hasGroup,
    isNixOS: nixOS,
    hasXclip: !!hasXclip,
    hasXsel: !!hasXsel,
  };
}

module.exports = { ensureYdotool, getYdotoolStatus };
