const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const table = require("../../src/models/localSetupTable.json");

// Josh's must-have: a switched-off, unavailable or policy-hidden feature ends up
// off, on this device with no model — never on OpenWhispr Cloud, even for a
// signed-in user and after a restart.

const mac = (o) => ({
  platform: "darwin",
  arch: "arm64",
  name: "MacBook Pro",
  formFactor: "laptop",
  processorName: "Apple M5 Pro",
  appleChip: { generation: 5, tier: "Pro" },
  memoryGb: 48,
  graphicsName: null,
  nvidia: null,
  parakeetSupported: true,
  systemLanguage: "en",
  ...o,
});
const UNMANAGED = { status: "unmanaged", policy: null, appVersion: null };
const NO_AGENT_POLICY = {
  status: "managed",
  appVersion: "1.0.0",
  policy: {
    version: 1,
    transcription: { allowedModes: ["openwhispr", "local"], allowedByokProviders: [] },
    llm: {
      allowedModes: ["openwhispr", "local"],
      allowedByokProviders: [],
      allowedEnterpriseProviders: [],
    },
    features: { agentEnabled: false, webSearchEnabled: true },
    sharing: { externalLinkSharing: "allowed" },
    dataRetention: {
      audioRetentionMaxDays: null,
      localHistoryMode: "user_choice",
      cloudBackupAllowed: true,
    },
    minAppVersion: null,
  },
};

const CLEANUP_SCOPES = ["dictationCleanup", "noteFormatting", "dictationTranslation"];
const ASSISTANT_SCOPES = ["dictationAgent", "chatIntelligence"];
const SCOPES = [...CLEANUP_SCOPES, ...ASSISTANT_SCOPES];
const CLOUD_SELECTORS = [
  "selectIsCloudCleanupMode",
  "selectIsCloudChatAgentMode",
  "selectIsCloudDictationAgentMode",
  "selectIsCloudTranslationMode",
  "selectIsCloudNoteFormattingMode",
];

async function loadStore(vite) {
  return vite.ssrLoadModule("/stores/settingsStore.ts");
}

// A fresh, signed-in profile with the real store and the module under test.
async function setup(t) {
  const { storage } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-local-setup-settings-test-",
  });
  const store = await loadStore(vite);
  store.useSettingsStore.getState().setIsSignedIn(true);
  const { applyLocalSetupSettings, rememberPendingLocalSetupRows, activatePendingLocalSetupModel } =
    await vite.ssrLoadModule("/components/onboarding/localSetupSettings.ts");
  const { buildLocalSetupPlan } = await vite.ssrLoadModule("/config/localSetup.ts");
  const plan = (profile, { languages = ["en-US"], policy = UNMANAGED, required } = {}) =>
    buildLocalSetupPlan({
      profile,
      spokenLanguages: languages,
      policy,
      requiredSpeechModelId: required,
    });
  return {
    storage,
    vite,
    store,
    applyLocalSetupSettings,
    rememberPendingLocalSetupRows,
    activatePendingLocalSetupModel,
    plan,
  };
}

function assertNoCloud(store, label) {
  const state = store.useSettingsStore.getState();
  assert.equal(state.isSignedIn, true, `${label}: signed in`);
  for (const scope of SCOPES) {
    const cfg = store.selectResolvedLLMConfig(state, scope);
    assert.equal(cfg.mode, "local", `${label}: ${scope} mode`);
  }
  for (const selector of CLOUD_SELECTORS) {
    assert.equal(store[selector](state), false, `${label}: ${selector}`);
  }
}

function assertRow(store, scopes, on, modelId, label) {
  const state = store.useSettingsStore.getState();
  for (const scope of scopes) {
    const cfg = store.selectResolvedLLMConfig(state, scope);
    assert.equal(cfg.model, on ? modelId : "", `${label}: ${scope} model`);
    assert.equal(cfg.provider, on ? "qwen" : "", `${label}: ${scope} provider`);
  }
}

for (const switches of [
  { cleanup: true, assistant: true },
  { cleanup: false, assistant: true },
  { cleanup: true, assistant: false },
  { cleanup: false, assistant: false },
]) {
  test(`no scope routes to Cloud: ${JSON.stringify(switches)}`, async (t) => {
    const { store, applyLocalSetupSettings, plan } = await setup(t);
    // Left alone, a signed-in profile's chat runs on Cloud — the case this guards.
    assert.equal(store.selectIsCloudChatAgentMode(store.useSettingsStore.getState()), true);

    applyLocalSetupSettings(plan(mac({})), switches);

    const label = JSON.stringify(switches);
    assertNoCloud(store, label);
    const state = store.useSettingsStore.getState();
    assert.equal(state.useCleanupModel, switches.cleanup);
    assert.equal(state.useDictationAgent, switches.assistant);
    assert.equal(state.useDictationTranslation, false);
    assertRow(store, CLEANUP_SCOPES, switches.cleanup, table.models.cleanup, label);
    assertRow(store, ASSISTANT_SCOPES, switches.assistant, table.models.assistant, label);
  });
}

