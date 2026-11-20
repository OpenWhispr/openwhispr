const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// The STT config lives in the AudioManager for the life of the window; without
// a refresh, a server-side rollout change (Orukeet switched on, or rolled
// back) never reaches a long-running app.
const FAKE_AUDIO_MANAGER_SOURCE = `
export default class FakeAudioManager {
  constructor() {
    this.voiceAgentRequested = false;
    this.translationRequested = false;
    this.sttConfig = null;
    globalThis.__sttRefreshManager = this;
  }
  setCallbacks(callbacks) { this.callbacks = callbacks; }
  getState() { return { isRecording: false, isProcessing: false, isStreaming: false }; }
  isSttConfigStale() { return globalThis.__sttRefreshStale; }
  setSttConfig(config) { this.sttConfig = config; }
  shouldUseStreaming() { return false; }
  prepareMicCapture() {}
  setVoiceAgentRequested() {}
  setTranslationRequested() {}
  async startRecording() { globalThis.__sttRefreshStarts.push(globalThis.__sttRefreshFetches); return true; }
  cleanup() {}
}
`;

test("a recording start refreshes a stale STT config in the background", async (t) => {
  let root = null;
  let start = null;
  globalThis.__sttRefreshFetches = 0;
  globalThis.__sttRefreshStarts = [];
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__sttRefreshManager;
    delete globalThis.__sttRefreshStale;
    delete globalThis.__sttRefreshFetches;
    delete globalThis.__sttRefreshStarts;
  });

  const noopDispose = () => () => {};
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        onToggleDictation: noopDispose,
        onToggleVoiceAgent: noopDispose,
        onToggleTranslation: noopDispose,
        // The start handler skips toggle semantics, so the hook's own
        // recording state from the previous start does not turn it into a stop.
        onStartDictation: (handler) => {
          start = handler;
          return () => {};
        },
        onPrepareDictation: noopDispose,
        onCancelDictationPreparation: noopDispose,
        onStopDictation: noopDispose,
        getSttConfig: async () => {
          globalThis.__sttRefreshFetches += 1;
          return {
            success: true,
            dictation: { mode: "batch" },
            fetch: globalThis.__sttRefreshFetches,
          };
        },
        captureDictationTarget: async () => {},
        completeDictationPreview: async () => {},
        hideDictationPreview: async () => {},
        dictationLifecycleStateChanged: async () => true,
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-stt-config-refresh-hook-",
    mockModules: {
      "/helpers/audioManager": FAKE_AUDIO_MANAGER_SOURCE,
      "/utils/logger": "export default { debug() {}, info() {}, warn() {}, error() {} };",
    },
  });
  const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");

  function Harness() {
    useAudioRecording(() => {}, { onDemoEvent: () => {} });
    return null;
  }

  globalThis.__sttRefreshStale = true;
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  // The hook re-creates its AudioManager when its effect re-runs, so the fake
  // records starts on globalThis and the config is read from the live instance.
  const manager = () => globalThis.__sttRefreshManager;
  assert.ok(manager().sttConfig, "the mount fetch populated the config");

  // The hook's mount effect can re-run on later renders, so the assertions
  // below count fetches issued on the start path itself: before startRecording.
  const startRecording = async () => {
    const fetchesBefore = globalThis.__sttRefreshFetches;
    await React.act(async () => {
      start();
      // Two bounded visual-frame waits precede the mic open in the start path.
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    return globalThis.__sttRefreshStarts.at(-1) - fetchesBefore;
  };

  // A fresh config is not refetched on every hotkey press.
  globalThis.__sttRefreshStale = false;
  assert.equal(await startRecording(), 0);

  // A stale one is refreshed in the background, and the recording still starts.
  globalThis.__sttRefreshStale = true;
  const configBefore = manager().sttConfig;
  assert.equal(await startRecording(), 1);
  assert.equal(globalThis.__sttRefreshStarts.length, 2);
  assert.notEqual(manager().sttConfig, configBefore);
});

// An account change refetches the config, drops a late answer and warms only when idle.
const ACCOUNT_SWITCH_MANAGER_SOURCE = `
export default class FakeAudioManager {
  constructor() {
    this.voiceAgentRequested = false;
    this.translationRequested = false;
    this.sttConfig = null;
    this.sttConfigGeneration = 0;
    globalThis.__sttSwitchManager = this;
  }
  setCallbacks(callbacks) { this.callbacks = callbacks; }
  getState() {
    const recording = Boolean(globalThis.__sttSwitchRecording);
    return { isRecording: recording, isProcessing: false, isStreaming: recording };
  }
  isSttConfigStale() { return true; }
  setSttConfig(config) { this.sttConfig = config; }
  invalidateSttConfig() { this.sttConfig = null; this.sttConfigGeneration += 1; }
  shouldUseStreaming() { return true; }
  warmupStreamingConnection(options) { globalThis.__sttSwitchWarms.push(options); }
  prepareMicCapture() {}
  setVoiceAgentRequested() {}
  setTranslationRequested() {}
  async startStreamingRecording() { globalThis.__sttSwitchRecording = true; return true; }
  cleanup() {}
}
`;

