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