test("Proceed drops an older build's pending pick, so it cannot switch the assistant back on", async (t) => {
  const { storage, store, applyLocalSetupSettings, plan } = await setup(t);
  // Left by an older build's picker mid-download, in the format pendingLocalModels reads.
  storage.setItem(
    "pendingLocalModelSelectionsV1",
    JSON.stringify({
      dictation: { provider: "whisper", modelId: "base" },
      assistant: { provider: "qwen", modelId: table.models.assistant },
    })
  );
  storage.setItem("localSetupPending", "true");

  applyLocalSetupSettings(plan(mac({})), { cleanup: true, assistant: false });

  assert.equal(storage.getItem("pendingLocalModelSelectionsV1"), null, "no pending entries");
  assert.equal(storage.getItem("localSetupPending"), null, "no localSetupPending flag");
  const state = store.useSettingsStore.getState();
  assert.equal(state.useDictationAgent, false);
  assert.equal(state.useCleanupModel, true);
  assertRow(store, ASSISTANT_SCOPES, false, "", "legacy pending");
  assertNoCloud(store, "legacy pending");
});

test("an unavailable assistant is written off, even if its switch was on", async (t) => {
  const { store, applyLocalSetupSettings, plan } = await setup(t);
  const small = plan(mac({ memoryGb: 8, appleChip: { generation: 1, tier: "" } }));
  assert.equal(small.machineType, "mac-under-16");
  assert.equal(small.rows.find((r) => r.id === "assistant").label, "unavailable");
  assert.equal(small.rows.find((r) => r.id === "cleanup").label, "unavailable");

  applyLocalSetupSettings(small, { cleanup: true, assistant: true });

  assertNoCloud(store, "mac-under-16");
  const state = store.useSettingsStore.getState();
  assert.equal(state.useCleanupModel, false);
  assert.equal(state.useDictationAgent, false);
  assertRow(store, CLEANUP_SCOPES, false, "", "mac-under-16");
  assertRow(store, ASSISTANT_SCOPES, false, "", "mac-under-16");
});

test("a policy-hidden row is written off", async (t) => {
  const { store, applyLocalSetupSettings, plan } = await setup(t);
  const hidden = plan(mac({}), { policy: NO_AGENT_POLICY });
  assert.deepEqual(
    hidden.rows.map((r) => r.id),
    ["dictation", "cleanup"]
  );

  applyLocalSetupSettings(hidden, { cleanup: true, assistant: true });

  assertNoCloud(store, "no-agent policy");
  const state = store.useSettingsStore.getState();
  assert.equal(state.useCleanupModel, true);
  assert.equal(state.useDictationAgent, false);
  assertRow(store, CLEANUP_SCOPES, true, table.models.cleanup, "no-agent policy");
  assertRow(store, ASSISTANT_SCOPES, false, "", "no-agent policy");
});

test("restart keeps every switched-off scope local", async (t) => {
  const { storage, vite, applyLocalSetupSettings, plan } = await setup(t);
  applyLocalSetupSettings(plan(mac({})), { cleanup: false, assistant: false });

  // Reopen the latch so the Voice Assistant seed gets its chance to copy the
  // Chat scope over, as it would on a profile that never ran it.
  storage.removeItem("_dictationAgentSeeded");
  // Startup's reconciles run too. The agent's name is already in the
  // dictionary, so startup has no dictionary write to make.
  storage.setItem("customDictionary", JSON.stringify(["OpenWhispr"]));
  vite.moduleGraph.invalidateAll();
  const restarted = await loadStore(vite);
  await restarted.initializeSettings();

  assertNoCloud(restarted, "after restart");
  const state = restarted.useSettingsStore.getState();
  assert.equal(state.useCleanupModel, false);
  assert.equal(state.useDictationAgent, false);
  assertRow(restarted, CLEANUP_SCOPES, false, "", "after restart");
  assertRow(restarted, ASSISTANT_SCOPES, false, "", "after restart");
  assert.equal(storage.getItem("dictationAgentMode"), "local");
  assert.equal(storage.getItem("chatAgentMode"), "local");
});

test("dictation writes the engine and model for all three transcription contexts", async (t) => {
  const { store, applyLocalSetupSettings, plan } = await setup(t);
  const switches = { cleanup: false, assistant: false };

  applyLocalSetupSettings(plan(mac({}), { languages: ["de"] }), switches);
  let state = store.useSettingsStore.getState();
  assert.equal(state.localTranscriptionProvider, "nvidia");
  assert.equal(state.parakeetModel, "orukeet-v0.1.0");
  assert.equal(state.useLocalWhisper, true);
  assert.equal(state.meetingUseLocalWhisper, true);
  assert.equal(state.uploadUseLocalWhisper, true);
  assert.equal(state.meetingLocalTranscriptionProvider, "nvidia");
  assert.equal(state.uploadLocalTranscriptionProvider, "nvidia");
  for (const key of ["transcriptionMode", "meetingTranscriptionMode", "uploadTranscriptionMode"]) {
    assert.equal(state[key], "local", key);
  }

  applyLocalSetupSettings(plan(mac({}), { languages: ["ja"] }), switches);
  state = store.useSettingsStore.getState();
  assert.equal(state.localTranscriptionProvider, "whisper");
  assert.equal(state.whisperModel, "small");
  assert.equal(state.meetingLocalTranscriptionProvider, "whisper");
  assert.equal(state.uploadLocalTranscriptionProvider, "whisper");

  // An organisation-required Cohere model runs on its own engine slot.
  const cohere = "cohere-transcribe-03-2026";
  applyLocalSetupSettings(plan(mac({}), { required: cohere }), switches);
  state = store.useSettingsStore.getState();
  assert.equal(state.localTranscriptionProvider, "cohere");
  assert.equal(state.cohereModel, cohere);
  assert.equal(state.uploadLocalTranscriptionProvider, "cohere");
});

