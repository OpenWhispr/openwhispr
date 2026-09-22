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
  const { formatRecommendedHotkey, getRecommendedDictationHotkeys } = await load();

  assert.deepEqual(
    getRecommendedDictationHotkeys("darwin", "Command+K").map(formatRecommendedHotkey),
    ["Right Option", "Globe/Fn", "Ctrl + R"]
  );
  assert.deepEqual(getRecommendedDictationHotkeys("linux", "Control+Super"), ["Control+Super"]);
  // Right Ctrl leads on Windows: right Alt is AltGr on many layouts.
  assert.deepEqual(getRecommendedDictationHotkeys("win32", "Control+Shift+Space"), [
    "RightControl",
    "Control+Shift+Space",
  ]);
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

test("the assistant step keeps a saved chord and otherwise offers onboarding's Voice Agent preset", async () => {
  const {
    getDefaultAssistantOnboardingHotkey,
    resolveOnboardingAssistantHotkey,
    formatRecommendedHotkey,
  } = await load();

  // The preset is onboarding's to own: nothing in main or Settings registers a
  // Voice Agent chord, so this module is the only place it is ever applied.
  // Windows takes Win+Alt+Space from the researched candidate table; macOS and
  // Linux keep the long-standing suggestion.
  assert.equal(getDefaultAssistantOnboardingHotkey("win32"), "Alt+Super+Space");
  assert.equal(getDefaultAssistantOnboardingHotkey("darwin"), "CommandOrControl+Shift+Space");
  assert.equal(getDefaultAssistantOnboardingHotkey("linux"), "CommandOrControl+Shift+Space");

  for (const platform of ["darwin", "win32", "linux"]) {
    const preset = getDefaultAssistantOnboardingHotkey(platform);
    // Nothing auto-registers voiceAgentKey, so anything saved is the user's own
    // pick and nothing may substitute for it.
    assert.equal(resolveOnboardingAssistantHotkey(platform, "Alt+Space"), "Alt+Space", platform);
    assert.equal(resolveOnboardingAssistantHotkey(platform, preset), preset, platform);
    // An empty slot opens on the preset.
    assert.equal(resolveOnboardingAssistantHotkey(platform, ""), preset, platform);
  }

  // The label follows the platform's modifier names.
  const withPlatform = (platform, run) => {
    const had = "window" in globalThis;
    const previous = globalThis.window;
    globalThis.window = { electronAPI: { getPlatform: () => platform } };
    try {
      return run();
    } finally {
      if (had) globalThis.window = previous;
      else delete globalThis.window;
    }
  };
  withPlatform("darwin", () =>
    assert.equal(
      formatRecommendedHotkey(getDefaultAssistantOnboardingHotkey("darwin")),
      "Cmd + Shift + Space"
    )
  );
  withPlatform("win32", () =>
    assert.equal(
      formatRecommendedHotkey(getDefaultAssistantOnboardingHotkey("win32")),
      "Alt + Win + Space"
    )
  );
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

test("onboarding defaults a fresh slot to Hold only after capability is known", async () => {
  const { resolveOnboardingActivationMode } = await load();

  assert.equal(
    resolveOnboardingActivationMode({
      currentMode: "tap",
      storedMode: null,
      loaded: false,
      supportsPushToTalk: true,
    }),
    "tap"
  );
  assert.equal(
    resolveOnboardingActivationMode({
      currentMode: "tap",
      storedMode: null,
      loaded: true,
      supportsPushToTalk: true,
    }),
    "push"
  );
});

test("onboarding preserves a saved mode but demotes Hold when this machine cannot deliver it", async () => {
  const { resolveOnboardingActivationMode } = await load();

  assert.equal(
    resolveOnboardingActivationMode({
      currentMode: "tap",
      storedMode: "tap",
      loaded: true,
      supportsPushToTalk: true,
    }),
    "tap"
  );
  assert.equal(
    resolveOnboardingActivationMode({
      currentMode: "push",
      storedMode: "push",
      loaded: true,
      supportsPushToTalk: false,
    }),
    "tap"
  );
});

test("Hold demos for every slot teach the same hands-free gesture", async () => {
  const { getOnboardingDemoDescriptionKeys } = await load();

  for (const tapDescriptionKey of [
    "onboarding.rehaul.dictationDemo.description",
    "onboarding.rehaul.assistantDemo.scenarios.general.description",
  ]) {
    assert.deepEqual(getOnboardingDemoDescriptionKeys({ mode: "push", tapDescriptionKey }), [
      "onboarding.activation.holdHotkey",
      "app.holdMigrationCard.gesture",
    ]);
  }
  assert.deepEqual(
    getOnboardingDemoDescriptionKeys({
      mode: "tap",
      tapDescriptionKey: "onboarding.rehaul.assistantDemo.scenarios.general.description",
    }),
    ["onboarding.rehaul.assistantDemo.scenarios.general.description"]
  );
});
