// Canonical form of a hotkey, for COMPARISON only — never for storage.
//
// Main had no equivalent of the renderer's normalizeHotkey: slotHasHotkey and
// findSlotByHotkey compare raw strings, and normalizeToAccelerator only strips
// Right* prefixes. So four spellings of one chord (Ctrl+Shift+Space,
// Control+Shift+Space, CommandOrControl+Shift+Space, Shift+Control+Space)
// stayed four distinct strings in main while the renderer already treated them
// as one, and a per-row lookup keyed on the renderer's answer would miss.
//
// Canonical form is platform-dependent (CommandOrControl and Super resolve
// differently on macOS), which is exactly why stored data keeps the user's
// original spelling and only comparisons go through here.
//
// Keep in sync with the renderer twin normalizeHotkey in
// src/utils/hotkeyValidator.ts. test/helpers/hotkeyCanonicalTwin.test.js runs
// both over one alias table and fails if they ever disagree.

const MODIFIER_ORDER = ["Control", "Command", "Alt", "Shift", "Super", "Fn"];

const RIGHT_SIDE_MODIFIERS = new Set([
  "rightcontrol",
  "rightctrl",
  "rightalt",
  "rightoption",
  "rightshift",
  "rightcommand",
  "rightcmd",
  "rightsuper",
  "rightmeta",
  "rightwin",
  "controlright",
  "ctrlright",
  "altright",
  "optionright",
  "shiftright",
  "commandright",
  "cmdright",
  "superright",
  "metaright",
  "winright",
]);

const LEFT_SIDE_MODIFIERS = new Set([
  "leftcontrol",
  "leftctrl",
  "leftalt",
  "leftoption",
  "leftshift",
  "leftcommand",
  "leftcmd",
  "leftsuper",
  "leftmeta",
  "leftwin",
  "controlleft",
  "ctrlleft",
  "altleft",
  "optionleft",
  "shiftleft",
  "commandleft",
  "cmdleft",
  "superleft",
  "metaleft",
  "winleft",
]);

const KEY_TOKEN_ALIASES = {
  arrowleft: "Left",
  arrowright: "Right",
  arrowup: "Up",
  arrowdown: "Down",
  escape: "Esc",
  esc: "Esc",
  printscreen: "PrintScreen",
  print: "PrintScreen",
  pageup: "PageUp",
  pgup: "PageUp",
  pagedown: "PageDown",
  pgdown: "PageDown",
  scrolllock: "ScrollLock",
  numlock: "NumLock",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  ins: "Insert",
  space: "Space",
  tab: "Tab",
  home: "Home",
  end: "End",
  backspace: "Backspace",
  globe: "GLOBE",
  fn: "Fn",
  mousebutton4: "MouseButton4",
  mousebutton5: "MouseButton5",
};

function sideless(part) {
  return part.replace(/[-_ ]/g, "").toLowerCase();
}

function normalizeModifier(part, platform) {
  const trimmed = part.replace(/\s+/g, "");
  const lowered = trimmed.toLowerCase();

  if (lowered === "commandorcontrol" || lowered === "cmdorctrl") {
    return platform === "darwin" ? "Command" : "Control";
  }
  if (lowered === "command" || lowered === "cmd") return "Command";
  if (lowered === "control" || lowered === "ctrl") return "Control";
  if (lowered === "alt" || lowered === "option") return "Alt";
  if (lowered === "shift") return "Shift";
  if (lowered === "super" || lowered === "win" || lowered === "meta") {
    return platform === "darwin" ? "Command" : "Super";
  }
  if (lowered === "fn") return "Fn";

  if (RIGHT_SIDE_MODIFIERS.has(sideless(part))) {
    if (lowered.includes("control") || lowered.includes("ctrl")) return "RightControl";
    if (lowered.includes("alt") || lowered.includes("option")) {
      return platform === "darwin" ? "RightOption" : "RightAlt";
    }
    if (lowered.includes("shift")) return "RightShift";
    if (lowered.includes("command") || lowered.includes("cmd")) return "RightCommand";
    if (lowered.includes("super") || lowered.includes("meta") || lowered.includes("win")) {
      return platform === "darwin" ? "RightCommand" : "RightSuper";
    }
  }

  if (LEFT_SIDE_MODIFIERS.has(sideless(part))) {
    if (lowered.includes("control") || lowered.includes("ctrl")) return "LeftControl";
    if (lowered.includes("alt") || lowered.includes("option")) {
      return platform === "darwin" ? "LeftOption" : "LeftAlt";
    }
    if (lowered.includes("shift")) return "LeftShift";
    if (lowered.includes("command") || lowered.includes("cmd")) return "LeftCommand";
    if (lowered.includes("super") || lowered.includes("meta") || lowered.includes("win")) {
      return platform === "darwin" ? "LeftCommand" : "LeftSuper";
    }
  }

  return null;
}

function normalizeKeyToken(part) {
  const trimmed = part.replace(/\s+/g, "");
  const lowered = trimmed.toLowerCase();

  const alias = KEY_TOKEN_ALIASES[lowered];
  if (alias) return alias;

  const functionMatch = lowered.match(/^f(\d{1,2})$/);
  if (functionMatch) return `F${functionMatch[1]}`;

  if (trimmed.length === 1) return trimmed.toUpperCase();
  return trimmed;
}

/**
 * One chord, one string. Modifiers are aliased and sorted; the key token is
 * aliased and single characters are upper-cased. "Control+," survives because
 * the comma is just a one-character key token here — list splitting is
 * parseHotkeyList's problem, not this function's.
 */
function canonicalizeHotkey(hotkey, platform = process.platform) {
  if (!hotkey || typeof hotkey !== "string") return "";

  const parts = hotkey
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);

  const modifiers = [];
  const keys = [];
  for (const part of parts) {
    const modifier = normalizeModifier(part, platform);
    if (modifier) modifiers.push(modifier);
    else keys.push(normalizeKeyToken(part));
  }

  modifiers.sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b));
  return [...modifiers, ...keys].join("+");
}

/** True when two spellings name the same physical chord. */
function sameHotkey(a, b, platform = process.platform) {
  return canonicalizeHotkey(a, platform) === canonicalizeHotkey(b, platform);
}

module.exports = { canonicalizeHotkey, sameHotkey, MODIFIER_ORDER };
