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
    getHotkeyKeycaps("Control+Shift+K").map(({ label, symbol }) => [symbol, label]),
    // A letter is its own label, so it is printed once rather than "K" over "k".
    [
      ["⌃", "control"],
      ["⇧", "shift"],
      ["K", ""],
    ]
  );
  assert.equal(formatHotkeyInstruction("Control+Shift+K"), "Ctrl + Shift + K");
});

test("each platform recommends its own dictation and assistant shortcuts", async () => {
  const {
    getRecommendedAssistantHotkeys,
    formatRecommendedHotkey,
    getRecommendedDictationHotkeys,
  } = await load();

  assert.deepEqual(
    getRecommendedDictationHotkeys("darwin", "Command+K").map(formatRecommendedHotkey),
    ["Right Option", "Globe/Fn"]
  );
  assert.deepEqual(getRecommendedDictationHotkeys("linux", "Control+Super"), ["Control+Super"]);
  // Right Ctrl leads on Windows: right Alt is AltGr on many layouts.
  assert.deepEqual(getRecommendedDictationHotkeys("win32", "Control+Super"), [
    "RightControl",
    "Control+Super",
  ]);
  // Main falls back to F8 when the Windows key listener is missing (#2005), and
  // Right Ctrl needs that listener too.
  assert.deepEqual(getRecommendedDictationHotkeys("win32", "F8"), ["F8"]);
  // Assistant picks stay at two keys or fewer, and none is reserved where it is offered.
  assert.deepEqual(getRecommendedAssistantHotkeys("darwin"), ["RightCommand", "Alt+Space"]);
  assert.deepEqual(getRecommendedAssistantHotkeys("win32"), ["Alt+Space"]);
  assert.deepEqual(getRecommendedAssistantHotkeys("linux"), ["Super+J"]);
  for (const platform of ["darwin", "win32", "linux"]) {
    for (const hotkey of getRecommendedAssistantHotkeys(platform)) {
      assert.ok(hotkey.split("+").length <= 2, `${platform}: ${hotkey}`);
    }
  }
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

  // Nothing of the user's to lose: main auto-registers and persists GLOBE before
  // onboarding runs, so an unconfirmed one is not a choice anybody made.
  assert.equal(onMac("", false), "RightOption");
  assert.equal(onMac("", true), "RightOption");
  assert.equal(onMac("GLOBE", false), "RightOption");

  // A chord the user accepted on the hotkey step survives, and so does any chord
  // that isn't the platform default. finalizeOnboarding re-registers whatever this
  // returns, so substituting here would erase it. parseOnboardingSession infers
  // `confirmed` for sessions written before the flag existed.
  assert.equal(onMac("Control+Shift+D", false), "Control+Shift+D");
  assert.equal(onMac("Control+Shift+D", true), "Control+Shift+D");
  assert.equal(onMac("GLOBE", true), "GLOBE");
});

test("the assistant step keeps a saved chord and otherwise offers the opt-in default", async () => {
  const { getRecommendedAssistantHotkeys, resolveOnboardingAssistantHotkey } = await load();

  // voiceAgentKey is opt-in with no platform default, so anything saved is the
  // user's own pick and nothing may substitute for it.
  assert.equal(resolveOnboardingAssistantHotkey("Control+Shift+K", "darwin"), "Control+Shift+K");
  for (const platform of ["darwin", "win32", "linux"]) {
    assert.equal(
      resolveOnboardingAssistantHotkey("", platform),
      getRecommendedAssistantHotkeys(platform)[0]
    );
  }
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

test("keys held as a chord drop their side, matching how the chord is saved", async () => {
  const { getHotkeyKeycaps } = await load();

  const held = getHotkeyKeycaps("LeftControl+LeftShift").map(({ label }) => label);
  assert.deepEqual(held, ["control", "shift"]);
  // A lone side key keeps it: Right Option is a different pick from Option.
  assert.match(getHotkeyKeycaps("RightOption")[0].label, /^right /);
});

test("F-keys and digits show their name once", async () => {
  const { getHotkeyKeycaps } = await load();

  assert.deepEqual(
    getHotkeyKeycaps("Control+F5").map(({ symbol, label }) => [symbol, label]),
    [
      ["⌃", "control"],
      ["F5", ""],
    ]
  );
  assert.deepEqual(getHotkeyKeycaps("Alt+1").at(-1), { id: "1-1", label: "", symbol: "1" });
});

test("a mouse binding gets a glyph instead of printing its label into the symbol slot", async () => {
  const { getHotkeyKeycaps } = await load();

  assert.deepEqual(getHotkeyKeycaps("MouseButton4"), [
    { id: "Mouse Button 4-0", label: "mouse 4", symbol: "\u21f1" },
  ]);
});
