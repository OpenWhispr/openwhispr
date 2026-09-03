const assert = require("node:assert/strict");
const test = require("node:test");

const load = () => import("../../src/components/onboarding/hotkeyPresentation.ts");

test("Globe/Fn renders as one reusable physical key", async () => {
  const { getHotkeyKeycaps } = await load();

  assert.deepEqual(getHotkeyKeycaps("GLOBE"), [
    { id: "Globe/Fn-0", label: "fn", symbol: "◎", icon: "globe" },
  ]);
});

test("compound shortcuts produce ordered keycaps and readable instructions", async () => {
  const { formatHotkeyInstruction, getHotkeyKeycaps } = await load();

  assert.deepEqual(
    getHotkeyKeycaps("Control+Shift+K").map(({ label }) => label),
    ["control", "Shift", "k"]
  );
  assert.equal(formatHotkeyInstruction("Control+Shift+K"), "Ctrl + Shift + K");
});

test("macOS recommends Right Option first, followed by Globe/Fn and Ctrl + R", async () => {
  const {
    DEFAULT_ASSISTANT_ONBOARDING_HOTKEY,
    formatRecommendedHotkey,
    getRecommendedDictationHotkeys,
  } = await load();

  assert.deepEqual(
    getRecommendedDictationHotkeys("darwin", "Command+K").map(formatRecommendedHotkey),
    ["Right Option", "Globe/Fn", "Ctrl + R"]
  );
  assert.deepEqual(getRecommendedDictationHotkeys("linux", "Control+Super"), ["Control+Super"]);
  assert.deepEqual(getRecommendedDictationHotkeys("win32", "Control+Shift+Space"), [
    "Control+Shift+Space",
  ]);
  assert.equal(DEFAULT_ASSISTANT_ONBOARDING_HOTKEY, "CommandOrControl+Shift+Space");
  assert.equal(formatRecommendedHotkey(DEFAULT_ASSISTANT_ONBOARDING_HOTKEY), "Cmd + Shift + Space");
});

test("the dictation step never opens on a chord that would overwrite the user's own", async () => {
  const { resolveOnboardingDictationHotkey } = await load();
  const onMac = (savedHotkey, confirmed) =>
    resolveOnboardingDictationHotkey({
      platform: "darwin",
      savedHotkey,
      platformDefault: "GLOBE",
      confirmed,
    });

  // Nothing of the user's to lose: onboard on the macOS default.
  assert.equal(onMac("", false), "RightOption");
  assert.equal(onMac("", true), "RightOption");
  assert.equal(onMac("GLOBE", false), "RightOption");

  // A hotkey the user picked survives, confirmed or not. `confirmed` is false for
  // a session rebuilt by the legacy numeric migration and for any session written
  // before the resume flags existed, and finalizeOnboarding re-registers whatever
  // this returns — so returning the macOS default here would erase their chord.
  assert.equal(onMac("Control+Shift+D", false), "Control+Shift+D");
  assert.equal(onMac("Control+Shift+D", true), "Control+Shift+D");
  assert.equal(onMac("GLOBE", true), "GLOBE");
});

test("only macOS substitutes an onboarding default for the platform one", async () => {
  const { resolveOnboardingDictationHotkey } = await load();

  for (const platform of ["win32", "linux"]) {
    for (const confirmed of [false, true]) {
      const resolve = (savedHotkey) =>
        resolveOnboardingDictationHotkey({
          platform,
          savedHotkey,
          platformDefault: "Control+Super",
          confirmed,
        });
      assert.equal(resolve(""), "Control+Super");
      assert.equal(resolve("Control+Super"), "Control+Super");
      assert.equal(resolve("F8"), "F8");
      assert.equal(resolve("Control+Shift+D"), "Control+Shift+D");
    }
  }
});

test("a side-specific modifier keeps its glyph and says which side in the label", async () => {
  const { getHotkeyKeycaps } = await load();

  const caps = getHotkeyKeycaps("RightOption");
  assert.equal(caps.length, 1);
  assert.equal(caps[0].symbol, "\u2325");
  assert.match(caps[0].label, /^right (option|alt)$/);
});

test("a mouse binding gets a glyph instead of printing its label into the symbol slot", async () => {
  const { getHotkeyKeycaps } = await load();

  assert.deepEqual(getHotkeyKeycaps("MouseButton4"), [
    { id: "Mouse Button 4-0", label: "mouse 4", symbol: "\u21f1" },
  ]);
});
