// Shared loader for suites that exercise src/helpers/audioManager.js through
// the Vite SSR harness. audioManager pulls in the whole renderer graph, so
// every suite needs the same store/service stubs; this module owns that mock
// set (the superset every consumer needs) and lets a suite override any entry
// via `mockModules`.
//
// `settingsKey` names the globalThis slot the suite swaps its settings
// through — a unique key per suite keeps the per-test module caches isolated.
const { createRendererServer, installBrowserGlobals } = require("../../lib/rendererTestHarness");

const defaultMockModules = (settingsKey) => ({
  "/utils/logger":
    "export default { debug() {}, info() {}, warn() {}, error() {}, logReasoning() {} };",
  "/stores/settingsStore": `
    export const getSettings = () => globalThis.${settingsKey};
    export const getEffectiveCleanupModel = () => null;
    export const selectResolvedLLMConfig = () => ({ model: null, provider: null });
    export const isCloudCleanupMode = () => false;
    export const isCloudDictationAgentMode = () => false;
    export const isCloudTranslationMode = () => false;
  `,
  "/services/ReasoningService":
    "export default class ReasoningService { static cancelAllRequests() {} }",
  "/services/SyncService.js": "export const syncService = {};",
  "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
  "/utils/permissions": "export const isAccessibilitySkipped = () => false;",
});

async function loadAudioManager(t, { cachePrefix, settingsKey, settings, mockModules = {} } = {}) {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix,
    mockModules: { ...defaultMockModules(settingsKey), ...mockModules },
  });
  t.after(() => {
    delete globalThis[settingsKey];
  });
  globalThis[settingsKey] = settings ?? {};

  const AudioManager = (await vite.ssrLoadModule("/helpers/audioManager.js")).default;
  return {
    window,
    vite,
    AudioManager,
    setSettings: (next) => {
      globalThis[settingsKey] = next;
    },
    // Prototype-only instance: the constructor wires up media devices the
    // tests don't need.
    createManager: (overrides = {}) =>
      Object.assign(Object.create(AudioManager.prototype), overrides),
  };
}

module.exports = { loadAudioManager };
