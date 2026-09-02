import { getDefaultHotkey, parseHotkeyList } from "../utils/hotkeys";

// A hold-to-talk session this long is the signal that the double-press
// hands-free gesture would serve the user better than keeping a key down.
export const HANDS_FREE_TIP_HOLD_MS = 120000;
export const HANDS_FREE_TIP_MAX_SHOWS = 3;
export const HANDS_FREE_TIP_DURATION_MS = 6000;

const SHOWN_COUNT_KEY = "handsFreeTipShownCount";
const HANDS_FREE_USED_KEY = "handsFreeUsed";

// Decides whether a finished hold earns the tip. The lifetime counters live in
// storage (localStorage in the app); "once per launch" lives on the instance.
export function createHandsFreeTipGate(storage) {
  let shownThisLaunch = false;
  const shownCount = () => Number(storage.getItem(SHOWN_COUNT_KEY)) || 0;

  return {
    qualifies(heldMs) {
      return (
        heldMs >= HANDS_FREE_TIP_HOLD_MS &&
        !shownThisLaunch &&
        storage.getItem(HANDS_FREE_USED_KEY) !== "true" &&
        shownCount() < HANDS_FREE_TIP_MAX_SHOWS
      );
    },
    markShown() {
      shownThisLaunch = true;
      storage.setItem(SHOWN_COUNT_KEY, String(shownCount() + 1));
    },
    markHandsFreeUsed() {
      storage.setItem(HANDS_FREE_USED_KEY, "true");
    },
  };
}

// The tip names the binding the user just held: the first entry of that
// slot's hotkey list, falling back like useHotkey does for dictation.
export function resolveHandsFreeTipHotkey(
  inputKind,
  { dictationKey, voiceAgentKey, translationKey }
) {
  const value =
    inputKind === "assistant"
      ? voiceAgentKey
      : inputKind === "translation"
        ? translationKey
        : dictationKey;
  const [first] = parseHotkeyList(value);
  return first ?? getDefaultHotkey();
}
