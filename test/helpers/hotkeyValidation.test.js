const test = require("node:test");
const assert = require("node:assert/strict");

// Requires Node's native TypeScript type-stripping (Node >= 22.6 with
// --experimental-strip-types, on by default in Node 23.6+/24). CI runs Node 24.

const load = () => import("../../src/utils/hotkeyValidator.ts");

test("empty and whitespace-only input is rejected", async () => {
  const { validateHotkey } = await load();

  assert.equal(validateHotkey("", "darwin").valid, false);
  assert.equal(validateHotkey("  ", "darwin").valid, false);
});

test("GLOBE/Fn is macOS-only — accepting it elsewhere would register a key the OS doesn't have", async () => {
  const { validateHotkey } = await load();

  assert.equal(validateHotkey("GLOBE", "darwin").valid, true);
  assert.equal(validateHotkey("Fn", "darwin").valid, true);

  const win = validateHotkey("GLOBE", "win32");
  assert.equal(win.valid, false);
  assert.equal(win.errorCode, "INVALID_GLOBE");
});

test("mouse button hotkeys are macOS-only and cannot combine with keyboard keys", async () => {
  const { validateHotkey } = await load();

  assert.equal(validateHotkey("MouseButton4", "darwin").valid, true);
  assert.equal(validateHotkey("MouseButton5", "win32").valid, false);
  assert.equal(validateHotkey("Control+MouseButton4", "darwin").valid, false);
});

test("shortcuts with more than three keys are rejected", async () => {
  const { validateHotkey } = await load();

  const result = validateHotkey("Ctrl+Alt+Shift+K", "win32");
  assert.equal(result.valid, false);
  assert.equal(result.errorCode, "TOO_MANY_KEYS");
});

test("a bare letter needs a modifier — otherwise typing that letter anywhere would trigger dictation", async () => {
  const { validateHotkey } = await load();

  const result = validateHotkey("K", "win32");
  assert.equal(result.valid, false);
  assert.equal(result.errorCode, "NO_MODIFIER_OR_SPECIAL");
});

test("standalone special keys are allowed without a modifier", async () => {
  const { validateHotkey } = await load();

  assert.equal(validateHotkey("F8", "darwin").valid, true);
  assert.equal(validateHotkey("Space", "win32").valid, true);
  assert.equal(validateHotkey("Esc", "linux").valid, true);
});

test("mixing left and right versions of the same modifier is rejected", async () => {
  const { validateHotkey } = await load();

  const result = validateHotkey("LeftCtrl+RightCtrl+K", "win32");
  assert.equal(result.valid, false);
  assert.equal(result.errorCode, "LEFT_RIGHT_MIX");
});

test("a single left-side modifier cannot be a hotkey, but a right-side one can (except on Linux)", async () => {
  const { validateHotkey } = await load();

  const left = validateHotkey("Control", "win32");
  assert.equal(left.valid, false);
  assert.equal(left.errorCode, "LEFT_MODIFIER_ONLY");

  assert.equal(validateHotkey("RightOption", "darwin").valid, true);
  assert.equal(validateHotkey("RightAlt", "win32").valid, true);

  // Right-side single modifiers need native listeners, which don't exist on Linux.
  const linux = validateHotkey("RightAlt", "linux");
  assert.equal(linux.valid, false);
  assert.equal(linux.errorCode, "LEFT_MODIFIER_ONLY");
});

test("two-modifier combos without a base key are valid", async () => {
  const { validateHotkey } = await load();

  assert.equal(validateHotkey("Control+Alt", "win32").valid, true);
  assert.equal(validateHotkey("Control+Super", "linux").valid, true);
});

test("duplicates are detected after normalization, so Ctrl+K collides with a stored Control+K", async () => {
  const { validateHotkey } = await load();

  const result = validateHotkey("Ctrl+K", "win32", ["Control+K"]);
  assert.equal(result.valid, false);
  assert.equal(result.errorCode, "DUPLICATE");
});

test("system-reserved shortcuts are rejected — registering them would break copy/paste or window switching OS-wide", async () => {
  const { validateHotkey } = await load();

  for (const [hotkey, platform] of [
    ["Command+C", "darwin"],
    ["Control+C", "win32"],
    ["Control+C", "linux"],
    ["Alt+Tab", "win32"],
    ["Alt+F4", "win32"],
    ["Control+Alt+Delete", "linux"],
  ]) {
    const result = validateHotkey(hotkey, platform);
    assert.equal(result.valid, false, `${hotkey} on ${platform} should be reserved`);
    assert.equal(result.errorCode, "RESERVED");
  }
});

test("reserved shortcuts match after normalization, so Cmd+c and Command+C are equally rejected", async () => {
  const { validateHotkey } = await load();

  const result = validateHotkey("Cmd+c", "darwin");
  assert.equal(result.valid, false);
  assert.equal(result.errorCode, "RESERVED");
});

test("ordinary compound shortcuts pass validation", async () => {
  const { validateHotkey } = await load();

  assert.equal(validateHotkey("Control+Shift+K", "darwin").valid, true);
  assert.equal(validateHotkey("Alt+F7", "win32").valid, true);
  assert.equal(validateHotkey("Control+Super+K", "linux").valid, true);
});

test("a comma-separated slot validates each entry and fails on the first bad one", async () => {
  const { validateHotkey } = await load();

  assert.equal(validateHotkey("F8,Control+Shift+K", "win32").valid, true);

  const result = validateHotkey("F8,GLOBE", "win32");
  assert.equal(result.valid, false);
  assert.equal(result.errorCode, "INVALID_GLOBE");
});

test("normalizeHotkey resolves CommandOrControl per platform", async () => {
  const { normalizeHotkey } = await load();

  assert.equal(normalizeHotkey("CommandOrControl+K", "darwin"), "Command+K");
  assert.equal(normalizeHotkey("CommandOrControl+K", "win32"), "Control+K");
  assert.equal(normalizeHotkey("CmdOrCtrl+K", "darwin"), "Command+K");
  assert.equal(normalizeHotkey("CmdOrCtrl+K", "win32"), "Control+K");
});

test("normalizeHotkey maps Option to Alt and Super/Win/Meta to the platform modifier", async () => {
  const { normalizeHotkey } = await load();

  assert.equal(normalizeHotkey("Option+R", "darwin"), "Alt+R");
  assert.equal(normalizeHotkey("Super+K", "darwin"), "Command+K");
  assert.equal(normalizeHotkey("Win+K", "win32"), "Super+K");
  assert.equal(normalizeHotkey("Meta+K", "linux"), "Super+K");
});

test("normalizeHotkey sorts modifiers into one canonical order so duplicate detection can compare strings", async () => {
  const { normalizeHotkey } = await load();

  assert.equal(normalizeHotkey("Shift+Control+K", "win32"), "Control+Shift+K");
  assert.equal(normalizeHotkey("Shift+Alt+Control+K", "win32"), "Control+Alt+Shift+K");
});

test("normalizeHotkey canonicalizes key token spellings", async () => {
  const { normalizeHotkey } = await load();

  assert.equal(normalizeHotkey("Ctrl+ArrowLeft", "win32"), "Control+Left");
  assert.equal(normalizeHotkey("Ctrl+Escape", "win32"), "Control+Esc");
  assert.equal(normalizeHotkey("Ctrl+pgup", "win32"), "Control+PageUp");
  assert.equal(normalizeHotkey("Ctrl+k", "win32"), "Control+K");
  assert.equal(normalizeHotkey("Ctrl+f9", "win32"), "Control+F9");
  assert.equal(normalizeHotkey("", "darwin"), "");
});
