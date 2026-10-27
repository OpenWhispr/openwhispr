const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

// The raw and cleaned dictation hotkeys are proven by what runs, not by how the
// text reads: raw must make no cleanup request at all, and cleaned must make
// exactly one even with the global preference off.

const CLEANUP_MODEL = "gemini-3-flash-preview";

const settingsStoreMock = (
  settingsKey,
  { cleanupModel = CLEANUP_MODEL, cloudCleanup = false } = {}
) => `
  export const getSettings = () => globalThis.${settingsKey};
  export const getEffectiveCleanupModel = () => ${JSON.stringify(cleanupModel)};
  export const selectResolvedLLMConfig = () => ({
    mode: "providers",
    provider: "gemini",
    model: ${JSON.stringify(cleanupModel)}
  });
  export const isCloudCleanupMode = () => ${cloudCleanup};
  export const isCloudDictationAgentMode = () => false;
  export const isCloudTranslationMode = () => false;
  export const useSettingsStore = {
    subscribe: () => () => {},
    // resolvePrompt reads the custom-prompt overrides through the store.
    getState: () => ({ customPrompts: {} }),
  };
`;

const UNREACHABLE_AGENT = `
  export const resolveDictationAgentInference = () => ({
    reachable: false, model: "", displayProvider: "none", config: {}
  });
  export const resolveDictationAgentVisionInference = () => ({
    active: false, model: "", config: {}
  });
`;

const REACHABLE_AGENT = `
  export const resolveDictationAgentInference = () => ({
    reachable: true, model: "gpt-6-astra", displayProvider: "openai", config: {}
  });
  export const resolveDictationAgentVisionInference = () => ({
    active: false, model: "", config: {}
  });
`;

const UNREACHABLE_TRANSLATION = `
  export const resolveDictationTranslationInference = () => ({
    reachable: false, model: "", displayProvider: "none", config: {}
  });
`;

async function loadManagerFactory(
  t,
  { cachePrefix, settingsKey, cleanupModel, cloudCleanup, agent = UNREACHABLE_AGENT } = {}
) {
  const { createManager } = await loadAudioManager(t, {
    cachePrefix,
    settingsKey,
    mockModules: {
      "/stores/settingsStore": settingsStoreMock(settingsKey, { cleanupModel, cloudCleanup }),
      "/dictationAgentInference": agent,
      "/dictationTranslationInference": UNREACHABLE_TRANSLATION,
    },
  });
  return createManager;
}

function setSettings(settingsKey, overrides = {}) {
  globalThis[settingsKey] = {
    useCleanupModel: true,
    useDictationAgent: false,
    useDictationTranslation: false,
    cleanupProvider: "gemini",
    cleanupMode: "providers",
    customDictionary: [],
    cleanupDisableThinking: true,
    preferredLanguage: "en",
    snippets: [],
    ...overrides,
  };
}

// A manager whose cleanup call is counted. agentName is read through
// getAgentName(), which needs localStorage; the harness installs it.
function trackingManager(createManager, { cleanupOverride, cleanedText = "Cleaned." } = {}) {
  const calls = [];
  const manager = createManager({
    voiceAgentRequested: false,
    translationRequested: false,
    pendingCleanupFailure: null,
    pendingAssistantConversation: null,
    pendingSelectionEdit: null,
    cleanupOverride: null,
    _processingCleanupOverride: cleanupOverride ?? null,
    processWithReasoningModel: async (text, model, agentName, config) => {
      calls.push({ text, model, config });
      return cleanedText;
    },
  });
  return { manager, calls };
}

test("raw dictation makes no cleanup request even with global cleanup on", async (t) => {
  const settingsKey = "__cleanupOverrideRawSettings";
  const createManager = await loadManagerFactory(t, {
    cachePrefix: "openwhispr-cleanup-override-raw-",
    settingsKey,
  });
  setSettings(settingsKey, { useCleanupModel: true });

  const { manager, calls } = trackingManager(createManager, { cleanupOverride: "raw" });
  let availabilityChecks = 0;
  manager.isReasoningAvailable = async () => {
    availabilityChecks += 1;
    return true;
  };

  const text = await manager.processTranscriptionCore("um so send the report", "local");

  assert.equal(text, "um so send the report");
  assert.deepEqual(calls, [], "raw must not reach the cleanup model");
  assert.equal(availabilityChecks, 0, "raw must not even probe reasoning availability");
  assert.deepEqual(manager._takePendingResultExtras(), {});
});

test("cleaned dictation runs cleanup exactly once with global cleanup off", async (t) => {
  const settingsKey = "__cleanupOverrideCleanedSettings";
  const createManager = await loadManagerFactory(t, {
    cachePrefix: "openwhispr-cleanup-override-cleaned-",
    settingsKey,
  });
  setSettings(settingsKey, { useCleanupModel: false });

  const { manager, calls } = trackingManager(createManager, { cleanupOverride: "cleaned" });

  const text = await manager.processTranscriptionCore("um so send the report", "local");

  assert.equal(text, "Cleaned.");
  assert.equal(calls.length, 1, "cleaned must run the configured cleanup once");
  assert.equal(calls[0].config.inferenceScope, "dictationCleanup");
  assert.deepEqual(manager._takePendingResultExtras(), {});
});

