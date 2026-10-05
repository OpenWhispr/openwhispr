const test = require("node:test");
const assert = require("node:assert/strict");

// Requires Node's native TypeScript type-stripping (Node >= 22.6 with
// --experimental-strip-types, on by default in Node 23.6+/24). CI runs Node 24.

const load = () => import("../../src/utils/hotkeys.ts");

test("isGlobeLikeHotkey matches exactly GLOBE and Fn, nothing else", async () => {
  const { isGlobeLikeHotkey } = await load();

  assert.equal(isGlobeLikeHotkey("GLOBE"), true);
  assert.equal(isGlobeLikeHotkey("Fn"), true);
  assert.equal(isGlobeLikeHotkey("F1"), false);
  assert.equal(isGlobeLikeHotkey("globe"), false);
  assert.equal(isGlobeLikeHotkey("fn"), false);
  assert.equal(isGlobeLikeHotkey(""), false);
});

test("empty input formats to an empty label", async () => {
  const { formatHotkeyLabelForPlatform } = await load();

  assert.equal(formatHotkeyLabelForPlatform("", "darwin"), "");
  assert.equal(formatHotkeyLabelForPlatform("  ", "darwin"), "");
});

test("globe-like hotkeys display as Globe/Fn on every platform", async () => {
  const { formatHotkeyLabelForPlatform } = await load();

  assert.equal(formatHotkeyLabelForPlatform("GLOBE", "darwin"), "Globe/Fn");
  assert.equal(formatHotkeyLabelForPlatform("Fn", "win32"), "Globe/Fn");
});

test("mouse button hotkeys display with spaces", async () => {
  const { formatHotkeyLabelForPlatform } = await load();

  assert.equal(formatHotkeyLabelForPlatform("MouseButton4", "darwin"), "Mouse Button 4");
  assert.equal(formatHotkeyLabelForPlatform("MouseButton5", "darwin"), "Mouse Button 5");
});

test("the same stored accelerator renders per platform: Cmd on macOS, Ctrl on Windows", async () => {
  const { formatHotkeyLabelForPlatform } = await load();

  assert.equal(formatHotkeyLabelForPlatform("CommandOrControl+K", "darwin"), "Cmd+K");
  assert.equal(formatHotkeyLabelForPlatform("CommandOrControl+K", "win32"), "Ctrl+K");
});

test("Alt displays as Option on macOS and stays Alt on Windows", async () => {
  const { formatHotkeyLabelForPlatform } = await load();

  assert.equal(formatHotkeyLabelForPlatform("Alt+R", "darwin"), "Option+R");
  assert.equal(formatHotkeyLabelForPlatform("Alt+R", "win32"), "Alt+R");
});

test("Super/Meta display as Cmd on macOS, Win on Windows, Super on Linux", async () => {
  const { formatHotkeyLabelForPlatform } = await load();

  assert.equal(formatHotkeyLabelForPlatform("Super+K", "darwin"), "Cmd+K");
  assert.equal(formatHotkeyLabelForPlatform("Meta+K", "darwin"), "Cmd+K");
  assert.equal(formatHotkeyLabelForPlatform("Super+K", "win32"), "Win+K");
  assert.equal(formatHotkeyLabelForPlatform("Meta+K", "win32"), "Win+K");
  assert.equal(formatHotkeyLabelForPlatform("Super+K", "linux"), "Super+K");
  assert.equal(formatHotkeyLabelForPlatform("Meta+K", "linux"), "Super+K");
});

test("right-side single modifiers get spelled-out platform-aware labels", async () => {
  const { formatHotkeyLabelForPlatform } = await load();

  assert.equal(formatHotkeyLabelForPlatform("RightOption", "darwin"), "Right Option");
  assert.equal(formatHotkeyLabelForPlatform("RightOption", "win32"), "Right Alt");
  assert.equal(formatHotkeyLabelForPlatform("RightSuper", "win32"), "Right Win");
  assert.equal(formatHotkeyLabelForPlatform("RightCommand", "darwin"), "Right Cmd");
});

test("left-side modifiers are labelled by side too, so a rejection can name the key pressed", async () => {
  const { formatHotkeyLabelForPlatform } = await load();

  assert.equal(formatHotkeyLabelForPlatform("LeftOption", "darwin"), "Left Option");
  assert.equal(formatHotkeyLabelForPlatform("LeftOption", "win32"), "Left Alt");
  assert.equal(formatHotkeyLabelForPlatform("LeftControl", "darwin"), "Left Ctrl");
  assert.equal(formatHotkeyLabelForPlatform("LeftCommand", "darwin"), "Left Cmd");
  assert.equal(formatHotkeyLabelForPlatform("LeftShift", "linux"), "Left Shift");
});

