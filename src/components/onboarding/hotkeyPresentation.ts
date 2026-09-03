import { formatHotkeyLabel, isGlobeLikeHotkey } from "../../utils/hotkeys";
import type { Platform } from "../../utils/platform";

export interface HotkeyKeycapDescriptor {
  id: string;
  label: string;
  symbol: string;
  icon?: "globe";
}

const SYMBOLS: Record<string, string> = {
  Ctrl: "⌃",
  Control: "⌃",
  Option: "⌥",
  Alt: "⌥",
  Cmd: "⌘",
  Command: "⌘",
  Shift: "⇧",
  Win: "⊞",
  Super: "◆",
  "Globe/Fn": "◎",
  Fn: "◎",
  // Named keys need an explicit glyph: without one the fallback prints the whole
  // word into the keycap's symbol slot, which is sized for a single mark.
  Space: "␣",
  Enter: "⏎",
  Return: "⏎",
  Tab: "⇥",
  Backspace: "⌫",
  Delete: "⌦",
  Escape: "⎋",
  Esc: "⎋",
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
  // The pointer marks keep a mouse binding from printing its whole label into
  // the symbol slot, which is sized for a single glyph.
  "Mouse Button 4": "⇱",
  "Mouse Button 5": "⇲",
};

const LABELS: Record<string, string> = {
  Ctrl: "control",
  Control: "control",
  Option: "option",
  Alt: "alt",
  Cmd: "command",
  Command: "command",
  Shift: "Shift",
  Win: "windows",
  Super: "super",
  "Globe/Fn": "fn",
  Fn: "fn",
  Space: "space",
  Enter: "enter",
  Return: "return",
  Tab: "tab",
  Backspace: "delete",
  Delete: "forward delete",
  Escape: "esc",
  Esc: "esc",
  Up: "up",
  Down: "down",
  Left: "left",
  Right: "right",
  "Mouse Button 4": "mouse 4",
  "Mouse Button 5": "mouse 5",
};

/**
 * "Right Option" keeps ⌥ as its symbol and says which side in the label, so a
 * side-specific binding is readable on a cap sized for one glyph.
 */
function describeKeycap(part: string): Omit<HotkeyKeycapDescriptor, "id"> {
  const sided = /^(Right|Left) (.+)$/.exec(part);
  if (sided) {
    const [, side, base] = sided;
    return {
      label: `${side} ${LABELS[base] ?? base}`.toLocaleLowerCase(),
      symbol: SYMBOLS[base] ?? base,
    };
  }

  if (part === "Globe/Fn" || part === "Fn") {
    return { label: "fn", symbol: "◎", icon: "globe" };
  }

  return {
    label: LABELS[part] ?? part.toLocaleLowerCase(),
    symbol: SYMBOLS[part] ?? (part.length === 1 ? part.toLocaleUpperCase() : part),
  };
}

export function getHotkeyKeycaps(value: string): HotkeyKeycapDescriptor[] {
  return formatHotkeyLabel(value)
    .split("+")
    .filter(Boolean)
    .map((part, index) => ({ id: `${part}-${index}`, ...describeKeycap(part) }));
}

export const formatHotkeyInstruction = (value: string) =>
  formatHotkeyLabel(value).split("+").join(" + ");

export const formatRecommendedHotkey = (value: string) =>
  isGlobeLikeHotkey(value) ? "Globe/Fn" : formatHotkeyInstruction(value);

export const MACOS_DEFAULT_ONBOARDING_HOTKEY = "RightOption";
export const DEFAULT_ASSISTANT_ONBOARDING_HOTKEY = "CommandOrControl+Shift+Space";

/**
 * The chord the dictation step opens on.
 *
 * macOS onboards on Right Option rather than the platform default, but only when
 * there is nothing of the user's to lose: `confirmed` is false for a session the
 * legacy numeric migration rebuilt (and for any session written before the resume
 * flags existed), so a saved hotkey that isn't simply the platform default is
 * treated as the user's own choice and kept. finalizeOnboarding re-registers
 * whatever this returns, so overwriting it here overwrites their real hotkey.
 */
export const resolveOnboardingDictationHotkey = ({
  platform,
  savedHotkey,
  platformDefault,
  confirmed,
}: {
  platform: Platform;
  savedHotkey: string;
  platformDefault: string;
  confirmed: boolean;
}): string => {
  if (platform !== "darwin") return savedHotkey || platformDefault;
  if (savedHotkey && (confirmed || savedHotkey !== platformDefault)) return savedHotkey;
  return MACOS_DEFAULT_ONBOARDING_HOTKEY;
};

/**
 * The chord the assistant step opens on.
 *
 * Unlike dictation, `voiceAgentKey` has no platform default and no substitution,
 * so a saved chord is always the user's own pick and is kept — there is nothing
 * here for a `confirmed` flag to tell apart.
 */
export const resolveOnboardingAssistantHotkey = (savedHotkey: string): string =>
  savedHotkey || DEFAULT_ASSISTANT_ONBOARDING_HOTKEY;

export const getRecommendedDictationHotkeys = (
  platform: Platform,
  effectiveDefault: string
): string[] =>
  platform === "darwin"
    ? [MACOS_DEFAULT_ONBOARDING_HOTKEY, "GLOBE", "Control+R"]
    : [effectiveDefault];
