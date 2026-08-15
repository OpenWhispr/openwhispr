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
