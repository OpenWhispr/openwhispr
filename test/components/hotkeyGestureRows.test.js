const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Static render: effects never run, so useHotkeyModeInfo reports its defaults
// (Hold supported, no reason). The rows are driven by the slot's effective
// mode, which the store already carries; the hook only supplies the reason.
// `reason` stands in for what main actually answered: pass a string to mock
// the hook into reporting one, leave it out for the real hook's default (no
// reason, because main believes Hold is supported).
async function render(t, props, { reason } = {}) {
  installBrowserGlobals(t, { window: { electronAPI: {} } });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-hotkey-gesture-rows-test-",
    mockModules:
      reason === undefined
        ? {}
        : {
            "/hooks/useHotkeyModeInfo": `
              export function useHotkeyModeInfo() {
                return {
                  isUsingNativeShortcut: true,
                  isUsingHyprland: false,
                  supportsPushToTalk: false,
                  pushToTalkUnavailableReason: ${JSON.stringify(reason)},
                  hyprlandConfigStatus: null,
                };
              }
            `,
          },
  });
  const mod = await vite.ssrLoadModule("/components/ui/HotkeyGestureRows.tsx");
  return renderToStaticMarkup(
    createElement(mod.HotkeyGestureRows, { slot: "dictation", hotkey: "Control+`", ...props })
  );
}

test("a Hold slot shows the hold row and the hands-free row with the slot's keycaps", async (t) => {
  const markup = await render(t, { mode: "push" });

  assert.match(markup, /settingsPage\.general\.hotkey\.gestures\.holdTitle/);
  assert.match(markup, /settingsPage\.general\.hotkey\.gestures\.holdDetail/);
  assert.match(markup, /settingsPage\.general\.hotkey\.gestures\.handsFreeTitle/);
  assert.match(markup, /settingsPage\.general\.hotkey\.gestures\.handsFreeDetail/);
  assert.match(markup, /common\.hold/);
  assert.match(markup, /settingsPage\.general\.hotkey\.gestures\.doublePress/);
  // Two rows × two keycaps (Control, `).
  assert.equal((markup.match(/<kbd/g) || []).length, 4);
  assert.doesNotMatch(markup, /tapOnlyTitle/);
});

test("a Tap slot with no reason from main shows the row and asserts no cause", async (t) => {
  const markup = await render(t, { mode: "tap" });

  assert.match(markup, /settingsPage\.general\.hotkey\.gestures\.tapOnlyTitle/);
  assert.doesNotMatch(markup, /gestures\.holdTitle/);
  assert.doesNotMatch(markup, /gestures\.handsFreeTitle/);
  // main returns a null reason precisely when it believes Hold IS supported
  // — a slot on Tap for some other cause (an onboarding choice, a Linux
  // evdev slot that lost its input permission). Blaming a missing native
  // listener there would be a specific, false claim, so say nothing.
  assert.doesNotMatch(markup, /windows\.pttUnavailable/);
  assert.equal((markup.match(/<kbd/g) || []).length, 2);
});

test("a Tap slot shows the reason main gave, when it gave one", async (t) => {
  const markup = await render(t, { mode: "tap" }, { reason: "Control+Super is reserved by the OS" });

  assert.match(markup, /settingsPage\.general\.hotkey\.gestures\.tapOnlyTitle/);
  assert.match(markup, /Control\+Super is reserved by the OS/);
});

test("only the first hotkey of a list is rendered as keycaps", async (t) => {
  const markup = await render(t, { mode: "push", hotkey: "F8,Control+Shift+Space" });
  assert.equal((markup.match(/<kbd/g) || []).length, 2);
});

test("no rows without a hotkey", async (t) => {
  const markup = await render(t, { mode: "push", hotkey: "" });
  assert.equal(markup, "");
});
