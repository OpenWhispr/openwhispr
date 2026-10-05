const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const AUTO_HIDE_ON = `
  export const useSettingsStore = { getState: () => ({ floatingIconAutoHide: true }) };
`;

// Mount the real size owner with "Auto-hide when idle" enabled and an error
// card on screen, then dismiss the card the way Retry does.
async function mountWithErrorCard(t) {
  // Registered before the browser globals so React still has `window` when the
  // harness tears the root down.
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  const hideCalls = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        hideWindow: async () => {
          hideCalls.push("hide");
        },
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-dictation-error-auto-hide-",
    mockModules: { "stores/settingsStore": AUTO_HIDE_ON },
  });
  const { useMainWindowSizeOwner } = await vite.ssrLoadModule("/hooks/useMainWindowSizeOwner.js");

  const closed = { current: false };
  let props = {
    requestMainWindowSize: async () => ({ success: true }),
    dictationErrorActionCount: 1,
    toastCount: 0,
    isCommandMenuOpen: false,
    isCompactPill: false,
    isDictationActive: false,
    assistantOpen: false,
    assistantMounted: false,
    assistantOpenRef: closed,
    liveTranscriptOpen: false,
    liveTranscriptMounted: false,
    liveTranscriptOpenRef: closed,
  };
  let result;
  function Harness() {
    result = useMainWindowSizeOwner(props);
    return null;
  }

  root = createRoot(container);

  const render = async (next = {}) => {
    props = { ...props, ...next };
    await React.act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });
  };
  // The reveal waits on the native resize and then on compositor frames, both
  // bounded by VISUAL_FRAME_TIMEOUT_MS.
  const settle = async () => {
    await React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900));
    });
  };

  await render();
  return { hideCalls, render, settle, state: () => result };
}

test("Retry keeps the pill window on screen while the new dictation runs", async (t) => {
  const { hideCalls, render, settle, state } = await mountWithErrorCard(t);

  // Retry starts recording, and that start dismisses the error card (#2141).
  await render({ dictationErrorActionCount: 0, isDictationActive: true });
  await settle();

  assert.deepEqual(hideCalls, [], "auto-hide must not hide a window that is still recording");
  assert.equal(state().dictationErrorPillHandoffActive, false, "the pill must be revealed again");
});

test("an error card dismissed while idle still auto-hides the window", async (t) => {
  const { hideCalls, render, settle } = await mountWithErrorCard(t);

  await render({ dictationErrorActionCount: 0, isDictationActive: false });
  await settle();

  assert.deepEqual(hideCalls, ["hide"]);
});
