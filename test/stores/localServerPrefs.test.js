const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const MODEL = "qwen3.5-4b-q4_k_m";

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
  return { ...store, ...policy };
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
  const needs = s.resolveLocalServerNeeds(s.selectLocalServerPrefs(s.getSettings(), UNMANAGED));

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

  const prefs = s.selectLocalServerPrefs(s.getSettings(), UNMANAGED);

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
  const needs = s.resolveLocalServerNeeds(s.selectLocalServerPrefs(s.getSettings(), UNMANAGED));

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
