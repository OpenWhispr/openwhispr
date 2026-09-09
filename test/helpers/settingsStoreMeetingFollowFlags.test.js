const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const {
  resolveMeetingTranscriptionOptions,
} = require("../../src/helpers/meetingTranscriptionRouting.js");
const modelRegistryData = require("../../src/models/modelRegistryData.json");

// migrateMeetingFollowFlags() copies the dictation keys into Note Recording once
// and latches. Until 1.10.0 it ran before migrateProviderSettings() had created
// `transcriptionMode` / `reasoningMode`, so a profile upgrading straight from
// ≤1.6.7 copied everything except the two modes. Both mode readers default to
// "openwhispr" with no fallback, so note recordings and note formatting went to
// OpenWhispr Cloud for a Local-everywhere user. The store now copies after the
// modes exist and re-derives them for profiles that already latched.

// A ≤1.6.7 profile: no mode keys, no migration sentinels, no follow flags.
const LEGACY_LOCAL = {
  useLocalWhisper: "true",
  whisperModel: "base",
  localTranscriptionProvider: "whisper",
  cloudReasoningMode: "byok",
  reasoningProvider: "llama",
  reasoningModel: "qwen3-8b",
};

// A profile that already ran ≥1.7.0 with the old order: every sentinel set,
// every Note Recording key copied except the modes, reasoning keys already
// moved to their noteFormatting* names.
const LATCHED_LOCAL = {
  _providerSettingsMigrated: "1",
  _agentModeMigrated: "1",
  _llmScopeKeysMigrated: "1",
  uploadTranscriptionMigrated: "true",
  meetingFollowsTranscription: "false",
  meetingFollowsReasoning: "false",
  transcriptionMode: "local",
  useLocalWhisper: "true",
  meetingUseLocalWhisper: "true",
  meetingWhisperModel: "base",
  meetingLocalTranscriptionProvider: "whisper",
  noteFormattingCloudMode: "byok",
  noteFormattingProvider: "llama",
};

const meetingRoute = (mod, state) => {
  const resolved = mod.selectResolvedMeetingTranscription(state);
  return resolveMeetingTranscriptionOptions({
    transcriptionMode: resolved.transcriptionMode,
    language: "en",
    localProvider: resolved.localTranscriptionProvider,
    whisperModel: resolved.whisperModel,
    parakeetModel: resolved.parakeetModel,
    cohereModel: resolved.cohereModel,
    selectedProvider: resolved.cloudTranscriptionProvider,
    selectedModel: resolved.cloudTranscriptionModel,
    byokProviders: [],
    managedProviders: [],
    keyterms: [],
  });
};

test("Note Recording modes survive the follow-flag migration", async (t) => {
  const { storage } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-follow-flags-test-",
  });

  // Migrations run once per module evaluation, so every case re-evaluates the
  // store. `writes` holds only module-eval writes (seeding happens before reset).
  const writes = [];
  const setItem = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    writes.push(key);
    setItem(key, value);
  };
  const countWrites = (key) => writes.filter((written) => written === key).length;
  const reload = async () => {
    writes.length = 0;
    vite.moduleGraph.invalidateAll();
    const mod = await vite.ssrLoadModule("/stores/settingsStore.ts");
    return { mod, state: mod.useSettingsStore.getState() };
  };
  const load = async (seed) => {
    storage.clear();
    for (const [key, value] of Object.entries(seed)) {
      if (value !== undefined) storage.setItem(key, value); // the harness would stringify undefined
    }
    return reload();
  };

  // Pins the non-local branches of the reasoning-mode derivation the
  // provider-settings and agent-mode migrations share (the local branch is
  // pinned per registry provider in settingsStoreLocalProviderMigrations.test.js).
  await t.test("legacy reasoning keys derive the same modes as before", async () => {
    const cases = [
      [{ cloudReasoningMode: "byok", reasoningProvider: "custom" }, "self-hosted"],
      [{ cloudReasoningMode: "byok", reasoningProvider: "bedrock" }, "enterprise"],
      [{ cloudReasoningMode: "byok", reasoningProvider: "azure" }, "enterprise"],
      [{ cloudReasoningMode: "byok", reasoningProvider: "vertex" }, "enterprise"],
      [{ cloudReasoningMode: "byok", reasoningProvider: "anthropic" }, "providers"],
      [{ cloudReasoningMode: "byok" }, "providers"],
      [{ cloudReasoningMode: "openwhispr", reasoningProvider: "llama" }, "openwhispr"],
      [{ reasoningProvider: "llama" }, "openwhispr"],
    ];
    for (const [seed, expected] of cases) {
      const { state } = await load({
        ...seed,
        cloudAgentMode: seed.cloudReasoningMode,
        agentProvider: seed.reasoningProvider,
      });
      // reasoningMode / agentInferenceMode are renamed by migrateLLMScopeKeys.
      assert.equal(state.cleanupMode, expected, `reasoning ${JSON.stringify(seed)}`);
      assert.equal(state.chatAgentMode, expected, `agent ${JSON.stringify(seed)}`);
    }
  });
});
