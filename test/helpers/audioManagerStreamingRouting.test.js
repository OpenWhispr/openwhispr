const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function loadAudioManager(t) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-streaming-routing-test-",
    mockModules: {
      "/utils/logger":
        "export default { debug() {}, info() {}, warn() {}, error() {}, logReasoning() {} };",
      "/stores/settingsStore": `
        export const getSettings = () => globalThis.__streamingRoutingSettings;
        export const getEffectiveCleanupModel = () => null;
        export const isCloudCleanupMode = () => false;
        export const isCloudDictationAgentMode = () => false;
        export const isCloudTranslationMode = () => false;
      `,
      "/services/ReasoningService": "export default class ReasoningService {};",
      "/services/SyncService.js": "export const syncService = {};",
      "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
      "/utils/permissions": "export const isAccessibilitySkipped = () => false;",
    },
  });
  t.after(() => {
    delete globalThis.__streamingRoutingSettings;
  });
  const AudioManager = (await vite.ssrLoadModule("/helpers/audioManager.js")).default;
  return Object.create(AudioManager.prototype);
}

function setSettings(overrides = {}) {
  globalThis.__streamingRoutingSettings = {
    useLocalWhisper: false,
    transcriptionMode: "providers",
    remoteTranscriptionUrl: "",
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "openai",
    cloudTranscriptionModel: "gpt-4o-mini-transcribe",
    openaiApiKey: "sk-test",
    isSignedIn: true,
    ...overrides,
  };
}

test("managed batch config does not disable BYOK OpenAI realtime transcription", async (t) => {
  const manager = await loadAudioManager(t);
  manager.sttConfig = { dictation: { mode: "batch" } };
  setSettings();

  assert.equal(manager.shouldUseStreaming(), true);
});

test("OpenAI dictation realtime requests identify the token provider", async (t) => {
  const manager = await loadAudioManager(t);
  setSettings();
  const calls = [];
  globalThis.window.electronAPI.dictationRealtimeWarmup = async (options) => {
    calls.push(["warmup", options]);
    return { success: true };
  };
  globalThis.window.electronAPI.dictationRealtimeStart = async (options) => {
    calls.push(["start", options]);
    return { success: true };
  };

  const provider = manager.getStreamingProvider();
  const options = {
    model: "gpt-4o-mini-transcribe",
    mode: "byok",
  };
  await provider.warmup(options);
  await provider.start(options);

  assert.deepEqual(calls, [
    ["warmup", { ...options, provider: "openai-realtime" }],
    ["start", { ...options, provider: "openai-realtime" }],
  ]);
});

test("managed OpenWhispr Cloud still respects its batch configuration", async (t) => {
  const manager = await loadAudioManager(t);
  manager.sttConfig = { dictation: { mode: "batch" } };
  setSettings({
    transcriptionMode: "openwhispr",
    cloudTranscriptionMode: "openwhispr",
  });

  assert.equal(manager.shouldUseStreaming(), false);
});
