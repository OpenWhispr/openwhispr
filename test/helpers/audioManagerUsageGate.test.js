const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// The streaming usage report carries `sendLogs` — the transcript text — so it
// may only fire for a session whose audio actually travelled through OpenWhispr
// Cloud. The gate in startStreamingRecording reads two things:
//
//   this.streamingSessionMetered =
//     !!provider.cloudMetered && sessionOptions.mode === "openwhispr";
//
// Both come from production code reached here: `provider` from the real
// STREAMING_PROVIDERS registry via getStreamingProvider(), and `mode` from the
// real buildStreamingSessionOptions(). Each case below drives the real
// resolveStreamingProviderName() from a settings state, so the table also pins
// which provider a given configuration streams through.
//
// What this cannot reach: the gate expression itself, and its one consumer
// (`if (!usedBatchFallback && this.streamingSessionMetered)`), both of which sit
// inside startStreamingRecording after the mic/worklet setup. This pins the
// inputs — a backend added without deciding, or a BYOK provider flipped to
// metered, fails here.

async function loadRoutingSurface(t) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-usage-gate-test-",
    mockModules: {
      "/utils/logger":
        "export default { debug() {}, info() {}, warn() {}, error() {}, logReasoning() {} };",
      // Settings are read through a global so one loaded module can serve every
      // case; the real getSettings() is what production calls here too.
      "/stores/settingsStore": `
        export const getSettings = () => globalThis.__owUsageGateSettings ?? {};
        export const getEffectiveCleanupModel = () => null;
        export const isCloudCleanupMode = () => false;
        export const isCloudDictationAgentMode = () => false;
        export const isCloudTranslationMode = () => false;
      `,
      "/services/ReasoningService": "export default { processText: async (t) => t };",
      "/services/SyncService.js": "export const syncService = {};",
      "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
      "/utils/permissions": "export const isAccessibilitySkipped = () => false;",
    },
  });

  const AudioManager = (await vite.ssrLoadModule("/helpers/audioManager.js")).default;
  const { buildStreamingSessionOptions } = await vite.ssrLoadModule(
    "/helpers/dictationStreamingRouting.js"
  );

  t.after(() => {
    delete globalThis.__owUsageGateSettings;
  });

  return { AudioManager, buildStreamingSessionOptions };
}

// Resolves a settings state the way startStreamingRecording does: real
// resolver, real registry, real options builder.
function resolveSession({ AudioManager, buildStreamingSessionOptions }, { settings, sttConfig }) {
  globalThis.__owUsageGateSettings = settings;

  const manager = Object.create(AudioManager.prototype);
  manager.context = "dictation";
  manager.sttConfig = sttConfig ?? null;

  const providerName = manager.getStreamingProviderName();
  return {
    providerName,
    provider: manager.getStreamingProvider(),
    options: buildStreamingSessionOptions({
      providerName,
      settings,
      language: "en",
      keyterms: [],
    }),
  };
}

const CASES = [
  {
    name: "OpenWhispr-managed realtime dictation",
    settings: {
      cloudTranscriptionModel: "gpt-4o-mini-transcribe",
      cloudTranscriptionMode: "openwhispr",
    },
    providerName: "openai-realtime",
    cloudMetered: true,
    mode: "openwhispr",
    reportsUsage: true,
  },
  {
    name: "the same provider on the user's own OpenAI key",
    settings: { cloudTranscriptionModel: "gpt-4o-mini-transcribe", cloudTranscriptionMode: "byok" },
    providerName: "openai-realtime",
    cloudMetered: true,
    mode: "byok",
    reportsUsage: false,
  },
  {
    name: "Corti on the user's own credentials",
    settings: { cloudTranscriptionProvider: "corti", cloudTranscriptionMode: "byok" },
    providerName: "corti",
    cloudMetered: undefined,
    mode: "byok",
    reportsUsage: false,
  },
  {
    name: "Tinfoil realtime on the user's own key",
    settings: { cloudTranscriptionProvider: "tinfoil", cloudTranscriptionMode: "byok" },
    providerName: "tinfoil-realtime",
    cloudMetered: undefined,
    mode: "byok",
    reportsUsage: false,
  },
  {
    name: "Deepgram through OpenWhispr Cloud",
    settings: { cloudTranscriptionMode: "openwhispr" },
    sttConfig: { streamingProvider: "deepgram" },
    providerName: "deepgram",
    cloudMetered: true,
    mode: "openwhispr",
    reportsUsage: true,
  },
  {
    name: "AssemblyAI through OpenWhispr Cloud",
    settings: { cloudTranscriptionMode: "openwhispr" },
    sttConfig: { streamingProvider: "assemblyai" },
    providerName: "assemblyai",
    cloudMetered: true,
    mode: "openwhispr",
    reportsUsage: true,
  },
];

test("usage reporting is gated to OpenWhispr-cloud transcriptions", async (t) => {
  const surface = await loadRoutingSurface(t);

  for (const testCase of CASES) {
    const { providerName, provider, options } = resolveSession(surface, testCase);

    assert.equal(providerName, testCase.providerName, `${testCase.name}: routed provider`);
    assert.equal(
      provider.cloudMetered,
      testCase.cloudMetered,
      `${testCase.name}: cloudMetered declaration`
    );
    assert.equal(options.mode, testCase.mode, `${testCase.name}: mode sent at connect time`);

    // Mirrors the gate in startStreamingRecording.
    const metered = !!provider.cloudMetered && options.mode === "openwhispr";
    assert.equal(metered, testCase.reportsUsage, `${testCase.name}: reports usage`);
  }
});
