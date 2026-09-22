const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// The selection read used to be the last serial step before the model call. A
// voice-agent recording now starts it at press time, alongside the screenshot,
// so it resolves while the user is still speaking.
async function loadAudioManager(t, { cachePrefix, settingsKey }) {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix,
    mockModules: {
      "/utils/logger":
        "export default { debug() {}, info() {}, warn() {}, error() {}, logReasoning() {} };",
      "/stores/settingsStore": `
        export const getSettings = () => globalThis.${settingsKey};
        export const getEffectiveCleanupModel = () => null;
        export const isCloudCleanupMode = () => false;
        export const isCloudDictationAgentMode = () => false;
        export const isCloudTranslationMode = () => false;
      `,
      "/services/ReasoningService": 'export default { processText: async () => "" };',
      "/services/SyncService.js": "export const syncService = {};",
      "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
      "/utils/permissions": "export const isAccessibilitySkipped = () => false;",
    },
  });
  t.after(() => {
    delete globalThis[settingsKey];
  });
  globalThis[settingsKey] = {};

  const AudioManager = (await vite.ssrLoadModule("/helpers/audioManager.js")).default;
  return {
    window,
    createManager: (overrides = {}) =>
      Object.assign(Object.create(AudioManager.prototype), overrides),
  };
}

function countingCapture(window) {
  const calls = [];
  window.electronAPI.captureSelectedText = async (options) => {
    calls.push(options);
    return { status: "selected", text: "selected body", sessionId: `s${calls.length}` };
  };
  return calls;
}

test("a prefetched selection is reused instead of read again", async (t) => {
  const { window, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-sel-prefetch-test-",
    settingsKey: "__selPrefetchSettings",
  });
  const calls = countingCapture(window);
  const manager = createManager();

  manager.beginSelectionCapture();
  assert.equal(calls.length, 1, "the read starts without being awaited");

  const capture = await manager.consumeSelectionCapture();
  assert.equal(capture.sessionId, "s1");
  assert.equal(calls.length, 1, "consuming must reuse the prefetch");
});

test("the caret probe request mirrors the auto-paste setting", async (t) => {
  const { window, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-sel-probe-flag-test-",
    settingsKey: "__selProbeFlagSettings",
  });
  const calls = countingCapture(window);
  const manager = createManager();

  globalThis.__selProbeFlagSettings = { autoPasteEnabled: true };
  manager.beginSelectionCapture();
  await manager.consumeSelectionCapture();

  globalThis.__selProbeFlagSettings = { autoPasteEnabled: false };
  await manager.consumeSelectionCapture();

  assert.deepEqual(calls, [{ probeEditable: true }, { probeEditable: false }]);
});

test("consuming without a prefetch falls back to reading on demand", async (t) => {
  const { window, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-sel-ondemand-test-",
    settingsKey: "__selOnDemandSettings",
  });
  const calls = countingCapture(window);
  const manager = createManager();

  const capture = await manager.consumeSelectionCapture();
  assert.equal(capture.sessionId, "s1");
  assert.equal(calls.length, 1);
});

test("a prefetch is single-use", async (t) => {
  const { window, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-sel-singleuse-test-",
    settingsKey: "__selSingleUseSettings",
  });
  const calls = countingCapture(window);
  const manager = createManager();

  manager.beginSelectionCapture();
  await manager.consumeSelectionCapture();
  const second = await manager.consumeSelectionCapture();

  assert.equal(second.sessionId, "s2", "a second consume must read fresh");
  assert.equal(calls.length, 2);
});

// A capture must never outlive the recording that asked for it: a read from an
// earlier app would otherwise be edited in place by the next command.
test("starting a recording discards a capture left over from the previous one", async (t) => {
  const { window, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-sel-stale-test-",
    settingsKey: "__selStaleSettings",
  });
  const calls = countingCapture(window);
  const manager = createManager();

  manager.beginSelectionCapture();
  assert.equal(calls.length, 1);

  manager.setVoiceAgentRequested(true);
  assert.ok(!manager.selectionCapturePromise, "the stale prefetch must be dropped");

  const capture = await manager.consumeSelectionCapture();
  assert.equal(capture.sessionId, "s2");
  assert.equal(calls.length, 2);
});

test("an agent command consumes the prefetch rather than re-reading the selection", async (t) => {
  const { window, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-sel-command-test-",
    settingsKey: "__selCommandSettings",
  });
  const calls = countingCapture(window);
  const manager = createManager({ onError: () => {} });

  manager.beginSelectionCapture();
  // Selection editing needs a model round trip; stub it out and assert only that
  // the capture came from the prefetch.
  manager.processWithReasoningModel = async () => {
    throw new Error("model unavailable");
  };

  await assert.rejects(
    () =>
      manager.processAgentCommand("make it shorter", "gpt-5", "Agent", {
        selectionEditReachable: true,
      }),
    /Selection edit failed: model unavailable/
  );
  assert.equal(calls.length, 1, "the command must not read the selection a second time");
});

test("a rejected prefetch still surfaces its error to the awaiting command", async (t) => {
  const { window, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-sel-reject-test-",
    settingsKey: "__selRejectSettings",
  });
  window.electronAPI.captureSelectedText = async () => {
    throw new Error("ipc exploded");
  };
  const manager = createManager();

  manager.beginSelectionCapture();

  await assert.rejects(
    () => manager.processAgentCommand("make it shorter", "gpt-5", "Agent", {}),
    /Selection edit could not safely read the selection: ipc exploded/
  );
});
