const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isGlobeLikeHotkey,
  isModifierOnlyHotkey,
} = require("../../src/helpers/hotkeyManager");

const isRightSideMod = (hotkey) =>
  /^Right(Control|Ctrl|Alt|Option|Shift|Super|Win|Meta|Command|Cmd)$/i.test(hotkey);

const isValidHotkey = (hotkey) => hotkey && !isGlobeLikeHotkey(hotkey);

function makeNeedsNativeListener(hotkeyManager) {
  return (hotkey, mode) => {
    if (!isValidHotkey(hotkey)) return false;
    if (mode === "push") return true;
    if (hotkeyManager.useKDE) return false;
    return isRightSideMod(hotkey) || isModifierOnlyHotkey(hotkey);
  };
}

test("KDE active + tap + modifier-only → false (no evdev)", () => {
  const fn = makeNeedsNativeListener({ useKDE: true });
  assert.equal(fn("Control+Super", "tap"), false);
});

test("KDE active + push + modifier-only → true (evdev needed for key-up)", () => {
  const fn = makeNeedsNativeListener({ useKDE: true });
  assert.equal(fn("Control+Super", "push"), true);
});

test("KDE active + tap + normal hotkey → false (KGlobalAccel handles it)", () => {
  const fn = makeNeedsNativeListener({ useKDE: true });
  assert.equal(fn("Alt+R", "tap"), false);
});

test("KDE active + tap + right-side modifier → false", () => {
  const fn = makeNeedsNativeListener({ useKDE: true });
  assert.equal(fn("RightAlt", "tap"), false);
});

test("no KDE + tap + modifier-only → true (evdev needed)", () => {
  const fn = makeNeedsNativeListener({ useKDE: false });
  assert.equal(fn("Control+Super", "tap"), true);
});

test("no KDE + tap + right-side modifier → true", () => {
  const fn = makeNeedsNativeListener({ useKDE: false });
  assert.equal(fn("RightShift", "tap"), true);
});

test("no KDE + tap + normal hotkey → false (no evdev needed)", () => {
  const fn = makeNeedsNativeListener({ useKDE: false });
  assert.equal(fn("Alt+R", "tap"), false);
});

test("no KDE + push + any hotkey → true", () => {
  const fn = makeNeedsNativeListener({ useKDE: false });
  assert.equal(fn("Alt+R", "push"), true);
  assert.equal(fn("F8", "push"), true);
  assert.equal(fn("Control+Super", "push"), true);
});

test("invalid hotkey → false regardless of KDE or mode", () => {
  const fn = makeNeedsNativeListener({ useKDE: true });
  assert.equal(fn(null, "tap"), false);
  assert.equal(fn("", "push"), false);
  assert.equal(fn(undefined, "tap"), false);
});
