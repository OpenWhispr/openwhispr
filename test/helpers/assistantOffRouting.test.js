const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

// Onboarding's "assistant off" writes the agent scope as this device with no model
// and turns the agent off (localSetupSettings.ts). For a signed-in user that must
// never route the wake word or the voice-assistant key to OpenWhispr Cloud.
const ASSISTANT_OFF = {
  isSignedIn: true,
  useCleanupModel: false,
  useDictationAgent: false,
  dictationAgentMode: "local",
  dictationAgentProvider: "",
  dictationAgentModel: "",
  dictationAgentCloudMode: "openwhispr",
  dictationAgentRemoteUrl: "",
  enterpriseSetupMode: "personal",
  preferredLanguage: "en",
  uiLanguage: "en",
  snippets: [],
};
const KEY = "__assistantOffRoutingSettings";

test("the switched-off agent scope is neither Cloud nor reachable", async () => {
  const { selectIsCloudDictationAgentMode } = await import("../../src/stores/settingsStore.ts");
  const { resolveDictationAgentInference } = await import(
    "../../src/helpers/dictationAgentInference.js"
  );
  const isCloudAgent = selectIsCloudDictationAgentMode(ASSISTANT_OFF);
  assert.equal(isCloudAgent, false, "signed in, but the scope is local");
  const agent = resolveDictationAgentInference(ASSISTANT_OFF, { isCloudAgent });
  assert.equal(agent.reachable, false);
  assert.equal(agent.config.provider, "local");
  assert.equal(agent.displayProvider, "local");
});

async function loadRoute(t) {
  const { vite } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-assistant-off-routing-test-",
    settingsKey: KEY,
    settings: ASSISTANT_OFF,
    mockModules: {
      // Every scope reads as the onboarding wrote it: this device, no model.
      "/stores/settingsStore": `
        const local = { mode: "local", provider: "", model: "" };
        export const getSettings = () => globalThis.${KEY};
        export const getEffectiveCleanupModel = () => "";
        export const selectResolvedLLMConfig = () => local;
        export const selectIsCloudDictationAgentMode = () => false;
        export const isCloudCleanupMode = () => false;
        export const isCloudDictationAgentMode = () => false;
        export const isCloudTranslationMode = () => false;
      `,
      "/config/prompts": `
        export const resolvePrompt = () => "route prompt";
        export const appendScreenContextSuffix = (prompt) => prompt;
        export const wrapCleanupTranscript = (text) => text;
        export const getCleanupSystemPrompt = () => "cleanup prompt";
      `,
    },
  });
  const { resolveReasoningRoute } = await vite.ssrLoadModule("/helpers/audioManager.js");
  return (text, voiceAgentRequested = false) =>
    resolveReasoningRoute(text, ASSISTANT_OFF, "Jarvis", voiceAgentRequested, false);
}

test("the wake word with the assistant off goes out as plain dictation", async (t) => {
  const route = await loadRoute(t);
  const result = route("Jarvis, what is on my calendar today");
  assert.equal(result.kind, "skip");
  assert.equal(result.config, undefined, "no reasoning request is built");
});

test("the voice-assistant key with the assistant off stays on this device", async (t) => {
  const route = await loadRoute(t);
  const result = route("what is on my calendar today", true);
  assert.equal(result.kind, "agent");
  assert.equal(result.config.provider, "local");
  assert.equal(result.model, "");
  assert.equal(result.config.selectionEditReachable, false);
});
