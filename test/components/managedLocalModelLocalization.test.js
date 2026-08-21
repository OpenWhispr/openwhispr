const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");

const english = require("../../src/locales/en/translation.json");
const japanese = require("../../src/locales/ja/translation.json");

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      const callbacks = listeners.get(type) ?? new Set();
      callbacks.add(listener);
      listeners.set(type, callbacks);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) ?? []) listener(event);
      return true;
    },
  };
}

async function initializeTranslations(vite, language) {
  const [{ default: i18n }, { initReactI18next }] = await Promise.all([
    vite.ssrLoadModule("i18next"),
    vite.ssrLoadModule("react-i18next"),
  ]);
  await i18n.use(initReactI18next).init({
    lng: language,
    fallbackLng: "en",
    resources: {
      en: { translation: english },
      ja: { translation: japanese },
    },
    interpolation: { escapeValue: false },
  });
  return i18n;
}

const iconMocks = {
  "lucide-react": `
    import React from "react";
    const Icon = () => React.createElement("span");
    export const AlertCircle = Icon;
    export const Check = Icon;
    export const Download = Icon;
    export const Loader2 = Icon;
    export const Lock = Icon;
    export const RotateCcw = Icon;
  `,
  "/ui/ProviderIcon": `
    import React from "react";
    export function ProviderIcon() { return React.createElement("span"); }
  `,
};

test("managed model notice renders the active non-English locale", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-managed-model-notice-localization-",
    mockModules: {
      ...iconMocks,
      "/models/ModelRegistry": `
        export function getParakeetModelInfo() { return null; }
        export function getWhisperModelInfo() { return null; }
        export const modelRegistry = { getModel() { return null; } };
      `,
    },
  });
  await initializeTranslations(vite, "ja");
  const { ManagedLocalModelNotice } = await vite.ssrLoadModule(
    "/components/settings/ManagedLocalModelNotice.tsx"
  );

  const html = renderToStaticMarkup(
    React.createElement(ManagedLocalModelNotice, { selection: null })
  );

  assert.match(html, /会社のモデル設定を待機中/);
  assert.match(html, /会社によって管理されています/);
  assert.doesNotMatch(html, /Waiting for company model setup|Managed by your company/);
});