test("default dictation still follows the global cleanup preference", async (t) => {
  const settingsKey = "__cleanupOverrideDefaultSettings";
  const createManager = await loadManagerFactory(t, {
    cachePrefix: "openwhispr-cleanup-override-default-",
    settingsKey,
  });

  setSettings(settingsKey, { useCleanupModel: true });
  const on = trackingManager(createManager, { cleanupOverride: null });
  on.manager.isReasoningAvailable = async () => true;
  assert.equal(await on.manager.processTranscriptionCore("raw words", "local"), "Cleaned.");
  assert.equal(on.calls.length, 1);

  setSettings(settingsKey, { useCleanupModel: false });
  const off = trackingManager(createManager, { cleanupOverride: null });
  assert.equal(await off.manager.processTranscriptionCore("raw words", "local"), "raw words");
  assert.deepEqual(off.calls, []);
});

// Explicit dictation stays dictation: a transcript that opens with the wake
// phrase must not be answered by the agent.
test("an explicit mode ignores the wake word in the transcript", async (t) => {
  const settingsKey = "__cleanupOverrideWakeWordSettings";
  const createManager = await loadManagerFactory(t, {
    cachePrefix: "openwhispr-cleanup-override-wake-word-",
    settingsKey,
    agent: REACHABLE_AGENT,
  });
  setSettings(settingsKey, { useCleanupModel: false, useDictationAgent: true });
  // Each loadAudioManager call installs its own localStorage, so this name is
  // scoped to this test.
  globalThis.localStorage.setItem("agentName", "Max");

  // Control: the same transcript does take the agent route without an override,
  // so the assertions below are about the override and not about detection.
  const plain = trackingManager(createManager, { cleanupOverride: null });
  let plainAgentCommands = 0;
  plain.manager.isReasoningAvailable = async () => true;
  plain.manager.processAgentCommand = async () => {
    plainAgentCommands += 1;
    return "agent answer";
  };
  assert.equal(
    await plain.manager.processTranscriptionCore("Hey Max, summarise this note", "local"),
    "agent answer"
  );
  assert.equal(plainAgentCommands, 1, "the wake word must be detected without an override");

  const raw = trackingManager(createManager, { cleanupOverride: "raw" });
  let agentCommands = 0;
  raw.manager.processAgentCommand = async () => {
    agentCommands += 1;
    return "agent answer";
  };

  const spoken = "Hey Max, summarise this note";
  assert.equal(await raw.manager.processTranscriptionCore(spoken, "local"), spoken);
  assert.equal(agentCommands, 0, "raw must never reach the agent route");
  assert.deepEqual(raw.calls, []);

  const cleaned = trackingManager(createManager, { cleanupOverride: "cleaned" });
  cleaned.manager.processAgentCommand = async () => {
    agentCommands += 1;
    return "agent answer";
  };
  assert.equal(await cleaned.manager.processTranscriptionCore(spoken, "local"), "Cleaned.");
  assert.equal(agentCommands, 0, "cleaned must never reach the agent route");
  assert.equal(cleaned.calls.length, 1);
});

// The cleaned hotkey cannot manufacture configuration: the transcript survives
// and the user is told cleanup did not run — through upstream's
// unconfigured-cleanup notice (#2634), which this recording's pinned mode
// stands in for while the global preference is off.
test("cleaned with no cleanup model pastes the transcript and reports the gap", async (t) => {
  const settingsKey = "__cleanupOverrideUnconfiguredSettings";
  const createManager = await loadManagerFactory(t, {
    cachePrefix: "openwhispr-cleanup-override-unconfigured-",
    settingsKey,
    cleanupModel: "",
  });
  setSettings(settingsKey, { useCleanupModel: false });

  const { manager, calls } = trackingManager(createManager, { cleanupOverride: "cleaned" });

  const text = await manager.processTranscriptionCore("um so send the report", "local");

  assert.equal(text, "um so send the report");
  assert.deepEqual(calls, []);
  assert.deepEqual(manager._takePendingResultExtras(), {
    cleanupFailure: {
      message: "AI cleanup is on, but no cleanup model is set up.",
      messageKey: "hooks.audioRecording.cleanupUnconfigured",
      surface: "llm",
      settingsTarget: "llms",
      setupKey: ["unconfigured", "providers", "gemini"].join("\0"),
    },
  });
  // Banked once per recording, and consumed by the result that carries it.
  assert.deepEqual(manager._takePendingResultExtras(), {});
});

