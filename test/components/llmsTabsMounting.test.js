const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

test("requested LLM tabs and policy fallbacks persist through navigation actions", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-llm-tabs-test-",
  });
  const { createSettingsNavigationStore } = await vite.ssrLoadModule(
    "/stores/settingsNavigationStore.ts"
  );
  const navigation = createSettingsNavigationStore("meetings");
  const actions = navigation.getState();
  actions.selectLlmTab("dictationAgent");
  actions.openSettings("meetings");
  assert.equal(
    navigation.getState().llmTab,
    "noteFormatting",
    "a repeated route restores its selected tab"
  );
});

test("LLM keep-alive isolates retained editors from Settings section visibility", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    for (const key of [
      "__llmCounts",
      "__llmPolicyStore",
      "__llmSettingsStore",
      "__selectLlmTab",
      "__selectedLlmTab",
      "__agentDraft",
      "__setAgentDraft",
    ]) {
      delete globalThis[key];
    }
  });

  installBrowserGlobals(t, {
    initialStorage: { "settings.llmsTab": JSON.stringify("dictationCleanup") },
  });
  const container = installHostDom(t);
  globalThis.__llmCounts = {
    cleanupMounts: 0,
    agentMounts: 0,
    agentUnmounts: 0,
    translationMounts: 0,
    chatMounts: 0,
  };

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-llm-keep-alive-test-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        export function useTranslation() { return { t: (key) => key }; }
        export const initReactI18next = { type: "3rdParty", init() {} };
      `,
      "/components/icons": `
        export const BookOpen = () => null;
        export const Languages = () => null;
        export const MessageSquare = () => null;
        export const Sparkles = () => null;
        export const Wand2 = () => null;
      `,
      "/stores/policyStore": `
        import { create } from "zustand";
        const store = create(() => ({ agentAllowed: true }));
        globalThis.__llmPolicyStore = store;
        export const usePolicyStore = (selector) => store(selector);
      `,
      "/stores/policyRules": `export const isAgentAllowed = (state) => state.agentAllowed;`,
      "/stores/settingsStore": `
        import { create } from "zustand";
        export const useSettingsStore = create((set) => ({
          useCleanupModel: true,
          setUseCleanupModel: (value) => set({ useCleanupModel: value }),
          autoGenerateNoteTitle: false,
          setAutoGenerateNoteTitle: (value) => set({ autoGenerateNoteTitle: value }),
          modelVersion: 0,
        }));
        globalThis.__llmSettingsStore = useSettingsStore;
      `,
      "/ui/ProviderTabs": `
        export function ProviderTabs({ selectedId, onSelect }) {
          globalThis.__selectedLlmTab = selectedId;
          globalThis.__selectLlmTab = onSelect;
          return null;
        }
      `,
      "/ui/SettingsSection": `
        export const SettingsPanel = ({ children }) => children;
        export const SettingsPanelRow = ({ children }) => children;
        export const SettingsRow = ({ children }) => children;
        export const SectionHeader = () => null;
      `,
      "/ui/toggle": `export const Toggle = () => null;`,
      "/ui/useToast": `export const useToast = () => ({ toast() {} });`,
      "/ui/PromptStudio": `
        import { useEffect } from "react";
        export default function PromptStudio() {
          useEffect(() => { globalThis.__llmCounts.cleanupMounts += 1; }, []);
          return null;
        }
      `,
      "/DictationAgentSettings": `
        import { useEffect, useState } from "react";
        export default function DictationAgentSettings() {
          const [draft, setDraft] = useState("");
          globalThis.__agentDraft = draft;
          globalThis.__setAgentDraft = setDraft;
          useEffect(() => {
            globalThis.__llmCounts.agentMounts += 1;
            return () => { globalThis.__llmCounts.agentUnmounts += 1; };
          }, []);
          return null;
        }
      `,
      "/DictationTranslationSettings": `
        import { useEffect } from "react";
        export default function DictationTranslationSettings() {
          useEffect(() => { globalThis.__llmCounts.translationMounts += 1; }, []);
          return null;
        }
      `,
      "/ChatAgentSettings": `
        import { useEffect } from "react";
        export default function ChatAgentSettings() {
          useEffect(() => { globalThis.__llmCounts.chatMounts += 1; }, []);
          return null;
        }
      `,
      "/GpuDeviceSelector": `export default function GpuDeviceSelector() { return null; }`,
      "/InferenceConfigEditor": `
        export default function InferenceConfigEditor() {
          globalThis.__llmSettingsStore((state) => state.modelVersion);
          return null;
        }
      `,
    },
  });
  const { default: LlmsKeepAlive } = await vite.ssrLoadModule(
    "/components/settings/LlmsSection.tsx"
  );
  const { createSettingsNavigationStore } = await vite.ssrLoadModule(
    "/stores/settingsNavigationStore.ts"
  );
  const navigation = createSettingsNavigationStore(
    undefined,
    () => globalThis.__llmPolicyStore.getState().agentAllowed
  );
  const unsubscribe = globalThis.__llmPolicyStore.subscribe(() =>
    navigation.getState().reconcilePolicy()
  );
  t.after(unsubscribe);
  root = createRoot(container);
  const render = async (active, initialTab) =>
    React.act(async () => {
      navigation.getState().openSettings(active ? "llms" : "general");
      if (active && initialTab) navigation.getState().selectLlmTab(initialTab);
      root.render(React.createElement(LlmsKeepAlive, { navigation }));
    });

  await render(false);
  assert.equal(globalThis.__llmCounts.cleanupMounts, 0, "an unvisited section mounts no editor");

  await render(true);
  assert.equal(globalThis.__llmCounts.cleanupMounts, 1, "first entry mounts one editor");
  assert.equal(globalThis.__llmCounts.agentMounts, 0);

  await React.act(async () => globalThis.__selectLlmTab("dictationAgent"));
  assert.equal(globalThis.__selectedLlmTab, "dictationAgent");
  assert.equal(globalThis.__llmCounts.cleanupMounts, 1);
  assert.equal(globalThis.__llmCounts.agentMounts, 1, "a later first visit mounts only its editor");

  await React.act(async () => globalThis.__setAgentDraft("retained"));
  await render(false);
  await render(true);
  assert.equal(globalThis.__agentDraft, "retained", "a visited allowed editor retains local state");

  await React.act(async () => globalThis.__llmPolicyStore.setState({ agentAllowed: false }));
  assert.equal(globalThis.__selectedLlmTab, "dictationCleanup");
  assert.equal(globalThis.__llmCounts.agentUnmounts, 1, "a prohibited editor has no live effects");
  assert.equal(globalThis.__llmCounts.translationMounts, 0);
  assert.equal(globalThis.__llmCounts.chatMounts, 0);

  await React.act(async () => globalThis.__llmPolicyStore.setState({ agentAllowed: true }));
  assert.equal(globalThis.__llmCounts.agentMounts, 2, "reallowing remounts a visited editor");
  await render(true, "dictationTranslation");
  assert.equal(globalThis.__selectedLlmTab, "dictationTranslation");
  assert.equal(globalThis.__llmCounts.translationMounts, 1, "a new route mounts only its editor");
  assert.equal(globalThis.__llmCounts.chatMounts, 0);
  await React.act(async () => globalThis.__selectLlmTab("dictationAgent"));
  await render(true, "dictationTranslation", {});
  assert.equal(
    globalThis.__selectedLlmTab,
    "dictationTranslation",
    "repeat deep link selects retained tab"
  );
});
