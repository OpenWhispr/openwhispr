const MIN_HOLD_DURATION_MS = 150;
const POST_STOP_COOLDOWN_MS = 300;

function registerMacDictationHotkeys({
  globeKeyManager,
  windowManager,
  textEditMonitor,
  isGlobeLikeHotkey,
  isLiveWindow,
  debugLogger,
}) {
  const { hotkeyManager } = windowManager;
  let globeKeyDownTime = 0;
  let globeKeyIsRecording = false;
  let globeLastStopTime = 0;
  const globeBinding = "GLOBE";

  globeKeyManager.on("globe-down", async () => {
    const currentHotkey = hotkeyManager.getCurrentHotkey && hotkeyManager.getCurrentHotkey();
    const mainWindowLive = isLiveWindow(windowManager.mainWindow);
    debugLogger?.debug("[Globe] globe-down received", {
      currentHotkey,
      mainWindowLive,
      activationMode: mainWindowLive ? windowManager.getActivationMode() : "n/a",
    });

    // Forward to control panel for hotkey capture
    if (isLiveWindow(windowManager.controlPanelWindow)) {
      windowManager.controlPanelWindow.webContents.send("globe-key-pressed");
    }

    // Handle dictation if Globe/Fn is one of the dictation hotkeys
    const dictationUsesGlobe = hotkeyManager.getSlotHotkeys("dictation").some(isGlobeLikeHotkey);
    if (dictationUsesGlobe) {
      if (mainWindowLive && windowManager.isDictationProcessing()) {
        debugLogger?.debug("[Globe] Ignored — dictation processing");
      } else if (mainWindowLive) {
        const activationMode = windowManager.getActivationMode();
        if (activationMode !== "tap" && windowManager.pressHandsFreeDictation(globeBinding)) {
          return;
        }
        // Capture target app PID BEFORE showing the overlay
        if (textEditMonitor) textEditMonitor.captureTargetPid();
        if (activationMode !== "tap") {
          const now = Date.now();
          if (
            now - globeLastStopTime < POST_STOP_COOLDOWN_MS &&
            !windowManager.canPairDictationTap(globeBinding)
          ) {
            debugLogger?.debug("[Globe] Ignored — cooldown active");
            return;
          }
          windowManager.showDictationPanel();
          windowManager.sendPrepareDictation();
          const pressTime = now;
          globeKeyDownTime = pressTime;
          globeKeyIsRecording = false;
          setTimeout(async () => {
            if (globeKeyDownTime === pressTime && !globeKeyIsRecording) {
              globeKeyIsRecording = true;
              windowManager.interruptDictationTap(globeBinding);
              debugLogger?.debug("[Globe] Starting dictation (push hold)");
              windowManager.sendStartDictation();
            }
          }, MIN_HOLD_DURATION_MS);
        } else {
          windowManager.sendToggleDictation();
        }
      } else {
        debugLogger?.debug("[Globe] Ignored — mainWindow not live");
      }
    }

    // Check voice agent slot for Globe/Fn key
    const voiceAgentUsesGlobe = hotkeyManager.getSlotHotkeys("voiceAgent").some(isGlobeLikeHotkey);
    const translationUsesGlobe = hotkeyManager
      .getSlotHotkeys("translation")
      .some(isGlobeLikeHotkey);
    if (voiceAgentUsesGlobe) {
      windowManager.sendToggleVoiceAgent();
    }
    if (translationUsesGlobe) {
      windowManager.sendToggleTranslation();
    }
    if (!voiceAgentUsesGlobe && !translationUsesGlobe && !dictationUsesGlobe) {
      debugLogger?.debug("[Globe] Ignored — hotkey is not GLOBE", { currentHotkey });
    }
  });

  globeKeyManager.on("globe-up", async () => {
    debugLogger?.debug("[Globe] globe-up received", { wasRecording: globeKeyIsRecording });

    // Forward to control panel for hotkey capture (Fn key released)
    if (isLiveWindow(windowManager.controlPanelWindow)) {
      windowManager.controlPanelWindow.webContents.send("globe-key-released");
    }

    if (hotkeyManager.getSlotHotkeys("dictation").some(isGlobeLikeHotkey)) {
      const activationMode = windowManager.getActivationMode();
      if (activationMode !== "tap") {
        if (windowManager.releaseHandsFreeDictation(globeBinding)) return;
        if (globeKeyDownTime === 0 && !globeKeyIsRecording) {
          // The press was ignored (dictation was processing); releasing it
          // must not cancel preparation or hide the thinking pill.
          debugLogger?.debug("[Globe] Release without a registered press — ignored");
        } else {
          globeKeyDownTime = 0;
          globeLastStopTime = Date.now();
          if (globeKeyIsRecording) {
            globeKeyIsRecording = false;
            debugLogger?.debug("[Globe] Stopping dictation (push release)");
            windowManager.sendStopDictation();
          } else if (!windowManager.tryStartHandsFreeDictation(globeBinding)) {
            windowManager.sendCancelDictationPreparation();
            windowManager.hideDictationPanel();
          }
        }
      }
    }

    // Fn release also stops compound push-to-talk for Fn+F-key hotkeys
    windowManager.handleMacPushModifierUp("fn");
  });

  // Another key was pressed while Fn was held — user is using Fn as a
  // navigation modifier (Fn+Arrow → Home, Fn+Backspace → Forward Delete, etc.).
  // Cancel any bare-Fn push-to-talk in progress instead of transcribing noise.
  // Only the bare-Fn path uses globeKeyDownTime/globeKeyIsRecording, so compound
  // Fn-hotkey push-to-talk and tap mode are untouched.
  const interruptGlobeDictation = () => {
    windowManager.interruptDictationTap(globeBinding);
    if (globeKeyDownTime === 0 && !globeKeyIsRecording) {
      return;
    }
    const wasRecording = globeKeyIsRecording;
    debugLogger?.debug("[Globe] Bare Fn interrupted push-to-talk", { wasRecording });
    globeKeyDownTime = 0;
    globeKeyIsRecording = false;
    globeLastStopTime = Date.now();
    if (wasRecording) {
      windowManager.sendCancelDictation();
    } else {
      windowManager.sendCancelDictationPreparation();
      windowManager.hideDictationPanel();
    }
  };

  globeKeyManager.on("globe-interrupted", interruptGlobeDictation);
  globeKeyManager.on("globe-tap-interrupted", () => {
    if (
      windowManager.isDictationDoublePressEnabled() &&
      hotkeyManager.getSlotHotkeys("dictation").some(isGlobeLikeHotkey)
    ) {
      interruptGlobeDictation();
    }
  });

  globeKeyManager.on("modifier-up", (modifier) => {
    if (windowManager?.handleMacPushModifierUp) {
      windowManager.handleMacPushModifierUp(modifier);
    }
  });

  globeKeyManager.on("modifier-down", (modifier) => {
    windowManager.handleMacCompoundModifierDown(modifier);
  });

  globeKeyManager.on("compound-key-up", (terminalKey) => {
    windowManager.handleMacCompoundKeyUp(terminalKey);
  });

  // Right-side single modifier handling (e.g., RightOption as hotkey)
  let rightModDownTime = 0;
  let rightModIsRecording = false;
  let rightModLastStopTime = 0;
  let rightModActiveKey = null;

  globeKeyManager.on("right-modifier-down", async (modifier) => {
    hotkeyManager.logHotkeyEvent("macos-native", "down", modifier);
    // Check voice agent slot for right-modifier
    if (hotkeyManager.slotHasHotkey("voiceAgent", modifier)) {
      windowManager.sendToggleVoiceAgent();
    }
    if (hotkeyManager.slotHasHotkey("translation", modifier)) {
      windowManager.sendToggleTranslation();
    }

    if (!hotkeyManager.slotHasHotkey("dictation", modifier)) return;
    if (!isLiveWindow(windowManager.mainWindow)) return;
    if (windowManager.isDictationProcessing()) return;

    const activationMode = windowManager.getActivationMode();
    if (activationMode !== "tap" && windowManager.pressHandsFreeDictation(modifier)) return;
    if (textEditMonitor) textEditMonitor.captureTargetPid();
    if (activationMode !== "tap") {
      if (rightModActiveKey && rightModActiveKey !== modifier) return;
      const now = Date.now();
      if (
        now - rightModLastStopTime < POST_STOP_COOLDOWN_MS &&
        !windowManager.canPairDictationTap(modifier)
      )
        return;
      windowManager.showDictationPanel();
      windowManager.sendPrepareDictation();
      const pressTime = now;
      rightModActiveKey = modifier;
      rightModDownTime = pressTime;
      rightModIsRecording = false;
      setTimeout(() => {
        if (rightModDownTime === pressTime && !rightModIsRecording) {
          rightModIsRecording = true;
          windowManager.interruptDictationTap(modifier);
          windowManager.sendStartDictation();
        }
      }, MIN_HOLD_DURATION_MS);
    } else {
      windowManager.sendToggleDictation();
    }
  });

  globeKeyManager.on("right-modifier-up", async (modifier) => {
    hotkeyManager.logHotkeyEvent("macos-native", "up", modifier);
    if (hotkeyManager.slotHasHotkey("dictation", modifier)) {
      if (!isLiveWindow(windowManager.mainWindow)) return;

      const activationMode = windowManager.getActivationMode();
      if (activationMode !== "tap" && (!rightModActiveKey || rightModActiveKey === modifier)) {
        if (windowManager.releaseHandsFreeDictation(modifier)) return;
        if (rightModDownTime === 0 && !rightModIsRecording) {
          // The press was ignored (dictation was processing); releasing it
          // must not cancel preparation or hide the thinking pill.
          debugLogger?.debug("[RightMod] Release without a registered press — ignored");
        } else {
          rightModActiveKey = null;
          rightModDownTime = 0;
          rightModLastStopTime = Date.now();
          if (rightModIsRecording) {
            rightModIsRecording = false;
            windowManager.sendStopDictation();
          } else if (!windowManager.tryStartHandsFreeDictation(modifier)) {
            windowManager.sendCancelDictationPreparation();
            windowManager.hideDictationPanel();
          }
        }
      }
    }
  });

  globeKeyManager.on("right-modifier-interrupted", (modifier) => {
    if (
      !windowManager.isDictationDoublePressEnabled() ||
      !hotkeyManager.slotHasHotkey("dictation", modifier)
    ) {
      return;
    }
    windowManager.interruptDictationTap(modifier);
    if (rightModActiveKey !== modifier) return;

    const wasRecording = rightModIsRecording;
    rightModActiveKey = null;
    rightModDownTime = 0;
    rightModIsRecording = false;
    if (wasRecording) {
      rightModLastStopTime = Date.now();
      windowManager.sendCancelDictation();
    } else {
      windowManager.sendCancelDictationPreparation();
      windowManager.hideDictationPanel();
    }
  });

  return function resetMacDictationHotkeys() {
    globeKeyDownTime = 0;
    globeKeyIsRecording = false;
    globeLastStopTime = 0;
    rightModDownTime = 0;
    rightModIsRecording = false;
    rightModLastStopTime = 0;
    rightModActiveKey = null;
  };
}

