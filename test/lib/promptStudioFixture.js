const assert = require("node:assert/strict");
const React = require("react");
const { mountAuditDom } = require("./settingsAuditHarness");
const { createRendererServer } = require("./rendererTestHarness");

// Shared PromptStudio mount: happy-dom audit DOM plus the module mocks the
// studio needs (policy/settings stores, inference resolvers, ReasoningService
// call capture, textarea probe). Returns { dom, container, root, observed,
// PromptStudio, resolvePrompt, click } — `observed.pending` settles the fake
// ReasoningService request, `observed.edit` is the rows-16 textarea's props.
async function mountPromptStudio(t) {
  const mounted = await mountAuditDom(t);
  const observed = (globalThis.__promptStudio = { calls: [], writes: [] });
  t.after(() => delete globalThis.__promptStudio);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-prompt-studio-test-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `const t = key => key; export const useTranslation = () => ({t});`,
      "/i18n": `export const normalizeUiLanguage = value => value; export default { getFixedT: () => (key, options) => options.defaultValue };`,
      "/hooks/usePolicy": `
        import { create } from "zustand";
        const policy = create(() => ({patch: {}}));
        globalThis.__promptStudio.policy = policy;
        export const usePolicySnapshot = () => policy();`,
      "/utils/agentName": `export const useAgentName = () => ({agentName: "Whisper"});`,
      "/models/ModelRegistry": `export const getModelProvider = () => "openai";`,
      "/utils/logger": `export default {debug() {}, error() {}};`,
      "/utils/snippets": `export const getDictionaryHintWords = settings => settings.customDictionary;`,
      "/helpers/dictationAgentInference": `export const resolveDictationAgentInference = settings => ({reachable: true, model: settings.dictationAgentModel || "auto", displayProvider: settings.dictationAgentProvider || "openwhispr", config: {provider: "openwhispr", customApiKey: settings.dictationAgentCustomApiKey, lanUrl: settings.dictationAgentRemoteUrl}});`,
      "/helpers/dictationTranslationInference": `export const resolveDictationTranslationInference = settings => ({reachable: true, model: settings.translationModel || "auto", displayProvider: settings.translationProvider || "openwhispr", config: {provider: "openwhispr", inferenceScope: "dictationTranslation", customApiKey: settings.translationCustomApiKey, lanUrl: settings.translationRemoteUrl}});`,
      "/stores/settingsStore": `
        import { create } from "zustand";
        export const useSettingsStore = create(set => ({
          uiLanguage: "en", preferredLanguage: "fr", isSignedIn: true,
          customDictionary: ["OpenWhispr"],
          cleanupMode: "openwhispr", cleanupCloudMode: "openwhispr",
          dictationAgentCloudMode: "openwhispr", translationCloudMode: "openwhispr",
          useCleanupModel: true, cleanupModel: "auto", cleanupDisableThinking: true,
          useDictationAgent: true, dictationAgentMode: "openwhispr", dictationAgentModel: "auto",
          useDictationTranslation: true, translationMode: "openwhispr", translationModel: "auto",
          translationTargetLanguage: "es", translationRemoteUrl: "",
          customPrompts: {cleanup: "Saved {{agentName}}", dictationAgent: "Saved {{agentName}}", translate: "Saved {{agentName}}"},
          setCustomPrompt: (kind, value) => {
            globalThis.__promptStudio.writes.push({kind, value});
            set(s => ({customPrompts: {...s.customPrompts, [kind]: value}}));
          },
        }));
        globalThis.__promptStudio.store = useSettingsStore;
        export const selectPolicyEffectiveSettings = (s, policy) => ({...s, ...policy.patch});
        export const selectIsCloudCleanupMode = s => s.isSignedIn && s.cleanupMode === "openwhispr" && s.cleanupCloudMode === "openwhispr";
        export const selectIsCloudDictationAgentMode = s => s.isSignedIn && s.dictationAgentMode === "openwhispr" && s.dictationAgentCloudMode === "openwhispr";
        export const selectIsCloudTranslationMode = s => s.isSignedIn && s.translationMode === "openwhispr" && s.translationCloudMode === "openwhispr";
      `,
      "/services/ReasoningService": `export default { processText(...args) {
        globalThis.__promptStudio.calls.push(args);
        return new Promise((resolve, reject) => { globalThis.__promptStudio.pending = {resolve, reject}; });
      }};`,
      "/hooks/useDialogs": `export const useDialogs = () => ({alertDialog: {}, showAlertDialog() {}, hideAlertDialog() {}});`,
      "./dialog": `export const AlertDialog = () => null;`,
      "./textarea": `export function Textarea(props) { if (props.rows === 16) globalThis.__promptStudio.edit = props; return null; }`,
    },
  });
  const { default: PromptStudio } = await vite.ssrLoadModule("/components/ui/PromptStudio.tsx");
  const { resolvePrompt } = await vite.ssrLoadModule("/config/prompts/index.ts");
  const click = async (label) => {
    const button = [...mounted.container.querySelectorAll("button")].find((node) =>
      node.textContent.includes(label)
    );
    assert.ok(button, `${label}: ${mounted.container.textContent}`);
    await React.act(async () => button.click());
  };
  return { ...mounted, observed, vite, PromptStudio, resolvePrompt, click };
}

module.exports = { mountPromptStudio };