test("a persisted managed-model error follows an in-app locale change", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const events = eventTarget();
  installBrowserGlobals(t, {
    initialStorage: {
      enterpriseManagedLocalModelBindingsV1: JSON.stringify({
        "account-1:workspace-1": {
          configVersion: 3,
          transcription: { provider: "whisper", modelId: "base" },
          reasoning: null,
          error: "MANAGED_LOCAL_MODEL_POLICY_TRANSCRIPTION",
        },
      }),
    },
    window: {
      ...events,
      setTimeout,
      clearTimeout,
      electronAPI: {
        checkParakeetInstallation: async () => ({ supported: true }),
        listWhisperModels: async () => ({
          models: [{ model: "base", downloaded: true, isDownloading: false }],
        }),
        listParakeetModels: async () => ({ models: [] }),
        modelGetAll: async () => [],
      },
    },
  });
  const container = installInteractiveDom(t);
  globalThis.CustomEvent = class {
    constructor(type) {
      this.type = type;
    }
  };
  t.after(() => delete globalThis.CustomEvent);
  globalThis.__managedLocalizationEnterpriseState = {
    accountId: "account-1",
    workspaceId: "workspace-1",
    authGeneration: 7,
    config: {
      version: 3,
      transcription: [{ provider: "whisper", modelId: "base" }],
      reasoning: [],
    },
  };
  t.after(() => delete globalThis.__managedLocalizationEnterpriseState);

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-managed-model-error-localization-",
    mockModules: {
      ...iconMocks,
      "/ui/button": `
        import React from "react";
        export function Button(props) { return React.createElement("button", props); }
      `,
      "/hooks/useModelDownload": `
        export function useModelDownload() {
          return {
            hasHydratedDownloads: true,
            isDownloading: false,
            isDownloadingModel() { return false; },
            async downloadModel() { return "started"; },
          };
        }
      `,
      "/hooks/usePolicy": `
        export function usePolicySnapshot() { return {}; }
      `,
      "/stores/policyRules": `
        export function isAgentAllowed() { return true; }
        export function isModeAllowedByPolicy() { return true; }
      `,
      "/stores/policyStore": `
        export function usePolicyStore(selector) { return selector({}); }
        usePolicyStore.getState = () => ({});
      `,
      "/stores/enterpriseIdentityStore": `
        export function selectEffectiveManagedLocalModels(state) { return state.config; }
        export function useEnterpriseIdentityStore(selector) {
          return selector(globalThis.__managedLocalizationEnterpriseState);
        }
        useEnterpriseIdentityStore.getState = () => globalThis.__managedLocalizationEnterpriseState;
      `,
      "/models/ModelRegistry": `
        export function getParakeetModelInfo() { return null; }
        export function getWhisperModelInfo(modelId) {
          return modelId === "base" ? { name: "Whisper Base", size: "150 MB" } : null;
        }
        export const modelRegistry = { getModel() { return null; } };
      `,
      "/managedLocalModelSettings": `
        export function enforceManagedLocalModelSettings() {}
      `,
    },
  });
  const i18n = await initializeTranslations(vite, "en");
  const { default: EnterpriseModelSetupStep } = await vite.ssrLoadModule(
    "/components/onboarding/EnterpriseModelSetupStep.tsx"
  );
  const props = {
    identity: {
      accountId: "account-1",
      workspaceId: "workspace-1",
      authGeneration: 7,
      configVersion: 3,
    },
    config: globalThis.__managedLocalizationEnterpriseState.config,
    onReadinessChange() {},
  };
  root = createRoot(container);

  await React.act(async () => {
    root.render(React.createElement(EnterpriseModelSetupStep, props));
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.match(
    container.textContent,
    /A stricter company policy blocks the required local dictation model/
  );

  await React.act(async () => {
    await i18n.changeLanguage("ja");
    await new Promise((resolve) => setImmediate(resolve));
  });

  assert.match(container.textContent, /必須のローカル音声入力モデル/);
  assert.match(container.textContent, /音声入力.*会社が承認した音声モデル/);
  assert.match(container.textContent, /再試行/);
  assert.doesNotMatch(
    container.textContent,
    /A stricter company policy blocks|Dictation|Retry|MANAGED_LOCAL_MODEL_POLICY_TRANSCRIPTION/
  );

  localStorage.setItem(
    "enterpriseManagedLocalModelBindingsV1",
    JSON.stringify({
      "account-1:workspace-1": {
        configVersion: 3,
        transcription: { provider: "whisper", modelId: "base" },
        reasoning: null,
        error: "The model host returned status 503.",
      },
    })
  );
  await React.act(async () => {
    globalThis.window.dispatchEvent(new CustomEvent("openwhispr-managed-local-model-binding"));
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.match(container.textContent, /The model host returned status 503\./);
});

test("the real onboarding error route localizes known identity failures", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        setOnboardingActive: async () => {},
        setOnboardingWindowMode: async () => {},
        getEffectiveDefaultHotkey: async () => "",
        onHotkeyFallbackUsed: () => () => {},
      },
    },
  });
  const container = installInteractiveDom(t);
  globalThis.__onboardingLocalizationIdentity = {
    accountId: "account-1",
    workspaceId: "workspace-1",
    authGeneration: 7,
    status: "error",
    config: null,
    error: "SSO_REQUIRED",
    refresh() {},
  };
  t.after(() => delete globalThis.__onboardingLocalizationIdentity);

  const emptyComponent = `
    import React from "react";
    export default function Empty() { return null; }
  `;
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-onboarding-error-localization-",
    noExternal: ["react-i18next"],
    mockModules: {
      ...iconMocks,
      "/AuthenticationStep": emptyComponent,
      "/EmailVerificationStep": emptyComponent,
      "/onboarding/UseCaseStep": emptyComponent,
      "/onboarding/CompactPermissionsStep": emptyComponent,
      "/onboarding/LanguageSelectionStep": emptyComponent,
      "/onboarding/ShortcutSetupStep": emptyComponent,
      "/onboarding/AssistantHotkeyPreview": emptyComponent,
      "/onboarding/DemoStep": emptyComponent,
      "/onboarding/CalendarConnectionsStep": emptyComponent,
      "/onboarding/SetupChoiceStep": emptyComponent,
      "/ui/LinuxPttSetupInfo": emptyComponent,
      "/onboarding/EnterpriseModelSetupStep": emptyComponent,
      "/onboarding/useCases": `export function hasUseCaseIntent() { return false; }`,
      "/onboarding/OnboardingShell": `
        import React from "react";
        export default function OnboardingShell({ children }) {
          return React.createElement("main", null, children);
        }
        export function OnboardingStepHeader() { return null; }
      `,
      "/onboarding/ProviderSetupStep": `
        export function ByokProviderStep() { return null; }
        export function LocalModelSetupStep() { return null; }
      `,
      "/ui/dialog": `export function AlertDialog() { return null; }`,
      "/ui/button": `
        import React from "react";
        export function Button(props) { return React.createElement("button", props); }
      `,
      "/hooks/useAuth": `export function useAuth() { return { isSignedIn: true }; }`,
      "/lib/auth": `export async function signOut() {}`,
      "/hooks/usePermissions": `
        export function usePermissions() { return { micPermissionGranted: true, accessibilityPermissionGranted: true }; }
      `,
      "/hooks/useClipboard": `export function useClipboard() {}`,
      "/hooks/useSystemAudioPermission": `export function useSystemAudioPermission() { return {}; }`,
      "/hooks/useSettings": `
        const settings = {
          dictationKey: "",
          voiceAgentKey: "",
          activationMode: "tap",
          setActivationMode() {},
          onboardingUseCases: [],
          onboardingUseCaseNote: "",
          spokenLanguages: [],
          setPreferredLanguage() {},
          setVoiceAgentKey: async () => true,
        };
        export function useSettings() { return settings; }
      `,
      "/hooks/useLocalStorage": `export function useLocalStorage() { return [false, () => {}]; }`,
      "/hooks/useHotkeyRegistration": `
        export function useHotkeyRegistration() {
          return { registerHotkey: async () => true, isRegistering: false };
        }
      `,
      "/hooks/useHotkeyModeInfo": `
        export function useHotkeyModeInfo() { return { isUsingNativeShortcut: false, supportsPushToTalk: true }; }
      `,
      "/hooks/useWorkspace": `
        const workspace = { id: "workspace-1", plan: "enterprise" };
        export function useWorkspace() {
          return { active: workspace, workspaces: [workspace], loaded: true, setActive() {} };
        }
      `,
      "/stores/policyStore": `
        export function usePolicyStore(selector) { return selector({}); }
      `,
      "/stores/policyRules": `export function isAgentAllowed() { return true; }`,
      "/stores/settingsStore": `
        const state = {
          setCloudReasoningForAllScopes() {},
          setCloudTranscriptionForAllScopes() {},
          updateCleanupSettings() {},
        };
        export function useSettingsStore() { return state; }
        useSettingsStore.getState = () => state;
      `,
      "/utils/hotkeys": `
        export function getDefaultHotkey() { return "CommandOrControl+Space"; }
        export function parseHotkeyList(value) { return value ? [value] : []; }
        export function serializeHotkeyList(value) { return value.join(","); }
      `,
      "/onboarding/hotkeyPresentation": `export function formatHotkeyInstruction(value) { return value; }`,
      "/utils/hotkeyValidator": `export function getValidationMessage() { return null; }`,
      "/utils/hotkeyValidation": `export function validateHotkeyForSlot() { return null; }`,
      "/utils/platform": `export function getPlatform() { return "linux"; }`,
      "/utils/permissions": `
        export const ACCESSIBILITY_SKIPPED_KEY = "accessibilitySkipped";
        export function areRequiredPermissionsMet() { return true; }
      `,
      "/services/cloudApi": `export async function cloudPost() {}`,
      "/utils/logger": `export default { warn() {}, error() {} };`,
      "/onboarding/flow": `
        export const COMPACT_STEPS = new Set();
        export function getNextOnboardingStep() { return null; }
        export function getOnboardingProgress() { return { current: 1, total: 1 }; }
        export function getOnboardingRoute() { return ["auth"]; }
        export function reconcileStepWithRoute() { return "auth"; }
        export function resolveEnterpriseWorkspaceForOnboarding(active) { return active; }
        export function shouldSkipOnboardingSetupChoice() { return true; }
      `,
      "/onboarding/useOnboardingSession": `
        const session = { currentStepId: "auth", authPath: "account", setupMode: null, history: [] };
        export function useOnboardingSession() {
          return {
            session,
            setSession() {},
            goTo() {},
            goBack() {},
            setAuthPath() {},
            setSetupMode() {},
            setSelfHostedRequested() {},
            clearSession() {},
          };
        }
      `,
      "/onboarding/pendingLocalModels": `
        export function clearPendingLocalModels() {}
        export function hasPendingLocalModels() { return false; }
      `,
      "/ui/ActivationModeSelector": `export function ActivationModeSelector() { return null; }`,
      "/onboarding/ManagedSetupBlockedActions": `
        import React from "react";
        export function EnterpriseConfigErrorActions() {
          return React.createElement("button", null, "actions");
        }
      `,
      "/stores/enterpriseIdentityStore": `
        export function selectEffectiveManagedLocalModels(state) { return state.config?.localModels ?? null; }
        export function useEnterpriseIdentityStore(selector) {
          const state = globalThis.__onboardingLocalizationIdentity;
          return selector ? selector(state) : state;
        }
      `,
    },
  });
  const i18n = await initializeTranslations(vite, "en");
  const { default: OnboardingFlow } = await vite.ssrLoadModule("/components/OnboardingFlow.tsx");
  root = createRoot(container);

  await React.act(async () => {
    root.render(React.createElement(OnboardingFlow, { onComplete() {} }));
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.match(container.textContent, /Company SSO is required/);
  assert.doesNotMatch(container.textContent, /SSO_REQUIRED/);

  await React.act(async () => {
    await i18n.changeLanguage("ja");
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.match(container.textContent, /会社の SSO が必要です/);
  assert.doesNotMatch(container.textContent, /Company SSO is required/);

  globalThis.__onboardingLocalizationIdentity = {
    ...globalThis.__onboardingLocalizationIdentity,
    error: "MANAGED_CONFIG_UNAVAILABLE",
  };
  await React.act(async () => {
    root.render(React.createElement(OnboardingFlow, { onComplete() {} }));
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.match(container.textContent, /会社のモデル設定を読み込めませんでした/);
  assert.doesNotMatch(container.textContent, /MANAGED_CONFIG_UNAVAILABLE/);

  globalThis.__onboardingLocalizationIdentity = {
    ...globalThis.__onboardingLocalizationIdentity,
    error: "The enterprise gateway returned status 502.",
  };
  await React.act(async () => {
    root.render(React.createElement(OnboardingFlow, { onComplete() {} }));
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.match(container.textContent, /The enterprise gateway returned status 502\./);
});
