const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { act, createElement } = require("react");
const { createRoot } = require("react-dom/client");
const en = require("../../src/locales/en/translation.json");
const {
  SIGNED_OUT_AUTH_MOCK,
  createRendererServer,
  installHappyDom,
} = require("../lib/rendererTestHarness");

test("the floating pill announces dictation activity in one persistent live region", async (t) => {
  const window = await installHappyDom(t);
  window.electronAPI = {};
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-dictation-announcement-test-",
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
    mockModules: {
      ...SIGNED_OUT_AUTH_MOCK,
      "/components/ui/useToast": `
        const noop = () => {};
        export const useToast = () => ({
          toast: noop,
          dismiss: noop,
          dismissByPresentation: noop,
          toastCount: 0,
          dictationErrorActionCount: 0,
        });
      `,
      "/hooks/useAudioRecording": `
        const noop = () => {};
        export const useAudioRecording = () => ({
          getAudioLevel: () => 0,
          toggleListening: noop,
          cancelRecording: noop,
          cancelProcessing: noop,
          ...window.dictationTestState,
        });
      `,
    },
  });
  const { default: App } = await vite.ssrLoadModule("/App.jsx");
  const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");
  await i18n.changeLanguage("en");
  const { default: reasoning } = await vite.ssrLoadModule("/services/ReasoningService.ts");
  t.after(() => reasoning.destroy());
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  const renderDictation = (state) =>
    act(() => {
      window.dictationTestState = state;
      root.render(createElement(App));
    });
  const liveRegion = () => container.querySelector('[aria-live="polite"][aria-atomic="true"]');

  try {
    await renderDictation({});
    const announcement = liveRegion();
    assert.ok(announcement, "The live region is present before dictation starts");
    assert.equal(announcement.textContent, "");

    for (const [state, message] of [
      [{ isRecording: true }, en.app.mic.recording],
      [{ isRecording: true, micCaptureStatus: "reconnecting" }, en.app.mic.waitingForMicrophone],
      [{ isStopping: true }, en.agentMode.input.transcribing],
      [{ isProcessing: true }, en.agentMode.input.transcribing],
      [{ isProcessing: true, isAssistantVoice: true }, en.agentMode.input.thinking],
      [{}, ""],
    ]) {
      await renderDictation(state);
      assert.equal(liveRegion(), announcement);
      assert.equal(announcement.textContent, message);
      assert.equal(announcement.closest('[aria-hidden="true"]'), null);
    }
  } finally {
    await act(() => root.unmount());
  }
});