// Upstream's notice alone would fire here — the preference is on and no model
// can run — but this recording asked for no cleanup, so there is nothing to
// warn about.
test("raw with no cleanup model reports nothing — it asked for none", async (t) => {
  const settingsKey = "__cleanupOverrideRawUnconfiguredSettings";
  const createManager = await loadManagerFactory(t, {
    cachePrefix: "openwhispr-cleanup-override-raw-unconfigured-",
    settingsKey,
    cleanupModel: "",
  });
  setSettings(settingsKey, { useCleanupModel: true });

  const { manager } = trackingManager(createManager, { cleanupOverride: "raw" });
  await manager.processTranscriptionCore("um so send the report", "local");

  assert.deepEqual(manager._takePendingResultExtras(), {});
});

// The mode is bound when finalization starts, so the next recording's mode
// cannot reach an in-flight one's reasoning route.
test("the mode bound at finalization survives a later mode change", async (t) => {
  const settingsKey = "__cleanupOverrideSnapshotSettings";
  const createManager = await loadManagerFactory(t, {
    cachePrefix: "openwhispr-cleanup-override-snapshot-",
    settingsKey,
  });
  setSettings(settingsKey, { useCleanupModel: false });

  const { manager, calls } = trackingManager(createManager);
  manager.cleanupOverride = "cleaned";
  manager._bindCleanupOverrideForProcessing();
  // A later recording starts in the opposite mode while this one is still
  // being transcribed.
  manager.setCleanupOverride("raw");

  assert.equal(manager.cleanupOverride, "raw");
  assert.equal(manager._processingCleanupOverride, "cleaned");
  assert.equal(await manager.processTranscriptionCore("raw words", "local"), "Cleaned.");
  assert.equal(calls.length, 1, "the in-flight recording keeps the mode it started with");
});

test("setCleanupOverride normalizes anything that is not a mode to null", async (t) => {
  const settingsKey = "__cleanupOverrideSetterSettings";
  const createManager = await loadManagerFactory(t, {
    cachePrefix: "openwhispr-cleanup-override-setter-",
    settingsKey,
  });
  const manager = createManager({ cleanupOverride: "cleaned", _processingCleanupOverride: null });

  manager.setCleanupOverride(undefined);
  assert.equal(manager.cleanupOverride, null);
  manager.setCleanupOverride("raw");
  assert.equal(manager.cleanupOverride, "raw");
  manager.setCleanupOverride("sparkling");
  assert.equal(manager.cleanupOverride, null);
});

// The preview must not advertise a cleanup pass the recording will not run.
test("the preview cleanup state follows the recording's mode", async (t) => {
  const settingsKey = "__cleanupOverridePreviewSettings";
  const createManager = await loadManagerFactory(t, {
    cachePrefix: "openwhispr-cleanup-override-preview-",
    settingsKey,
  });
  setSettings(settingsKey, { useCleanupModel: true, useDictationAgent: true });
  const manager = createManager({ translationRequested: false, _processingCleanupOverride: null });

  assert.equal(manager.shouldShowPreviewCleanupState(), true);
  manager._processingCleanupOverride = "raw";
  assert.equal(manager.shouldShowPreviewCleanupState(), false);
  manager._processingCleanupOverride = "cleaned";
  assert.equal(manager.shouldShowPreviewCleanupState(), true);

  setSettings(settingsKey, { useCleanupModel: false, useDictationAgent: false });
  manager._processingCleanupOverride = "cleaned";
  assert.equal(manager.shouldShowPreviewCleanupState(), true);
  manager._processingCleanupOverride = null;
  assert.equal(manager.shouldShowPreviewCleanupState(), false);
});

// A raw recording never defers its STT log to a cleanup request that will not
// happen, and a cleaned one does defer even with the preference off.
test("the combined cloud STT log follows the recording's mode", async (t) => {
  const settingsKey = "__cleanupOverrideSendLogsSettings";
  const createManager = await loadManagerFactory(t, {
    cachePrefix: "openwhispr-cleanup-override-send-logs-",
    settingsKey,
    cloudCleanup: true,
  });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  t.after(() => delete navigator.onLine);

  const uploads = [];
  globalThis.window.electronAPI.cloudTranscribe = async (_buffer, opts) => {
    uploads.push(opts);
    return { success: true, text: "" };
  };

  const transcribe = async (cleanupOverride, useCleanupModel) => {
    setSettings(settingsKey, { useCleanupModel, cleanupCloudMode: "openwhispr" });
    const manager = createManager({
      voiceAgentRequested: false,
      translationRequested: false,
      _processingCleanupOverride: cleanupOverride,
      getEffectiveSttLanguage: () => "en",
      getWhisperPrompt: () => null,
      isDictionaryEcho: () => false,
      consumeStreamingFallbackReason: () => null,
    });
    await manager.processWithOpenWhisprCloud(new Blob([new Uint8Array(16)]));
    return uploads[uploads.length - 1];
  };

  assert.equal((await transcribe(null, true)).sendLogs, "false");
  assert.equal((await transcribe(null, false)).sendLogs, undefined);
  assert.equal(
    (await transcribe("raw", true)).sendLogs,
    undefined,
    "raw writes its own log — no cleanup request follows it"
  );
  assert.equal((await transcribe("cleaned", false)).sendLogs, "false");
});
