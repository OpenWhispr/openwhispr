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
};

export function getHotkeyKeycaps(value: string): HotkeyKeycapDescriptor[] {
  return formatHotkeyLabel(value)
    .split("+")
    .filter(Boolean)
    .map((part, index) => ({
      id: `${part}-${index}`,
      label: LABELS[part] ?? part.toLocaleLowerCase(),
      symbol: SYMBOLS[part] ?? (part.length === 1 ? part.toLocaleUpperCase() : part),
    }));
}

export const formatHotkeyInstruction = (value: string) =>
  formatHotkeyLabel(value).split("+").join(" + ");
