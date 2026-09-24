const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const MODEL = "qwen3.5-4b-q4_k_m";
// A distinct local model/provider for the Chat scope, so tests can tell
// which scope's model actually reached the server's needs.
const CHAT_MODEL = "gemma-4-31b-it-q4_k_m";

const UNMANAGED = { status: "unmanaged", policy: null, appVersion: null };

const ALL_CLOUD = {
  _llmScopeKeysMigrated: "1",
  _dictationAgentSeeded: "1",
  cleanupMode: "openwhispr",
  dictationAgentMode: "openwhispr",
  noteFormattingMode: "openwhispr",
  chatAgentMode: "openwhispr",
  translationMode: "openwhispr",
};

async function loadStore(t, initialStorage, cachePrefix) {
  installBrowserGlobals(t, { initialStorage });
  const vite = await createRendererServer(t, {
    cachePrefix,
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
  });
  await vite.ssrLoadModule("/models/ModelRegistry.ts");
  const store = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const policy = await vite.ssrLoadModule("/helpers/localServerPolicy.js");
  const inference = await vite.ssrLoadModule("/helpers/dictationAgentInference.js");
  return { ...store, ...policy, ...inference };
}

test("typed chat on a local model keeps the server once cleanup moves to the cloud", async (t) => {
  const s = await loadStore(
    t,
    {
      ...ALL_CLOUD,
      cleanupMode: "local",
      cleanupProvider: "qwen",
      cleanupModel: MODEL,
      chatAgentMode: "local",
      chatAgentProvider: "qwen",
      chatAgentModel: MODEL,
    },
    "openwhispr-local-server-prefs-chat-test-"
  );

  s.setResolvedLLMConfig("dictationCleanup", { mode: "openwhispr", cloudMode: "openwhispr" });
  const needs = s.resolveLocalServerNeeds(
    s.selectLocalServerPrefs(s.useSettingsStore.getState(), UNMANAGED)
  );

  assert.deepEqual(needs.models, [MODEL]);
  assert.equal(s.shouldStopLocalServer(needs, MODEL), false);
});

test("note formatting counts the local model it inherits from cleanup", async (t) => {
  const s = await loadStore(
    t,
    {
      ...ALL_CLOUD,
      cleanupMode: "local",
      cleanupProvider: "qwen",
      cleanupModel: MODEL,
      noteFormattingMode: "local",
    },
    "openwhispr-local-server-prefs-notes-test-"
  );

  const prefs = s.selectLocalServerPrefs(s.useSettingsStore.getState(), UNMANAGED);

  assert.equal(prefs.noteFormattingMode, "local");
  assert.equal(prefs.noteFormattingModel, MODEL);
});

test("the server stops once the last local scope leaves", async (t) => {
  const s = await loadStore(
    t,
    { ...ALL_CLOUD, dictationAgentMode: "local", dictationAgentModel: MODEL },
    "openwhispr-local-server-prefs-last-test-"
  );

  s.setResolvedLLMConfig("dictationAgent", { mode: "openwhispr", cloudMode: "openwhispr" });
  const needs = s.resolveLocalServerNeeds(
    s.selectLocalServerPrefs(s.useSettingsStore.getState(), UNMANAGED)
  );

  assert.deepEqual(needs.models, []);
  assert.equal(s.shouldStopLocalServer(needs, MODEL), true);
});

test("a policy that forbids local inference reports the clamped mode", async (t) => {
  const s = await loadStore(
    t,
    { ...ALL_CLOUD, cleanupMode: "local", cleanupProvider: "qwen", cleanupModel: MODEL },
    "openwhispr-local-server-prefs-policy-test-"
  );
  const cloudOnly = {
    status: "managed",
    policy: {
      version: 1,
      transcription: { allowedModes: ["openwhispr"], allowedByokProviders: [] },
      llm: {
        allowedModes: ["openwhispr"],
        allowedByokProviders: [],
        allowedEnterpriseProviders: [],
      },
      features: { agentEnabled: true, webSearchEnabled: true, screenContextEnabled: true },
      sharing: { externalLinkSharing: "allowed" },
      dataRetention: {
        audioRetentionMaxDays: null,
        localHistoryMode: "user_choice",
        cloudBackupAllowed: true,
      },
      minAppVersion: null,
    },
  };

  const prefs = s.selectLocalServerPrefs(s.useSettingsStore.getState(), cloudOnly);

  assert.notEqual(prefs.cleanupMode, "local");
  assert.deepEqual(s.resolveLocalServerNeeds(prefs).models, []);
});

// A voice session always answers through resolveChatStreamingInference's
// "dictationAgent" scope (src/helpers/dictationAgentInference.js). When the
// Voice Assistant scope (useDictationAgent) is off, that scope is
// unreachable and the call falls back to chatIntelligence — so the model a
// voice session actually talks to is whatever Chat resolves to, and
// resolveLocalServerNeeds already counts the chat scope unconditionally.
// These tests pin that the brain a voice session uses is always in the
// server's needs, without a dedicated voiceConversationEnabled plumbing
// through LocalServerPrefs (see task-7-brief-ruled.md for why that plan was
// dropped).
test("a voice session's brain stays in llama-server's needs when the Voice Assistant is off", async (t) => {
  const s = await loadStore(
    t,
    {
      ...ALL_CLOUD,
      useDictationAgent: "false",
      voiceConversationEnabled: "true",
      dictationAgentMode: "local",
      dictationAgentProvider: "qwen",
      dictationAgentModel: MODEL,
      chatAgentMode: "local",
      chatAgentProvider: "gemma",
      chatAgentModel: CHAT_MODEL,
    },
    "openwhispr-local-server-prefs-voice-off-test-"
  );

  const state = s.useSettingsStore.getState();
  const { config } = s.resolveChatStreamingInference(state, { inferenceScope: "dictationAgent" });
  assert.equal(config.mode, "local");
  assert.equal(
    config.model,
    CHAT_MODEL,
    "the Voice Assistant scope is unreachable, so the voice session falls back to Chat's model"
  );

  const needs = s.resolveLocalServerNeeds(s.selectLocalServerPrefs(state, UNMANAGED));
  assert.ok(needs.models.includes(CHAT_MODEL), "the model the voice session actually uses is needed");
  assert.equal(s.shouldStopLocalServer(needs, CHAT_MODEL), false);
  assert.ok(
    !needs.models.includes(MODEL),
    "the unreachable Voice Assistant model is never pre-warmed for a voice session"
  );
});

test("with the Voice Assistant on, the voice brain is its model and stays in the needs", async (t) => {
  const s = await loadStore(
    t,
    {
      ...ALL_CLOUD,
      useDictationAgent: "true",
      voiceConversationEnabled: "true",
      dictationAgentMode: "local",
      dictationAgentProvider: "qwen",
      dictationAgentModel: MODEL,
      chatAgentMode: "local",
      chatAgentProvider: "gemma",
      chatAgentModel: CHAT_MODEL,
    },
    "openwhispr-local-server-prefs-voice-on-test-"
  );

  const state = s.useSettingsStore.getState();
  const { config } = s.resolveChatStreamingInference(state, { inferenceScope: "dictationAgent" });
  assert.equal(config.mode, "local");
  assert.equal(
    config.model,
    MODEL,
    "a reachable Voice Assistant scope answers on its own model, not Chat's"
  );

  const needs = s.resolveLocalServerNeeds(s.selectLocalServerPrefs(state, UNMANAGED));
  assert.ok(needs.models.includes(MODEL));
  assert.equal(s.shouldStopLocalServer(needs, MODEL), false);
});
