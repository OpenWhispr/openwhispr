const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

// The cleanup configs are the only callers that can pin sampling for the
// IPC-bridged providers: local llama-server (`?? 0.7`), Anthropic and
// enterprise (`?? 0.3`) read `config.temperature` and otherwise keep their own
// default. Without this the "cleanup is deterministic" rule only held on the
// chat-completions transports and Gemini. They also require complete output, so
// a reply cut off at the token limit fails instead of replacing the dictation
// with its first part (#2091).
async function loadRouteResolver(t) {
  const { vite } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-cleanup-route-config-test-",
    settingsKey: "__cleanupRouteConfigSettings",
    mockModules: {
      "/stores/settingsStore": `
        export const getSettings = () => globalThis.__cleanupRouteConfigSettings;
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
          reachable: true,
          model: "translate-model",
          displayProvider: "test",
          config: { provider: "test" },
        });
      `,
      "/config/prompts": `
        export const resolvePrompt = () => "route prompt";
        export const appendScreenContextSuffix = (prompt) => prompt;
        export const wrapCleanupTranscript = (text) => text;
        export const getCleanupSystemPrompt = () => "cleanup prompt";
      `,
    },
  });
  const settings = { useCleanupModel: true, cleanupDisableThinking: true };
  const resolveReasoningRoute = (await vite.ssrLoadModule("/helpers/audioManager.js"))
    .resolveReasoningRoute;
  return (text, { voiceAgentRequested = false, translationRequested = false } = {}) =>
    resolveReasoningRoute(text, settings, "Jarvis", voiceAgentRequested, translationRequested);
}

test("the cleanup route pins temperature 0 and requires complete output", async (t) => {
  const resolveRoute = await loadRouteResolver(t);

  const route = resolveRoute("so um clean this up");

  assert.equal(route.kind, "cleanup");
  assert.equal(route.config.inferenceScope, "dictationCleanup");
  assert.equal(route.config.temperature, 0);
  assert.equal(route.config.requireCompleteOutput, true);
});

test("the translation chain's cleanup step pins the same config", async (t) => {
  const resolveRoute = await loadRouteResolver(t);

  const route = resolveRoute("so um translate this", { translationRequested: true });

  assert.equal(route.kind, "translation");
  assert.equal(route.cleanupConfig.inferenceScope, "dictationCleanup");
  assert.equal(route.cleanupConfig.temperature, 0);
  assert.equal(route.cleanupConfig.requireCompleteOutput, true);
});

test("the agent route keeps its provider defaults", async (t) => {
  const resolveRoute = await loadRouteResolver(t);

  const route = resolveRoute("Jarvis, what is on my calendar", { voiceAgentRequested: true });

  assert.equal(route.kind, "agent");
  assert.equal(route.config.temperature, undefined);
  assert.equal(route.config.requireCompleteOutput, undefined);
});
