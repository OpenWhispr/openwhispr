function createDictationStartupMode({
  windowManager,
  environmentManager,
  getAllWindows,
  debugLogger,
}) {
  // This fallback is runtime-only so the next launch can retry the saved preference.
  async function dropUnsupportedStartupHold(preRegistrationHotkey) {
    const mode = windowManager.getActivationMode();
    if (mode === "tap") return false;
    const manager = windowManager.hotkeyManager;
    const hotkey = preRegistrationHotkey ?? manager.getCurrentHotkey();
    const fallbackMode = !manager.supportsPushToTalk(hotkey)
      ? "tap"
      : mode === "push-double-tap" &&
          manager.getDictationDoublePressUnavailableReason(preRegistrationHotkey)
        ? "push"
        : null;
    if (!fallbackMode || !(await windowManager.setActivationModeCache(fallbackMode))) return false;

    for (const browserWindow of getAllWindows()) {
      if (!browserWindow.isDestroyed()) {
        browserWindow.webContents.send("setting-updated", {
          key: "activationMode",
          value: fallbackMode,
        });
      }
    }
    return true;
  }

  async function checkStartupHold() {
    const manager = windowManager.hotkeyManager;
    const mode = windowManager.getActivationMode();
    if (mode === "tap") return;

    // Desktop backends need a compatible mode before asking the compositor to bind.
    // Elsewhere, combined mode must wait for the real binding or a valid saved
    // shortcut could be rejected on account of the provisional default.
    if (manager.isUsingNativeShortcut()) {
      await dropUnsupportedStartupHold(await manager.getSavedDictationHotkey());
    } else if (mode === "push") {
      await dropUnsupportedStartupHold();
    }

    void manager.registrationReady
      .then(async () => {
        if (await dropUnsupportedStartupHold()) windowManager.reconcileNativeKeyListeners();
      })
      .catch((err) => {
        debugLogger.warn("[HotkeyManager] Startup activation mode recheck failed", {
          error: err.message,
        });
      });
  }

  return {
    restoreSavedActivationMode: () =>
      windowManager.restoreActivationMode(environmentManager.getActivationMode()),
    checkStartupHold,
    dropUnsupportedStartupHold,
  };
}

module.exports = createDictationStartupMode;
