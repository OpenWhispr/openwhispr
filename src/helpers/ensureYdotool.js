const fs = require("fs");
const path = require("path");
const { app, dialog } = require("electron");

const { installYdotool, setupUinputAccess, commandExists } = require("./ydotoolInstaller");
const { isYdotooldRunning, tryStartYdotoold, ensureYdotooldDaemon } = require("./ydotoolService");

function getLogger() {
  return require("./debugLogger");
}

function getSetupFlagPath() {
  return path.join(app.getPath("userData"), "ydotool-setup-done");
}

function isSetupDone() {
  try {
    return fs.existsSync(getSetupFlagPath());
  } catch (error) {
    getLogger().debug("isSetupDone check failed", { error: error.message }, "clipboard");
    return false;
  }
}

function markSetupDone() {
  try {
    fs.writeFileSync(getSetupFlagPath(), new Date().toISOString());
  } catch (error) {
    getLogger().debug("Failed to persist setup flag", { error: error.message }, "clipboard");
  }
}

function isUinputAccessible() {
  try {
    fs.accessSync("/dev/uinput", fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function askUserConsent(needsInstall, needsUinput) {
  const actions = [];
  if (needsInstall) actions.push("Install ydotool (paste support for Wayland)");
  if (needsUinput) actions.push("Configure /dev/uinput permissions");

  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: ["Allow", "Skip"],
    defaultId: 0,
    cancelId: 1,
    title: "Wayland Paste Setup",
    message: "OpenWhispr needs to set up ydotool for reliable paste on Wayland.",
    detail: `This requires administrator privileges to:\n${actions.map((a) => `\u2022 ${a}`).join("\n")}`,
  });

  return response === 0;
}

async function ensureYdotool() {
  if (process.platform !== "linux") return;

  const sessionType = (process.env.XDG_SESSION_TYPE || "").toLowerCase();
  if (sessionType !== "wayland" && !process.env.WAYLAND_DISPLAY) return;

  const log = getLogger();

  // If setup already completed, just ensure daemon is running
  if (isSetupDone()) {
    if (!isYdotooldRunning()) {
      await tryStartYdotoold(log);
    }
    return;
  }

  // If everything already works, persist flag and return
  if (commandExists("ydotool") && isYdotooldRunning()) {
    markSetupDone();
    log.debug("ydotool already configured", {}, "clipboard");
    return;
  }

  const needsInstall = !commandExists("ydotool");
  const needsUinput = !isUinputAccessible();

  // Ask user before any root escalation
  if (needsInstall || needsUinput) {
    const consent = await askUserConsent(needsInstall, needsUinput);
    if (!consent) {
      log.info("User declined ydotool setup", {}, "clipboard");
      return;
    }
  }

  try {
    if (needsInstall) {
      await installYdotool(log);
    }

    if (needsUinput) {
      await setupUinputAccess(log);
    }

    const hasUserConsent = needsInstall || needsUinput;
    await ensureYdotooldDaemon(log, { hasUserConsent });
    markSetupDone();
    log.info("ydotool setup completed", {}, "clipboard");
  } catch (error) {
    log.warn("ydotool setup failed", { error: error.message }, "clipboard");
    dialog.showMessageBox({
      type: "warning",
      title: "ydotool Setup Incomplete",
      message: "ydotool setup could not be completed.",
      detail: `Paste on Wayland may not work reliably. You can install ydotool manually.\n\n${error.message}`,
    });
  }
}

module.exports = { ensureYdotool };