test("the vision override stays inactive", async (t) => {
  const { storage, store, applyLocalSetupSettings, plan } = await setup(t);
  applyLocalSetupSettings(plan(mac({})), { cleanup: true, assistant: true });

  const state = store.useSettingsStore.getState();
  assert.equal(state.useDictationAgentVisionModel, false);
  for (const key of ["dictationAgentVisionMode", "dictationAgentVisionModel"]) {
    assert.equal(storage.getItem(key), null, key);
  }
});

test("a row still downloading at Proceed is off until its model lands, then on", async (t) => {
  const {
    storage,
    store,
    applyLocalSetupSettings,
    rememberPendingLocalSetupRows,
    activatePendingLocalSetupModel,
    plan,
  } = await setup(t);
  const p = plan(mac({}));
  // Cleanup on disk at Proceed; the assistant still downloading.
  applyLocalSetupSettings(p, { cleanup: true, assistant: false });
  rememberPendingLocalSetupRows(p, ["assistant"]);

  assertNoCloud(store, "pending assistant");
  assertRow(store, ASSISTANT_SCOPES, false, "", "pending assistant");
  assert.equal(store.useSettingsStore.getState().useDictationAgent, false);
  assert.equal(storage.getItem("localSetupPending"), "true", "the tray may apply it");

  // Another model landing changes nothing.
  activatePendingLocalSetupModel(table.models.cleanup);
  assert.equal(store.useSettingsStore.getState().useDictationAgent, false);

  activatePendingLocalSetupModel(table.models.assistant);
  assertNoCloud(store, "assistant landed");
  assertRow(store, ASSISTANT_SCOPES, true, table.models.assistant, "assistant landed");
  assertRow(store, CLEANUP_SCOPES, true, table.models.cleanup, "cleanup unchanged");
  assert.equal(store.useSettingsStore.getState().useDictationAgent, true);
  assert.equal(storage.getItem("pendingLocalModelSelectionsV1"), null, "consumed");
});

test("a pending row never overrides what the user chose in Settings meanwhile", async (t) => {
  const {
    store,
    applyLocalSetupSettings,
    rememberPendingLocalSetupRows,
    activatePendingLocalSetupModel,
    plan,
  } = await setup(t);
  const p = plan(mac({}));
  applyLocalSetupSettings(p, { cleanup: false, assistant: false });
  rememberPendingLocalSetupRows(p, ["cleanup"]);
  // The user picks their own cleanup model before the download finishes.
  store.setResolvedLLMConfig("dictationCleanup", {
    mode: "local",
    provider: "qwen",
    model: "qwen3.5-0.8b-q4_k_m",
  });

  activatePendingLocalSetupModel(table.models.cleanup);

  const state = store.useSettingsStore.getState();
  assert.equal(
    store.selectResolvedLLMConfig(state, "dictationCleanup").model,
    "qwen3.5-0.8b-q4_k_m",
    "their pick stands"
  );
  assert.equal(state.useCleanupModel, false, "their switch stays as it was");
});

test("note formatting left off never borrows a cleanup model from another mode", async (t) => {
  const { store, applyLocalSetupSettings, plan } = await setup(t);
  applyLocalSetupSettings(plan(mac({})), { cleanup: false, assistant: false });
  const noteFormatting = () =>
    store.selectResolvedLLMConfig(store.useSettingsStore.getState(), "noteFormatting");

  // Later, in Settings, cleanup moves to a BYOK provider: llama could never run its model.
  store.setResolvedLLMConfig("dictationCleanup", {
    mode: "providers",
    provider: "openai",
    model: "gpt-6-luna",
  });
  assert.deepEqual(
    {
      mode: noteFormatting().mode,
      provider: noteFormatting().provider,
      model: noteFormatting().model,
    },
    { mode: "local", provider: "", model: "" }
  );

  store.setResolvedLLMConfig("dictationCleanup", { mode: "openwhispr", provider: "", model: "" });
  assert.equal(noteFormatting().model, "");
  assert.equal(store.selectIsCloudNoteFormattingMode(store.useSettingsStore.getState()), false);

  // A local cleanup model is one note formatting can run, so it still inherits it.
  store.setResolvedLLMConfig("dictationCleanup", {
    mode: "local",
    provider: "qwen",
    model: table.models.cleanup,
  });
  assert.equal(noteFormatting().model, table.models.cleanup);
});
