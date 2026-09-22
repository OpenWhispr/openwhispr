const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createInstance } = require("i18next");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const supportedInfo = {
  loaded: true,
  isUsingNativeShortcut: false,
  isUsingHyprland: false,
  supportsPushToTalk: true,
  linuxPttPermissionDenied: false,
  pushToTalkUnavailableReason: null,
  hyprlandConfigStatus: null,
};
const slot = (name, patch = {}) => ({
  name,
  hotkey: "Command+Shift+Space",
  mode: "push",
  info: { ...supportedInfo },
  pending: false,
  ...patch,
});
const standardSlots = () => [
  slot("dictation"),
  slot("voiceAgent"),
  slot("translation", { hotkey: "" }),
];

async function render(t, slots, { platform = "darwin", language = "en" } = {}) {
  const { I18nextProvider } = await import("react-i18next");
  const catalog = require(`../../src/locales/${language}/translation.json`);
  installBrowserGlobals(t);
  const i18n = createInstance();
  await i18n.init({
    lng: language,
    resources: { [language]: { translation: catalog } },
    interpolation: { escapeValue: false },
  });
  const vite = await createRendererServer(t);
  const { SettingsHotkeyGestureGuide, SettingsHotkeyException } = await vite.ssrLoadModule(
    "/components/settings/SettingsHotkeyGuidance.tsx"
  );
  return renderToStaticMarkup(
    React.createElement(
      I18nextProvider,
      { i18n },
      React.createElement(SettingsHotkeyGestureGuide, { slots, platform }),
      ...slots.map((item) =>
        React.createElement(SettingsHotkeyException, {
          key: item.name,
          slot: item,
          platform,
        })
      )
    )
  );
}

test("one guide names all three voice features, including unassigned Translation", async (t) => {
  const markup = await render(t, standardSlots());
  assert.match(markup, /For Dictation, Assistant and Translation\./);
  assert.equal((markup.match(/Hold to speak/g) || []).length, 1);
  assert.equal((markup.match(/Start hands-free/g) || []).length, 1);
  assert.equal((markup.match(/<aside/g) || []).length, 1);
  assert.doesNotMatch(markup, /<kbd|Press to start|Meeting/);
});

test("Hold is accented and both gesture chips are noninteractive", async (t) => {
  const markup = await render(t, standardSlots());
  const chips = markup.match(/<span[^>]+cursor-default[^>]*>/g) || [];
  assert.equal(chips.length, 2);
  assert.match(chips[0], /hands-free-tip-badge/);
  assert.doesNotMatch(chips[1], /hands-free-tip-badge/);
  assert.doesNotMatch(markup, /<button|tabindex|role="button"/i);
  assert.match(markup, /pointer-events-none/);
});

test("Hyprland keeps the guide scoped to Dictation and tap guidance beside each exception", async (t) => {
  const reason = "On Hyprland, Hold is only available for the dictation hotkey.";
  const native = { ...supportedInfo, isUsingNativeShortcut: true, isUsingHyprland: true };
  const slots = [
    slot("dictation", { info: native }),
    ...["voiceAgent", "translation"].map((name) =>
      slot(name, {
        mode: "tap",
        info: { ...native, supportsPushToTalk: false, pushToTalkUnavailableReason: reason },
      })
    ),
  ];
  const markup = await render(t, slots, { platform: "linux" });
  assert.match(markup, /For Dictation\./);
  assert.equal((markup.match(/Press to start, press again to stop/g) || []).length, 2);
  assert.equal((markup.match(/On Hyprland, Hold/g) || []).length, 2);
  assert.doesNotMatch(markup, /sudo usermod/);
});

test("policy-hidden Assistant is absent from the guide", async (t) => {
  const markup = await render(
    t,
    standardSlots().filter((s) => s.name !== "voiceAgent")
  );
  assert.match(markup, /For Dictation and Translation\./);
  assert.doesNotMatch(markup, /Assistant/);
});

for (const [name, patch] of [
  [
    "loading",
    { info: { ...supportedInfo, loaded: false, pushToTalkUnavailableReason: "Old key reason" } },
  ],
  ["saving", { pending: true }],
  ["all unassigned", { hotkey: "" }],
]) {
  test(`${name} never exposes optimistic or stale guidance`, async (t) => {
    assert.equal(
      await render(
        t,
        standardSlots().map((s) => ({ ...s, ...patch }))
      ),
      ""
    );
  });
}

test("an effective Tap mode is respected even when the backend can Hold", async (t) => {
  const markup = await render(t, [slot("dictation", { mode: "tap" })]);
  assert.doesNotMatch(markup, /<aside|Hold to speak|Start hands-free/);
  assert.match(markup, /Press to start, press again to stop/);
});

test("a missing non-native Linux helper shows unavailable guidance without permission repair", async (t) => {
  const reason = "Push-to-Talk native listener not available";
  const markup = await render(
    t,
    [
      slot("dictation", {
        info: { ...supportedInfo, supportsPushToTalk: false, pushToTalkUnavailableReason: reason },
      }),
    ],
    { platform: "linux" }
  );
  assert.match(markup, /Push-to-Talk native listener not available/);
  assert.match(markup, /Press to start, press again to stop/);
  assert.doesNotMatch(
    markup,
    /sudo usermod|Your user needs access|<aside|Hold to speak|Start hands-free/
  );
});

test("confirmed non-native Linux denial shows one Dictation repair and Tap guidance", async (t) => {
  const markup = await render(
    t,
    ["dictation", "voiceAgent", "translation"].map((name) =>
      slot(name, {
        info: { ...supportedInfo, linuxPttPermissionDenied: true },
      })
    ),
    { platform: "linux" }
  );
  assert.doesNotMatch(markup, /<aside|Hold to speak|Start hands-free/);
  assert.equal(
    (markup.match(/sudo usermod/g) || []).length,
    1,
    "one setup command under Dictation"
  );
  assert.equal((markup.match(/Press to start, press again to stop/g) || []).length, 3);
});

test("native GNOME limitations show their actual reason without an input-group repair", async (t) => {
  const reason = "Your desktop cannot report when a key is released.";
  const markup = await render(
    t,
    [
      slot("dictation", {
        info: {
          ...supportedInfo,
          isUsingNativeShortcut: true,
          supportsPushToTalk: false,
          pushToTalkUnavailableReason: reason,
        },
      }),
    ],
    { platform: "linux" }
  );
  assert.match(markup, /Your desktop cannot report when a key is released/);
  assert.doesNotMatch(markup, /sudo usermod|<aside/);
});

test("Arabic exception keycaps retain their physical left-to-right order", async (t) => {
  const markup = await render(t, [slot("dictation", { mode: "tap" })], { language: "ar" });
  assert.match(markup, /dir="ltr"/);
  assert.ok(markup.indexOf("Cmd") < markup.indexOf("Shift"));
  assert.ok(markup.indexOf("Shift") < markup.indexOf("Space"));
});
