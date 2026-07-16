export const DEFAULT_CANCEL_HOTKEY = "Escape";

// Globe/Fn, mouse buttons, and right-side modifiers use native listeners that
// do not dispatch the temporary recording-cancel slot yet.
export function isUnsupportedRecordingCancelHotkey(hotkey) {
  return /^(?:GLOBE|Fn(?:\+.*)?|MouseButton\d+|Right(?:Alt|Command|Control|Ctrl|Meta|Option|Shift|Super|Win))$/i.test(
    hotkey?.trim() || ""
  );
}

/**
 * Register the configured recording-cancel hotkey without leaving a recording
 * uncancellable when the OS rejects a custom binding. The fallback is attempted
 * only when it differs from the requested value, so a rejected Escape binding
 * never triggers a duplicate registration attempt.
 */
export async function registerRecordingCancelHotkey(register, configuredHotkey) {
  const configured = configuredHotkey?.trim();
  const requestedHotkey =
    !configured || isUnsupportedRecordingCancelHotkey(configured)
      ? DEFAULT_CANCEL_HOTKEY
      : configured;

  const attempt = async (hotkey) => {
    try {
      const result = await register(hotkey);
      return result?.success === true;
    } catch {
      return false;
    }
  };

  if (await attempt(requestedHotkey)) {
    return { success: true, activeHotkey: requestedHotkey, usedFallback: false };
  }

  if (requestedHotkey === DEFAULT_CANCEL_HOTKEY) {
    return { success: false, activeHotkey: null, usedFallback: false };
  }

  const fallbackSucceeded = await attempt(DEFAULT_CANCEL_HOTKEY);
  return {
    success: fallbackSucceeded,
    activeHotkey: fallbackSucceeded ? DEFAULT_CANCEL_HOTKEY : null,
    usedFallback: fallbackSucceeded,
  };
}
