const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const MANAGER_SOURCE = `
export default class AudioManager {
  constructor() { return globalThis.__streamingStopManager; }
}
`;

for (const phase of [
  "streaming",
  "before manager startup",
  "visual frames",
  "batch",
  "batch visual frames",
]) {
  test(`Stop while the hook start lock is held (${phase})`, async (t) => {
    const isBatch = phase.startsWith("batch");
    const holdsFrames = phase.endsWith("visual frames");
    let root;
    t.after(async () => {
      if (root) await React.act(async () => root.unmount());
      delete globalThis.__streamingStopManager;
    });
    const noopDispose = () => () => {};
    const targetGate = Promise.withResolvers();
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
          captureDictationTarget: () =>
            phase === "before manager startup" || holdsFrames ? targetGate.promise : undefined,
        },
      },
    });
    const container = installHookDom(t);
    const pendingFrames = [];
    globalThis.requestAnimationFrame = (callback) => {
      if (holdsFrames) pendingFrames.push(callback);
      else callback();
      return 1;
    };
    const gate = Promise.withResolvers();
    let prepareCalls = 0;
    let startCalls = 0;
    let stopCalls = 0;
    let state = {};
    const manager = {
      sttConfig: {},
      getState: () => state,
      setCallbacks(callbacks) {
        this.callbacks = callbacks;
      },
      setVoiceAgentRequested() {},
      setAssistantSelectionContext() {},
      setTranslationRequested() {},
      shouldUseStreaming: () => !isBatch,
      isSttConfigStale: () => false,
      getRecordingAudioLevel: () => 0,
      cleanup() {},
      cancelPreparedMicCapture() {},
      prepareMicCapture() {
        prepareCalls++;
      },
      async startStreamingRecording() {
        startCalls++;
        state = { isStreaming: true, isStreamingStartInProgress: true };
        await gate.promise;
        state = stopCalls ? {} : { isRecording: true, isStreaming: true };
        this.callbacks.onStateChange(state);
        return true;
      },
      async stopStreamingRecording() {
        stopCalls++;
        return true;
      },
      async startRecording() {
        startCalls++;
        await gate.promise;
        state = { isRecording: true };
        this.callbacks.onStateChange(state);
        return true;
      },
      stopRecording() {
        stopCalls++;
        state = {};
        this.callbacks.onStateChange(state);
        return true;
      },
    };
    globalThis.__streamingStopManager = manager;
    const vite = await createRendererServer(t, {
      cachePrefix: "openwhispr-hook-streaming-stop-",
      noExternal: ["react-i18next"],
      mockModules: {
        "/helpers/audioManager": MANAGER_SOURCE,
        "/stores/settingsStore": "export const getSettings = () => ({});",
        "/stores/policyStore":
          "export const usePolicyStore = { getState: () => ({ status: 'unmanaged' }), subscribe: () => () => {} };",
        "/utils/logger": "export default { info() {}, warn() {}, debug() {}, error() {} };",
        "react-i18next": "const t = (key) => key; export const useTranslation = () => ({ t });",
      },
    });
    const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");
    let api;
    const toast = () => {};
    function Harness() {
      api = useAudioRecording(toast);
      return null;
    }
    root = createRoot(container);
    await React.act(async () => root.render(React.createElement(Harness)));
    if (holdsFrames) t.mock.timers.enable({ apis: ["setTimeout"] });
    let started;
    await React.act(async () => {
      started = api.startRecording();
      await new Promise(setImmediate);
    });
    const callsBeforeStop = startCalls;
    await React.act(async () => {
      void api.stopRecording();
      void api.stopRecording();
      await new Promise(setImmediate);
    });
    const stopsBeforeReadiness = stopCalls;
    await React.act(async () => {
      while (pendingFrames.length) pendingFrames.shift()();
      await new Promise(setImmediate);
    });
    if (holdsFrames && !isBatch) {
      assert.equal(
        prepareCalls,
        0,
        "a completed visual wait must not open the microphone after Stop"
      );
      assert.equal(startCalls, 0);
    }
    await React.act(async () => {
      targetGate.resolve();
      gate.resolve();
      await started;
    });
    assert.equal(callsBeforeStop, phase === "before manager startup" || holdsFrames ? 0 : 1);
    assert.equal(
      stopsBeforeReadiness,
      phase === "streaming" ? 1 : 0,
      "an active streaming startup must receive Stop without waiting for readiness"
    );
    assert.equal(
      stopCalls,
      phase === "before manager startup" || (holdsFrames && !isBatch) ? 0 : 1,
      "a deferred Stop must finalize exactly once"
    );
    if (phase === "before manager startup" || (holdsFrames && !isBatch)) {
      assert.equal(startCalls, 0, "Stop during preparation must not later begin streaming capture");
      assert.equal(api.isPreparing, false);
      assert.equal(api.isStopping, false);
    }
  });
}
