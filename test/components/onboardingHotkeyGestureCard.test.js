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

test("uses the Linux setup notice when Hold is unavailable", async (t) => {
  const markup = await render(t, {
    confirmed: true,
    mode: "tap",
    platform: "linux",
    supportsPushToTalk: false,
  });

  assert.match(markup, /settingsPage\.general\.hotkey\.linuxPttSetupTitle/);
  assert.match(markup, /sudo usermod -aG input \$USER/);
  assert.doesNotMatch(markup, /gestures\.holdTitle/);
  assert.doesNotMatch(markup, /gestures\.handsFreeTitle/);
});

test("the Voice Agent card uses its three-key shortcut in both gesture rows", async (t) => {
  const markup = await render(t, {
    confirmed: true,
    slot: "voiceAgent",
    hotkey: "Command+Shift+Space",
  });

  assert.match(markup, /settingsPage\.general\.hotkey\.gestures\.holdTitle/);
  assert.equal((markup.match(/<kbd/g) || []).length, 6);
});

test("shortcut keycaps keep their physical order inside Arabic RTL", async (t) => {
  const markup = await render(t, {
    confirmed: true,
    slot: "voiceAgent",
    hotkey: "Command+Shift+Space",
  });

  assert.match(markup, /<span[^>]*dir="ltr"[^>]*class="whitespace-nowrap"/);
  assert.doesNotMatch(markup, /\b(?:ml|mr|pl|pr)-/);
});
