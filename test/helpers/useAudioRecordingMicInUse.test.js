const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// On Windows, the "Microphone In Use" pill offers the Sound dialog's Recording
// tab, where the exclusive-mode checkbox that releases the mic lives (#1138).

const FAKE_AUDIO_MANAGER_SOURCE = `
export default class FakeAudioManager {
  constructor() {
    this.voiceAgentRequested = false;
    this.translationRequested = false;
    this.sttConfig = {};
    globalThis.__micInUseManager = this;
  }
  getState() { return {}; }
  setCallbacks(callbacks) { this.callbacks = callbacks; }
  shouldUseStreaming() { return false; }
  isSttConfigStale() { return false; }
  cleanup() {}
}
`;

const NOOP = () => {};
const SOUND_SETTINGS = "hooks.audioRecording.errorActions.openSoundSettings";

async function micInUsePill(t, platform) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__micInUseManager;
    delete globalThis.__micInUsePlatform;
  });
  const toasts = [];
  let settingsOpened = 0;
  const noopDispose = () => () => {};
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        onToggleDictation: noopDispose,
        onToggleVoiceAgent: noopDispose,
        onToggleTranslation: noopDispose,
        onStartDictation: noopDispose,
        onPrepareDictation: noopDispose,
        onCancelDictationPreparation: noopDispose,
        onStopDictation: noopDispose,
        dictationLifecycleStateChanged: NOOP,
        hideDictationPreview: NOOP,
        openRecordingDevicesSettings: async () => {
          settingsOpened += 1;
          return { success: true };
        },
      },
    },
  });
  const container = installHookDom(t);
  globalThis.__micInUsePlatform = platform;
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-mic-in-use-pill-",
    noExternal: ["react-i18next"],
    mockModules: {
      "/helpers/audioManager": FAKE_AUDIO_MANAGER_SOURCE,
      "/utils/platform": "export const getCachedPlatform = () => globalThis.__micInUsePlatform;",
      "/stores/settingsStore":
        "export const getSettings = () => ({ pauseMediaOnDictation: false });",
      "/utils/logger":
        "const noop = () => {}; export default { debug: noop, info: noop, warn: noop, error: noop, logReasoning: noop };",
      "react-i18next": "export const useTranslation = () => ({ t: (key) => key });",
    },
  });
  const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");

  const pushToast = (entry) => toasts.push(entry);
  function Harness() {
    useAudioRecording(pushToast, { onDemoEvent: NOOP });
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));

  await React.act(async () =>
    globalThis.__micInUseManager.callbacks.onError({
      code: "MIC_IN_USE",
      title: "Microphone In Use",
      messageKey:
        platform === "win32"
          ? "hooks.audioRecording.errorDescriptions.micInUseWindows"
          : "hooks.audioRecording.errorDescriptions.micInUse",
    })
  );
  const pill = toasts.find((entry) => entry.presentation === "dictation-error");
  assert.ok(pill, "the error reaches the dictation pill");
  return { pill, settingsOpened: () => settingsOpened };
}

test("on Windows the pill opens the Recording tab from a Sound settings button", async (t) => {
  const { pill, settingsOpened } = await micInUsePill(t, "win32");

  assert.equal(pill.title, "hooks.audioRecording.errorTitles.micInUse");
  assert.equal(pill.description, "hooks.audioRecording.errorDescriptions.micInUseWindows");
  assert.deepEqual(
    pill.actions.map((action) => action.label),
    ["common.retry", SOUND_SETTINGS]
  );
  const soundSettings = pill.actions.find((action) => action.label === SOUND_SETTINGS);
  assert.equal(soundSettings.dismissOnClick, false, "opening the dialog leaves the pill up");
  assert.equal(pill.duration, 15000, "the steps stay readable while the user follows them");
  await soundSettings.onClick();
  assert.equal(settingsOpened(), 1);
});

test("on macOS and Linux the pill keeps Retry alone", async (t) => {
  for (const platform of ["darwin", "linux"]) {
    await t.test(platform, async (t) => {
      const { pill } = await micInUsePill(t, platform);
      assert.deepEqual(
        pill.actions.map((action) => action.label),
        ["common.retry"]
      );
      assert.equal(pill.duration, undefined, "the usual timer");
    });
  }
});
