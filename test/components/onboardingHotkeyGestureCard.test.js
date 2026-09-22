const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function render(t, props) {
  installBrowserGlobals(t, { window: { electronAPI: {} } });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-onboarding-hotkey-gesture-card-test-",
  });
  const mod = await vite.ssrLoadModule("/components/onboarding/OnboardingHotkeyGestureCard.tsx");
  return renderToStaticMarkup(
    createElement(mod.default, {
      slot: "dictation",
      hotkey: "RightOption",
      mode: "push",
      platform: "darwin",
      supportsPushToTalk: true,
      isUsingNativeShortcut: false,
      ...props,
    })
  );
}

test("stays absent until the shortcut is confirmed", async (t) => {
  const markup = await render(t, { confirmed: false });

  assert.equal(markup, "");
});

test("reveals Hold and hands-free guidance after confirmation", async (t) => {
  const markup = await render(t, { confirmed: true });

  assert.match(markup, /onboarding-hotkey-gesture-card/);
  assert.match(markup, /onboarding-gesture-reveal/);
  assert.match(markup, /settingsPage\.general\.hotkey\.gestures\.holdTitle/);
  assert.match(markup, /settingsPage\.general\.hotkey\.gestures\.handsFreeTitle/);
  assert.doesNotMatch(markup, /onboarding\.rehaul\.dictationHotkey\.activation/);
});

test("a missing non-native Linux listener does not suggest permission repair", async (t) => {
  const markup = await render(t, {
    confirmed: true,
    mode: "tap",
    platform: "linux",
    supportsPushToTalk: false,
    isUsingNativeShortcut: false,
    linuxPttPermissionDenied: false,
    pushToTalkUnavailableReason: "Push-to-Talk native listener not available",
  });

  assert.match(markup, /Push-to-Talk native listener not available/);
  assert.doesNotMatch(markup, /linuxPttSetup|sudo usermod/);
  assert.match(markup, /gestures\.tapOnlyTitle/);
  assert.doesNotMatch(markup, /gestures\.holdTitle/);
  assert.doesNotMatch(markup, /gestures\.handsFreeTitle/);
});

for (const [backend, reason] of [
  ["GNOME without Hold support", "Hold is unavailable on this GNOME version"],
  ["native modifier restriction", "Control+Super is reserved by the OS"],
]) {
  test(`${backend} retains its reason and tap guidance without a setup command`, async (t) => {
    const markup = await render(t, {
      confirmed: true,
      platform: "linux",
      hotkey: "Control+Super",
      supportsPushToTalk: false,
      isUsingNativeShortcut: true,
      pushToTalkUnavailableReason: reason,
    });

    assert.ok(markup.includes(reason));
    assert.match(markup, /gestures\.tapOnlyTitle/);
    assert.doesNotMatch(markup, /gestures\.(holdTitle|handsFreeTitle)/);
    assert.doesNotMatch(markup, /linuxPttSetup|sudo usermod/);
  });
}

for (const isUsingNativeShortcut of [true, false]) {
  test(`supported ${isUsingNativeShortcut ? "native" : "non-native"} Linux retains Dictation gestures and animation`, async (t) => {
    const markup = await render(t, {
      confirmed: true,
      platform: "linux",
      supportsPushToTalk: true,
      isUsingNativeShortcut,
    });

    assert.match(markup, /data-hotkey-slot="dictation"/);
    assert.match(markup, /onboarding-gesture-reveal/);
    assert.match(markup, /gestures\.holdTitle/);
    assert.match(markup, /gestures\.handsFreeTitle/);
    assert.doesNotMatch(markup, /gestures\.tapOnlyTitle|linuxPttSetup|sudo usermod/);
  });
}

test("unsupported Hyprland Assistant retains only its reason", async (t) => {
  const reason = "Hold is unavailable for this shortcut on Hyprland";
  const markup = await render(t, {
    confirmed: true,
    slot: "voiceAgent",
    platform: "linux",
    hotkey: "Control+Super+Space",
    supportsPushToTalk: false,
    isUsingNativeShortcut: true,
    pushToTalkUnavailableReason: reason,
  });

  assert.match(markup, /role="status"/);
  assert.equal(markup.replace(/<[^>]*>/g, ""), reason);
  assert.doesNotMatch(markup, /onboarding-hotkey-gesture-card|onboarding-gesture-reveal/);
  assert.doesNotMatch(markup, /gestures\.|linuxPttSetup|sudo usermod/);
});

test("the Voice Agent shortcut does not repeat the Dictation gesture card", async (t) => {
  const markup = await render(t, {
    confirmed: true,
    slot: "voiceAgent",
    hotkey: "Command+Shift+Space",
  });

  assert.equal(markup, "");
});

test("shortcut keycaps keep their physical order inside Arabic RTL", async (t) => {
  const markup = await render(t, {
    confirmed: true,
    slot: "dictation",
    hotkey: "Command+Shift+Space",
  });

  assert.match(markup, /<span[^>]*dir="ltr"[^>]*class="whitespace-nowrap"/);
  assert.doesNotMatch(markup, /\b(?:ml|mr|pl|pr)-/);
});

test("confirmed non-native Linux denial shows repair and Tap even when the helper exists", async (t) => {
  const markup = await render(t, {
    confirmed: true,
    mode: "push",
    platform: "linux",
    supportsPushToTalk: true,
    isUsingNativeShortcut: false,
    linuxPttPermissionDenied: true,
  });
  assert.equal((markup.match(/sudo usermod/g) || []).length, 1);
  assert.match(markup, /gestures\.tapOnlyTitle/);
  assert.doesNotMatch(markup, /gestures\.(holdTitle|handsFreeTitle)/);
});
