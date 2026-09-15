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

/**
 * The chord the assistant step suggests. Nothing in main or Settings registers
 * a Voice Agent chord — the slot stays empty until the user accepts this step —
 * so the preset is onboarding's to own and this is the only place it is applied.
 * - Windows: Alt+Super+Space (Win+Alt+Space). Decided 2026-09-10 from a
 *   researched candidate table (Titan: windows-voice-agent-default-hotkey). It
 *   carries a regular key, so the low-level hook fires on Space rather than the
 *   moment two modifiers meet; it shares no Ctrl with the dictation default
 *   Control+Super, so that modifier-only chord cannot fire first; it is absent
 *   from Microsoft's Windows shortcut list; and with no Ctrl in it the AltGr
 *   (= Ctrl+Alt) trap on non-US layouts cannot reach it.
 * - macOS and Linux: the long-standing CommandOrControl+Shift+Space.
 */
export const getDefaultAssistantOnboardingHotkey = (platform: Platform): string =>
  platform === "win32" ? "Alt+Super+Space" : "CommandOrControl+Shift+Space";

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
 * The chord the assistant step opens on. Nothing auto-registers `voiceAgentKey`,
 * so anything saved is the user's own pick and there is no substitution to make;
 * an empty slot opens on the platform's preset above.
 */
export const resolveOnboardingAssistantHotkey = (platform: Platform, savedHotkey: string): string =>
  savedHotkey || getDefaultAssistantOnboardingHotkey(platform);

/**
 * One-key picks lead where the platform has a spare key: right Option on macOS,
 * right Ctrl on Windows (right Alt is AltGr on many layouts). Linux stays on what
 * main could register, since a lone right modifier needs input-device access.
 */
export const getRecommendedDictationHotkeys = (
  platform: Platform,
  effectiveDefault: string
): string[] => {
  if (platform === "darwin") return [MACOS_DEFAULT_ONBOARDING_HOTKEY, "GLOBE", "Control+R"];
  if (platform === "win32") return ["RightControl", effectiveDefault];
  return [effectiveDefault];
};

/**
 * Resolves the mode an onboarding shortcut may teach. A new slot becomes Hold
 * only after main confirms release events are available; an existing choice is
 * preserved unless this machine cannot deliver Hold at all.
 */
export const resolveOnboardingActivationMode = ({
  currentMode,
  storedMode,
  loaded,
  supportsPushToTalk,
}: {
  currentMode: "tap" | "push";
  storedMode: "tap" | "push" | null;
  loaded: boolean;
  supportsPushToTalk: boolean;
}): "tap" | "push" => {
  if (!loaded) return currentMode;
  if (!supportsPushToTalk) return "tap";
  if (storedMode === null) return "push";
  return currentMode;
};

/** Copy keys for a practice step. Hold-capable dictation and Voice Agent slots
 * share one gesture lesson; Tap-only fallbacks retain their existing wording. */
export const getOnboardingDemoDescriptionKeys = ({
  mode,
  tapDescriptionKey,
}: {
  mode: "tap" | "push";
  tapDescriptionKey: string;
}): string[] =>
  mode === "push"
    ? ["onboarding.activation.holdHotkey", "app.holdMigrationCard.gesture"]
    : [tapDescriptionKey];
