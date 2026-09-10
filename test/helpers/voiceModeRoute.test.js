const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

// The matched mode has to reach the model on both dictation paths: the cleanup
// route hands it to the provider (which appends it to the cleanup prompt it
// builds), while the agent route builds its prompt here, so the suffix is
// applied before the screen-context suffix and survives the text-only retry.
async function loadRouteResolver(t) {
  const { vite } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-voice-mode-route-test-",
    settingsKey: "__voiceModeRouteSettings",
    mockModules: {
      "/stores/settingsStore": `
        export const getSettings = () => globalThis.__voiceModeRouteSettings;
        export const getEffectiveCleanupModel = () => "cleanup-model";
        export const selectResolvedLLMConfig = () => ({ model: "cleanup-model" });
        export const isCloudCleanupMode = () => false;
        export const isCloudDictationAgentMode = () => false;
        export const isCloudTranslationMode = () => false;
      `,
      "/dictationAgentInference": `
        export const resolveDictationAgentInference = () => ({
          reachable: true,
          model: "agent-model",
          displayProvider: "test",
          config: { provider: "test" },
        });
        export const resolveDictationAgentVisionInference = () => ({
          active: false,
          model: "",
          config: {},
        });
      `,
      "/dictationTranslationInference": `
        export const resolveDictationTranslationInference = () => ({
          reachable: false,
          model: "",
          displayProvider: "test",
          config: {},
        });
      `,
      "/config/prompts": `
        export const resolvePrompt = () => "agent prompt";
        export const appendScreenContextSuffix = (prompt) => prompt + " [screen]";
        export const appendVoiceModeSuffix = (prompt, voiceMode) =>
          voiceMode ? prompt + " [" + voiceMode.instructions + "]" : prompt;
        export const wrapCleanupTranscript = (text) => text;
        export const getCleanupSystemPrompt = () => "cleanup prompt";
      `,
    },
  });
  const settings = { useCleanupModel: true, cleanupDisableThinking: true };
  const resolveReasoningRoute = (await vite.ssrLoadModule("/helpers/audioManager.js"))
    .resolveReasoningRoute;
  return (text, { voiceAgentRequested = false, voiceMode = null } = {}) =>
    resolveReasoningRoute(text, settings, "Jarvis", voiceAgentRequested, false, null, {
      voiceMode,
    });
}

const voiceMode = { appName: "Slack", instructions: "Be formal." };

test("the cleanup route carries the voice mode for the provider", async (t) => {
  const resolveRoute = await loadRouteResolver(t);

  assert.deepEqual(resolveRoute("so um clean this up", { voiceMode }).config.voiceMode, voiceMode);
  assert.equal("voiceMode" in resolveRoute("so um clean this up").config, false);
});

test("the agent route bakes the voice mode into its prompt", async (t) => {
  const resolveRoute = await loadRouteResolver(t);

  const route = resolveRoute("Jarvis, make this longer", { voiceAgentRequested: true, voiceMode });

  assert.equal(route.kind, "agent");
  assert.equal(route.config.systemPrompt, "agent prompt [Be formal.]");
  assert.equal("voiceMode" in route.config, false);
});
