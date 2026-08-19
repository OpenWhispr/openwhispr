import { formatHotkeyLabel } from "../../utils/hotkeys";

export interface HotkeyKeycapDescriptor {
  id: string;
  label: string;
  symbol: string;
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
function describeKeycap(part: string): { label: string; symbol: string } {
  const sided = /^(Right|Left) (.+)$/.exec(part);
  if (sided) {
    const [, side, base] = sided;
    return {
      label: `${side} ${LABELS[base] ?? base}`.toLocaleLowerCase(),
      symbol: SYMBOLS[base] ?? base,
    };
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