function registerMacKeyboardMonitor({
  globeKeyManager,
  windowManager,
  broadcastToWindows,
  onUnavailable,
}) {
  const { hotkeyManager } = windowManager;
  windowManager.canObserveHandsFreeInput = () => globeKeyManager.hasKeyboardMonitor;
  hotkeyManager.getMacKeyboardMonitorStatus = () => globeKeyManager.keyboardMonitorStatus;
  globeKeyManager.on("keyboard-monitor-status-changed", (status) => {
    if (status !== "ready") windowManager.resetDictationDoublePress();
    if (status === "unavailable") onUnavailable();
    broadcastToWindows("hotkey-mode-info-changed");
  });
}

function registerRawDictationHotkeys({
  nativeKeyManager,
  windowManager,
  isWindows,
  isLiveWindow,
  onExactModifiersUnavailable,
  debugLogger,
}) {
  const { hotkeyManager } = windowManager;
  const usesDesktopShortcut = () => !isWindows && hotkeyManager.isUsingNativeShortcut();
  const acceptsDictationEvent = (exactModifiers) => {
    if (!windowManager.isDictationDoublePressEnabled()) return exactModifiers !== true;
    return !usesDesktopShortcut() && exactModifiers === true;
  };
  debugLogger.debug("[Push-to-Talk] Native key listener setup starting");

  // Dictation supports push-to-talk and needs the overlay window; meeting
  // drives other windows (matching their globalShortcut callbacks and macOS).
  const dispatchNativeKeyDown = (key, { exactModifiers } = {}) => {
    hotkeyManager.logHotkeyEvent("native-listener", "down", key);
    if (hotkeyManager.slotHasHotkey("dictation", key)) {
      if (!acceptsDictationEvent(exactModifiers) || !isLiveWindow(windowManager.mainWindow)) return;
      if (windowManager.getActivationMode() !== "tap") {
        windowManager.startWindowsPushToTalk(key);
      } else {
        windowManager.sendToggleDictation();
      }
      return;
    }
    if (hotkeyManager.slotHasHotkey("voiceAgent", key)) {
      windowManager.sendToggleVoiceAgent();
    } else if (hotkeyManager.slotHasHotkey("translation", key)) {
      windowManager.sendToggleTranslation();
    } else if (hotkeyManager.slotHasHotkey("meeting", key)) {
      windowManager.startManualMeeting({ activate: false, startSource: "hotkey" });
    }
  };

  // Only dictation drives push-to-talk, so only its key-up matters.
  const dispatchNativeKeyUp = (key, { exactModifiers } = {}) => {
    hotkeyManager.logHotkeyEvent("native-listener", "up", key);
    if (!acceptsDictationEvent(exactModifiers) || !hotkeyManager.slotHasHotkey("dictation", key)) {
      return;
    }
    if (windowManager.winPushState?.active) {
      windowManager.handleWindowsPushKeyUp(key);
    } else if (
      isLiveWindow(windowManager.mainWindow) &&
      windowManager.getActivationMode() !== "tap"
    ) {
      windowManager.handleWindowsPushKeyUp(key);
    }
  };

  nativeKeyManager.on("key-down", dispatchNativeKeyDown);
  nativeKeyManager.on("key-up", dispatchNativeKeyUp);
  nativeKeyManager.on("key-interrupted", (key, { exactModifiers } = {}) => {
    if (
      exactModifiers &&
      acceptsDictationEvent(exactModifiers) &&
      hotkeyManager.slotHasHotkey("dictation", key)
    ) {
      windowManager.interruptNativeDictationTap(key);
    }
  });

  nativeKeyManager.on("error", (error, exactKey) => {
    if (isWindows || hotkeyManager.reliesOnLinuxKeyListener()) {
      windowManager.resetDictationDoublePress();
      if (exactKey) windowManager.handleWindowsPushKeyUp(exactKey, { reason: "reset" });
    }
    debugLogger.warn("[Push-to-Talk] Native key listener error", { error: error.message });
    if (error.code === "exact_modifiers_unavailable") {
      onExactModifiersUnavailable();
      return;
    }
    if (isWindows && isLiveWindow(windowManager.mainWindow)) {
      windowManager.mainWindow.webContents.send("windows-ptt-unavailable", {
        reason: "error",
        message: error.message,
      });
    }
  });
}

module.exports = {
  MIN_HOLD_DURATION_MS,
  POST_STOP_COOLDOWN_MS,
  registerMacDictationHotkeys,
  registerMacKeyboardMonitor,
  registerRawDictationHotkeys,
};
