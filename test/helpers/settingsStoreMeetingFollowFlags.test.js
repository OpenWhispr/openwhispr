const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const {
  resolveMeetingTranscriptionOptions,
} = require("../../src/helpers/meetingTranscriptionRouting.js");
const { buildNoteFormattingOverrides } = require("../../src/helpers/noteFormattingOverrides.js");
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

  await t.test("a ≤1.6.7 Local profile copies its modes into Note Recording", async () => {
    const { mod, state } = await load(LEGACY_LOCAL);
    assert.equal(storage.getItem("transcriptionMode"), "local", "dictation mode derived");
    assert.equal(storage.getItem("meetingTranscriptionMode"), "local", "copied, not skipped");
    assert.equal(storage.getItem("noteFormattingMode"), "local", "copied, then moved");
    assert.equal(state.meetingTranscriptionMode, "local");
    assert.equal(mod.selectResolvedNoteFormatting(state).mode, "local");
    assert.equal(meetingRoute(mod, state).provider, "local", "note recording stays local");
    assert.equal(countWrites("meetingTranscriptionMode"), 1, "written by the copy only");
  });

  await t.test("a ≤1.6.7 BYOK streaming profile copies its own provider", async () => {
    const { state } = await load({
      useLocalWhisper: "false",
      cloudTranscriptionMode: "byok",
      cloudTranscriptionProvider: "openai",
      cloudReasoningMode: "byok",
      reasoningProvider: "anthropic",
    });
    assert.equal(state.meetingTranscriptionMode, "providers");
    assert.equal(state.meetingCloudTranscriptionProvider, "openai");
    assert.equal(state.noteFormattingMode, "providers");
  });

  // Parity with everyone who ran 1.6.8: Note Recording rejects self-hosted with
  // a clear error rather than silently using OpenWhispr Cloud.
  await t.test(
    "a ≤1.6.7 custom-endpoint profile copies self-hosted and its remote type",
    async () => {
      const { state } = await load({
        useLocalWhisper: "false",
        cloudTranscriptionMode: "byok",
        cloudTranscriptionProvider: "custom",
        cloudTranscriptionBaseUrl: "http://stt.lan:8080/v1",
      });
      assert.equal(state.meetingTranscriptionMode, "self-hosted");
      assert.equal(state.meetingRemoteTranscriptionType, "openai-compatible");
      assert.equal(state.meetingRemoteTranscriptionUrl, "http://stt.lan:8080/v1");
    }
  );

  await t.test("a ≤1.6.7 OpenWhispr Cloud profile stays on OpenWhispr Cloud", async () => {
    const { state } = await load({
      useLocalWhisper: "false",
      cloudTranscriptionMode: "openwhispr",
      cloudReasoningMode: "openwhispr",
      isSignedIn: "true",
    });
    assert.equal(state.meetingTranscriptionMode, "openwhispr");
    assert.equal(state.noteFormattingMode, "openwhispr");
  });

  await t.test("a profile that ran 1.6.8 before 1.6.10 was already right", async () => {
    const { state } = await load({
      _providerSettingsMigrated: "1",
      useLocalWhisper: "true",
      transcriptionMode: "local",
      reasoningMode: "local",
      cloudReasoningMode: "byok",
      reasoningProvider: "llama",
    });
    assert.equal(state.meetingTranscriptionMode, "local");
    assert.equal(state.noteFormattingMode, "local");
    assert.equal(countWrites("meetingTranscriptionMode"), 1);
  });

  // migrateProviderSettings derives the modes even on empty storage, so the
  // copy now persists the defaults. Same values the store read before.
  await t.test(
    "a fresh install gets the default modes from the copy and nothing else",
    async () => {
      const { state } = await load({});
      assert.equal(storage.getItem("meetingTranscriptionMode"), "openwhispr");
      assert.equal(storage.getItem("noteFormattingMode"), "openwhispr");
      assert.equal(storage.getItem("meetingUseLocalWhisper"), null);
      assert.equal(storage.getItem("meetingCloudTranscriptionMode"), null);
      assert.equal(storage.getItem("noteFormattingCloudMode"), null);
      assert.equal(storage.getItem("meetingFollowsTranscription"), "false", "latched empty");
      assert.equal(state.meetingTranscriptionMode, "openwhispr");
      assert.equal(countWrites("meetingTranscriptionMode"), 1, "the copy, nothing after it");
      assert.equal(countWrites("noteFormattingMode"), 1);
    }
  );

  await t.test("a profile that latched before the modes existed is re-derived", async () => {
    const { mod, state } = await load(LATCHED_LOCAL);
    assert.equal(storage.getItem("meetingTranscriptionMode"), "local");
    assert.equal(storage.getItem("noteFormattingMode"), "local");
    assert.equal(state.meetingTranscriptionMode, "local");
    assert.equal(mod.selectResolvedNoteFormatting(state).mode, "local");
    assert.equal(meetingRoute(mod, state).provider, "local");
    assert.equal(
      writes.includes("meetingUseLocalWhisper"),
      false,
      "no write to a key nothing reads"
    );
  });

  await t.test(
    "a latched profile still holding meetingReasoning* keys is moved, then healed",
    async () => {
      const { _llmScopeKeysMigrated, noteFormattingCloudMode, noteFormattingProvider, ...pre170 } =
        LATCHED_LOCAL;
      const { state } = await load({
        ...pre170,
        meetingCloudReasoningMode: "byok",
        meetingReasoningProvider: "llama",
      });
      assert.equal(storage.getItem("meetingReasoningProvider"), null, "scope-key rename ran first");
      assert.equal(storage.getItem("noteFormattingCloudMode"), "byok");
      assert.equal(state.noteFormattingMode, "local");
    }
  );

  await t.test("every registry local provider heals note formatting to local", async () => {
    for (const provider of modelRegistryData.localProviders.map((entry) => entry.id)) {
      const { state } = await load({ ...LATCHED_LOCAL, noteFormattingProvider: provider });
      assert.equal(state.noteFormattingMode, "local", provider);
    }
  });

  await t.test("a latched cloud profile keeps the cloud it chose", async () => {
    const { state } = await load({
      ...LATCHED_LOCAL,
      transcriptionMode: "openwhispr",
      useLocalWhisper: "false",
      meetingUseLocalWhisper: "false",
      meetingCloudTranscriptionMode: "openwhispr",
      noteFormattingCloudMode: "openwhispr",
    });
    assert.equal(storage.getItem("meetingTranscriptionMode"), "openwhispr", "persisted");
    assert.equal(state.meetingTranscriptionMode, "openwhispr", "reconstructed, not localized");
    // A cloud reasoning snapshot is left absent, so note formatting keeps
    // following dictation cleanup. Same effective value here, no pin.
    assert.equal(storage.getItem("noteFormattingMode"), null);
    assert.equal(state.noteFormattingMode, "openwhispr");
  });

  // groq has no streaming model, so Note Recording will refuse it — parity with
  // the 1.6.8 cohort, and away from our servers. Assert the mode, not the throw.
  await t.test("a latched BYOK profile is re-derived to its own provider", async () => {
    const { mod, state } = await load({
      ...LATCHED_LOCAL,
      transcriptionMode: "providers",
      useLocalWhisper: "false",
      meetingUseLocalWhisper: "false",
      meetingCloudTranscriptionMode: "byok",
      meetingCloudTranscriptionProvider: "groq",
      noteFormattingProvider: "anthropic",
    });
    const resolved = mod.selectResolvedMeetingTranscription(state);
    assert.equal(resolved.transcriptionMode, "providers");
    assert.equal(resolved.cloudTranscriptionProvider, "groq");
    // The transcription side reconstructs every mode, because an absent
    // `meetingTranscriptionMode` routes to OpenWhispr Cloud. The reasoning side
    // does not: an absent `noteFormattingMode` follows dictation cleanup, so
    // pinning a cloud snapshot would move a since-local user to a third party.
    assert.equal(storage.getItem("noteFormattingMode"), null, "cloud snapshot not pinned");
    assert.equal(writes.includes("noteFormattingMode"), false);
  });

  // The reasoning-side leak the heal exists to close: the snapshot is local, but
  // dictation cleanup has since moved to OpenWhispr Cloud, and an absent
  // `noteFormattingMode` follows it there.
  await t.test(
    "a local reasoning snapshot is pinned before cleanup drags it cloud-ward",
    async () => {
      const { mod, state } = await load({
        ...LATCHED_LOCAL,
        cleanupMode: "openwhispr",
        cleanupCloudMode: "openwhispr",
        isSignedIn: "true",
      });
      assert.equal(storage.getItem("noteFormattingMode"), "local");
      assert.equal(mod.selectResolvedNoteFormatting(state).mode, "local");
      assert.equal(mod.selectIsCloudNoteFormattingMode(state), false, "not our servers");
      assert.equal(state.cleanupMode, "openwhispr", "dictation cleanup untouched");
    }
  );

  // Mirror of the case above, snapshot cloud-ward: leaving the key absent keeps
  // today's behavior, which is to follow dictation cleanup.
  await t.test("a cloud reasoning snapshot never overrides a since-local cleanup", async () => {
    const { mod, state } = await load({
      ...LATCHED_LOCAL,
      noteFormattingProvider: "anthropic",
      noteFormattingModel: "claude-sonnet-4-6",
      cleanupMode: "local",
      cleanupProvider: "llama",
      cleanupModel: "qwen3-8b",
    });
    assert.equal(storage.getItem("noteFormattingMode"), null);
    const overrides = buildNoteFormattingOverrides(
      mod.selectResolvedNoteFormatting(state),
      mod.selectIsCloudNoteFormattingMode(state)
    );
    // processText treats an override carrying no provider as implicit cleanup
    // and dispatches from the cleanup scope, which is local.
    assert.equal(overrides.provider, undefined, "no pin, so no anthropic dispatch");
  });

  await t.test(
    "the heal reads the Note Recording snapshot, not today's dictation keys",
    async () => {
      // Dictation moved to the cloud after 1.6.10; Note Recording's copy still says local.
      const { state } = await load({
        ...LATCHED_LOCAL,
        transcriptionMode: "openwhispr",
        useLocalWhisper: "false",
        cloudTranscriptionMode: "openwhispr",
      });
      assert.equal(state.meetingTranscriptionMode, "local");
      assert.equal(state.transcriptionMode, "openwhispr", "dictation untouched");
    }
  );

  await t.test("an explicit Note Recording choice is never overwritten", async () => {
    for (const mode of ["openwhispr", "providers", "local"]) {
      const { state } = await load({
        ...LATCHED_LOCAL,
        meetingTranscriptionMode: mode,
        meetingUseLocalWhisper: String(mode === "local"),
        meetingCloudTranscriptionMode: mode === "openwhispr" ? "openwhispr" : "byok",
        noteFormattingMode: mode,
      });
      assert.equal(state.meetingTranscriptionMode, mode);
      assert.equal(state.noteFormattingMode, mode);
      assert.equal(writes.includes("meetingTranscriptionMode"), false, `${mode}: untouched`);
      assert.equal(writes.includes("noteFormattingMode"), false, `${mode}: untouched`);
    }
  });

  // The scope editor can set a provider alone; only cloudMode proves a copy.
  // (Also the signed-out-at-1.6.7 cohort: no cloudReasoningMode ever persisted.)
  await t.test("a note-formatting provider on its own is not a copy", async () => {
    const { noteFormattingCloudMode, meetingUseLocalWhisper, ...seed } = LATCHED_LOCAL;
    const { state } = await load({ ...seed, noteFormattingProvider: "anthropic" });
    assert.equal(storage.getItem("noteFormattingMode"), null);
    assert.equal(state.noteFormattingMode, "openwhispr", "store default, not derived");
    assert.equal(writes.includes("noteFormattingMode"), false);
  });

  await t.test("the heal is idempotent", async () => {
    await load(LATCHED_LOCAL);
    const { state } = await reload();
    assert.equal(state.meetingTranscriptionMode, "local");
    assert.equal(writes.includes("meetingTranscriptionMode"), false, "second load is silent");
    assert.equal(writes.includes("noteFormattingMode"), false);
  });

  // PR #2093's meeting case, kept here too: a local mode over a false flag is
  // consistent state and must not be touched in either direction.
  await t.test("a local mode over a false flag is left alone", async () => {
    const { state } = await load({
      ...LATCHED_LOCAL,
      meetingTranscriptionMode: "local",
      meetingUseLocalWhisper: "false",
    });
    assert.equal(state.meetingTranscriptionMode, "local");
    assert.equal(storage.getItem("meetingUseLocalWhisper"), "false");
    assert.equal(writes.includes("meetingUseLocalWhisper"), false);
    assert.equal(writes.includes("meetingTranscriptionMode"), false);
  });

  await t.test("a copied mode-less-toggle desync follows the deliberate local flag", async () => {
    for (const mode of ["openwhispr", "providers"]) {
      const { mod, state } = await load({
        ...LATCHED_LOCAL,
        meetingTranscriptionMode: mode,
        meetingUseLocalWhisper: "true",
        meetingCloudTranscriptionMode: mode === "openwhispr" ? "openwhispr" : "byok",
      });
      assert.equal(state.meetingTranscriptionMode, "local", `${mode} → local`);
      assert.equal(meetingRoute(mod, state).provider, "local");
      assert.equal(writes.includes("meetingUseLocalWhisper"), false);
    }
  });
});
