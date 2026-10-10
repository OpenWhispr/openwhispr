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
  Shift: "shift",
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

  // A letter, digit or F-key is its own label; "K" over "k" just said it twice.
  if (part.length === 1 || /^F\d{1,2}$/.test(part)) {
    return { label: "", symbol: part.toLocaleUpperCase() };
  }

  return {
    label: LABELS[part] ?? part.toLocaleLowerCase(),
    symbol: SYMBOLS[part] ?? (part.length === 1 ? part.toLocaleUpperCase() : part),
  };
}

export function getHotkeyKeycaps(value: string): HotkeyKeycapDescriptor[] {
  const parts = formatHotkeyLabel(value).split("+").filter(Boolean);
  // Chords are saved without sides, so keys held while building one drop theirs
  // too; otherwise "left control" turns into "control" the moment the chord lands.
  // A lone key keeps its side: that is what makes Right Option a distinct pick.
  const shown = parts.length > 1 ? parts.map((part) => part.replace(/^(Left|Right) /, "")) : parts;
  return shown.map((part, index) => ({ id: `${part}-${index}`, ...describeKeycap(part) }));
}

export const formatHotkeyInstruction = (value: string) =>
  formatHotkeyLabel(value).split("+").join(" + ");

export const formatRecommendedHotkey = (value: string) =>
  isGlobeLikeHotkey(value) ? "Globe/Fn" : formatHotkeyInstruction(value);

export const MACOS_DEFAULT_ONBOARDING_HOTKEY = "RightOption";

/**
 * The chord the dictation step opens on.
 *
 * macOS onboards on Right Option rather than the platform default, but only when
 * there is nothing of the user's to lose. `dictationKey` is not that signal on its
 * own — main auto-registers and persists the platform default before onboarding
 * ever runs — so `confirmed` is what separates a chord the user stood on the
 * hotkey step and accepted from one that merely got registered for them.
 * finalizeOnboarding re-registers whatever this returns, so substituting over a
 * confirmed chord overwrites their real hotkey with no screen ever saying so.
 * parseOnboardingSession is responsible for `confirmed` being true for sessions
 * that predate the flag.
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
 * Assistant picks, at most two keys each. No one chord is free on every platform:
 * macOS reserves Cmd+Space (Spotlight), Linux desktops reserve Alt+Space (window
 * menu), and GNOME, KDE and Hyprland can't watch a lone right modifier for this
 * slot. So each platform gets its own:
 * - macOS: Right Command, the free twin of dictation's Right Option, then
 *   Option+Space, the usual assistant/launcher chord.
 * - Windows: Alt+Space, the same launcher convention.
 * - Linux: Super+J, a regular-key chord every desktop backend can bind.
 */
export const getRecommendedAssistantHotkeys = (platform: Platform): string[] => {
  if (platform === "darwin") return ["RightCommand", "Alt+Space"];
  if (platform === "win32") return ["Alt+Space"];
  return ["Super+J"];
};

/**
 * The chord the assistant step opens on. `voiceAgentKey` is opt-in with no
 * platform default and nothing auto-registers it, so anything saved is the user's
 * own pick and there is no substitution to make.
 */
export const resolveOnboardingAssistantHotkey = (savedHotkey: string, platform: Platform): string =>
  savedHotkey || getRecommendedAssistantHotkeys(platform)[0];

/**
 * One-key picks lead where the platform has a spare key: right Option on macOS,
 * right Ctrl on Windows (right Alt is AltGr on many layouts). Linux offers the
 * effective default alone by choice, not by capability: a modifier-only default
 * like Control+Super runs through the same native listener, so input-device
 * access is a shared prerequisite there rather than the price of a lone right
 * modifier. Right Ctrl needs the same Windows key listener as the Control+Super
 * default, so when main reports another default the listener is missing.
 */
export const getRecommendedDictationHotkeys = (
  platform: Platform,
  effectiveDefault: string
): string[] => {
  if (platform === "darwin") return [MACOS_DEFAULT_ONBOARDING_HOTKEY, "GLOBE"];
  if (platform === "win32" && effectiveDefault === "Control+Super") {
    return ["RightControl", effectiveDefault];
  }
  return [effectiveDefault];
};