test("an account change replaces the STT config and drops the old account's late answer", async (t) => {
  let root = null;
  let start = null;
  let broadcastScope = null;
  let targetHold = null;
  const fetches = [];
  globalThis.__sttSwitchManager = null;
  globalThis.__sttSwitchRecording = false;
  globalThis.__sttSwitchWarms = [];
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__sttSwitchManager;
    delete globalThis.__sttSwitchRecording;
    delete globalThis.__sttSwitchWarms;
  });

  const noopDispose = () => () => {};
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        onToggleDictation: noopDispose,
        onToggleVoiceAgent: noopDispose,
        onToggleTranslation: noopDispose,
        onStartDictation: (handler) => {
          start = handler;
          return () => {};
        },
        onPrepareDictation: noopDispose,
        onCancelDictationPreparation: noopDispose,
        onStopDictation: noopDispose,
        getActiveAccountScope: async () => ({ accountId: "account-a", authGeneration: 1 }),
        onActiveAccountScopeChanged: (handler) => {
          broadcastScope = handler;
          return () => {};
        },
        // Each fetch waits until the test answers it, so answers can arrive out of order.
        getSttConfig: () =>
          new Promise((resolve) => {
            fetches.push((account) => resolve({ success: true, account }));
          }),
        captureDictationTarget: () => targetHold,
        completeDictationPreview: async () => {},
        hideDictationPreview: async () => {},
        dictationLifecycleStateChanged: async () => true,
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-stt-config-account-switch-",
    mockModules: {
      "/helpers/audioManager": ACCOUNT_SWITCH_MANAGER_SOURCE,
      "/utils/logger": "export default { debug() {}, info() {}, warn() {}, error() {} };",
    },
  });
  const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");

  const toast = () => {};
  const options = { onDemoEvent: () => {} };
  function Harness() {
    useAudioRecording(toast, options);
    return null;
  }

  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  const manager = () => globalThis.__sttSwitchManager;
  const answer = async (index, account) => {
    await React.act(async () => {
      fetches[index](account);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  await answer(fetches.length - 1, "account-a");
  assert.equal(manager().sttConfig?.account, "account-a");

  // A recording start leaves a background refresh pending for account A.
  await React.act(async () => {
    start();
    await new Promise((resolve) => setTimeout(resolve, 700));
  });
  const pendingForA = fetches.length - 1;

  assert.equal(typeof broadcastScope, "function", "the hook listens for account changes");
  const fetchesBeforeSwitch = fetches.length;
  const warmsBeforeSwitch = globalThis.__sttSwitchWarms.length;
  await React.act(async () => {
    broadcastScope({ accountId: "account-b", authGeneration: 2 });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(manager().sttConfig, null, "the previous account's config is cleared at once");
  assert.equal(fetches.length, fetchesBeforeSwitch + 1, "the new account's config is fetched");

  await answer(fetches.length - 1, "account-b");
  await answer(pendingForA, "account-a");
  assert.equal(manager().sttConfig?.account, "account-b");
  assert.equal(
    globalThis.__sttSwitchWarms.length,
    warmsBeforeSwitch,
    "a switch during a recording leaves its stream alone"
  );

  // Once idle, a switch warms the stream for the new account without opening the mic.
  globalThis.__sttSwitchRecording = false;
  await React.act(async () => {
    broadcastScope({ accountId: "account-c", authGeneration: 3 });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await answer(fetches.length - 1, "account-c");
  assert.deepEqual(globalThis.__sttSwitchWarms.slice(warmsBeforeSwitch), [{ warmMic: false }]);

  // A start still in its preamble reads idle to the manager, but the stream is the start's to dial.
  targetHold = new Promise(() => {});
  await React.act(async () => {
    start();
    await new Promise((resolve) => setTimeout(resolve, 700));
    broadcastScope({ accountId: "account-d", authGeneration: 4 });
  });
  await answer(fetches.length - 1, "account-d");
  assert.equal(globalThis.__sttSwitchWarms.length, warmsBeforeSwitch + 1);
});
