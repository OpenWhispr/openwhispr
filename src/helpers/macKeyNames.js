// Keep this vocabulary aligned with macos-globe-listener.swift. The native
// contract test checks every capture name against the compiled Swift resolver.
const SPECIAL_KEYS = new Set([
  "=",
  "equal",
  "-",
  "minus",
  "[",
  "]",
  "'",
  "quote",
  ";",
  "semicolon",
  "\\",
  "backslash",
  ",",
  "comma",
  "/",
  "slash",
  ".",
  "period",
  "`",
  "backquote",
  "enter",
  "return",
  "tab",
  "space",
  "backspace",
  "delete",
  "forwarddelete",
  "esc",
  "escape",
  "insert",
  "help",
  "home",
  "end",
  "pageup",
  "pagedown",
  "left",
  "arrowleft",
  "right",
  "arrowright",
  "down",
  "arrowdown",
  "up",
  "arrowup",
  "numadd",
  "numsub",
  "nummult",
  "numdiv",
  "numdec",
]);

function supportsMacKeyWatch(hotkey) {
  return (
    typeof hotkey === "string" &&
    (/^(?:[a-z0-9]|f(?:[1-9]|1\d|20)|num\d)$/i.test(hotkey) ||
      SPECIAL_KEYS.has(hotkey.toLowerCase()))
  );
}

module.exports = { supportsMacKeyWatch };