test("bare modifier tokens format like they do inside a chord", async () => {
  const { formatHotkeyLabelForPlatform } = await load();

  assert.equal(formatHotkeyLabelForPlatform("Alt", "darwin"), "Option");
  assert.equal(formatHotkeyLabelForPlatform("Alt", "win32"), "Alt");
  assert.equal(formatHotkeyLabelForPlatform("Command", "darwin"), "Cmd");
  assert.equal(formatHotkeyLabelForPlatform("Super", "linux"), "Super");
});

test("sidedModifierToken names the physical key behind a modifier code", async () => {
  const { sidedModifierToken } = await load();

  assert.equal(sidedModifierToken("AltRight", "darwin"), "RightOption");
  assert.equal(sidedModifierToken("AltLeft", "darwin"), "LeftOption");
  assert.equal(sidedModifierToken("AltRight", "win32"), "RightAlt");
  assert.equal(sidedModifierToken("MetaLeft", "darwin"), "LeftCommand");
  assert.equal(sidedModifierToken("MetaRight", "linux"), "RightSuper");
  assert.equal(sidedModifierToken("ControlLeft", "win32"), "LeftControl");
  assert.equal(sidedModifierToken("ShiftRight", "darwin"), "RightShift");
  // Sideless codes have no side to report.
  assert.equal(sidedModifierToken("CapsLock", "darwin"), null);
  assert.equal(sidedModifierToken("KeyK", "darwin"), null);
});

test("single keys pass through unchanged", async () => {
  const { formatHotkeyLabelForPlatform } = await load();

  assert.equal(formatHotkeyLabelForPlatform("`", "darwin"), "`");
  assert.equal(formatHotkeyLabelForPlatform("F8", "win32"), "F8");
});

test("parseHotkey splits modifiers from the base key", async () => {
  const { parseHotkey } = await load();

  assert.deepEqual(parseHotkey("CommandOrControl+Shift+K"), {
    modifiers: ["CommandOrControl", "Shift"],
    baseKey: "K",
  });
  assert.deepEqual(parseHotkey("Alt+R"), { modifiers: ["Alt"], baseKey: "R" });
  assert.deepEqual(parseHotkey("F8"), { modifiers: [], baseKey: "F8" });
  assert.deepEqual(parseHotkey(""), { modifiers: [], baseKey: "" });
  assert.deepEqual(parseHotkey(null), { modifiers: [], baseKey: "" });
});

test("isCompoundHotkey is true only when modifiers are present", async () => {
  const { isCompoundHotkey } = await load();

  assert.equal(isCompoundHotkey("Ctrl+Shift+K"), true);
  assert.equal(isCompoundHotkey("Alt+R"), true);
  assert.equal(isCompoundHotkey("F8"), false);
  assert.equal(isCompoundHotkey("GLOBE"), false);
  assert.equal(isCompoundHotkey(""), false);
  assert.equal(isCompoundHotkey(null), false);
});

test("isValidHotkeyFormat accepts single keys, globe, mouse buttons, and well-formed combos", async () => {
  const { isValidHotkeyFormat } = await load();

  assert.equal(isValidHotkeyFormat("GLOBE"), true);
  assert.equal(isValidHotkeyFormat("Fn"), true);
  assert.equal(isValidHotkeyFormat("MouseButton4"), true);
  assert.equal(isValidHotkeyFormat("`"), true);
  assert.equal(isValidHotkeyFormat("A"), true);
  assert.equal(isValidHotkeyFormat("Ctrl+K"), true);
  assert.equal(isValidHotkeyFormat("Alt+Shift+F9"), true);
});

test("isValidHotkeyFormat rejects empty input and combos with empty parts", async () => {
  const { isValidHotkeyFormat } = await load();

  assert.equal(isValidHotkeyFormat(""), false);
  assert.equal(isValidHotkeyFormat("  "), false);
  assert.equal(isValidHotkeyFormat("Ctrl+"), false);
  assert.equal(isValidHotkeyFormat("+K"), false);
});

test("parseHotkeyList preserves hotkeys ending with '+' when followed by another hotkey", async () => {
  const { parseHotkeyList } = await load();

  assert.deepEqual(parseHotkeyList("Control++,F8"), ["Control++", "F8"]);
  assert.deepEqual(parseHotkeyList("Control+,,F8"), ["Control+,", "F8"]);
  assert.deepEqual(parseHotkeyList("Control++,Control+,"), ["Control++", "Control+,"]);
});
