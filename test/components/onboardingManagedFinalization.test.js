const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { click, findElements, installManagedLocalTestDom } = require("./managedLocalTestDom");

const identity = {
  accountId: "account-1",
  workspaceId: "workspace-1",
  authGeneration: 7,
  configGeneration: 11,
};
const selection = { provider: "whisper", model: "base" };

test("managed onboarding finalization preserves the exact active admission fence", async (t) => {
  const pending = { ...identity, provider: "whisper", modelId: "base", transferState: "downloading" };
  const binding = { ...identity, category: "dictation", ...selection };
  const { window } = installBrowserGlobals(t, {
    initialStorage: {
      pendingLocalModelSelectionsV1: JSON.stringify({ dictation: pending }),
      enterpriseManagedLocalModelBindingsV1: JSON.stringify({ dictation: binding }),
    },
    window: {
      electronAPI: {
        saveAllKeysToEnv: async () => {},
        markBundleMigrated: async () => {},
        setOnboardingWindowMode: async () => {},
        setOnboardingActive: async () => {},
        getEffectiveDefaultHotkey: async () => "CommandOrControl+Shift+Space",
      },
    },
  });
  const { container } = installManagedLocalTestDom(t);
  let completions = 0;
  const nullComponent = `export default function Component() { return null; }`;
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-managed-finalization-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `const t = (key) => key; export const useTranslation = () => ({ t });`,
      "lucide-react": `export const AlertCircle = () => null;`,
      AuthenticationStep: nullComponent,
      EmailVerificationStep: nullComponent,
      UseCaseStep: nullComponent,
      CompactPermissionsStep: nullComponent,
      LanguageSelectionStep: nullComponent,
      ShortcutSetupStep: nullComponent,
      AssistantHotkeyPreview: nullComponent,
      DemoStep: nullComponent,
      CalendarConnectionsStep: nullComponent,
      SetupChoiceStep: nullComponent,
      ProviderSetupStep: `export const ByokProviderStep = () => null; export const LocalModelSetupStep = () => null;`,
      "/onboarding/OnboardingShell": `
        import React from "react";
        export const OnboardingStepHeader = () => null;
        export default function Shell({ children, onContinue }) {
          return React.createElement("main", null, children,
            onContinue ? React.createElement("button", { onClick: onContinue }, "Continue") : null);
        }
      `,
      "/ui/dialog": `export const AlertDialog = () => null;`,
      "/hooks/useAuth": `export const useAuth = () => ({ isSignedIn: true });`,
      "/hooks/usePermissions": `export const usePermissions = () => ({ micPermissionGranted: true, accessibilityPermissionGranted: true });`,
      "/hooks/useClipboard": `export const useClipboard = () => {};`,
      "/hooks/useSystemAudioPermission": `export const useSystemAudioPermission = () => ({});`,
      "/hooks/useLocalStorage": `export const useLocalStorage = () => [false, () => {}];`,
      "/hooks/useHotkeyRegistration": `export const useHotkeyRegistration = () => ({ registerHotkey: async () => true, isRegistering: false });`,
      "/hooks/useHotkeyModeInfo": `export const useHotkeyModeInfo = () => ({ isUsingNativeShortcut: false, supportsPushToTalk: true });`,
      "/hooks/useWorkspace": `export const useWorkspace = () => ({ active: { id: "workspace-1", plan: "enterprise", status: "active" }, workspaces: [], loaded: true, setActive() {} });`,
      "/hooks/useSettings": `export const useSettings = () => ({ dictationKey: "CommandOrControl+Shift+Space", voiceAgentKey: "CommandOrControl+Shift+V", activationMode: "tap", setActivationMode() {}, spokenLanguages: ["en"], onboardingUseCases: [], onboardingUseCaseNote: "", setDictationKey() {}, setPreferredLanguage() {}, setVoiceAgentKey: async () => true });`,
      "/stores/policyStore": `export const usePolicyStore = () => false;`,
      "/stores/policyRules": `export const isAgentAllowed = () => false;`,
      "/stores/settingsStore": `
        const state = { setCloudTranscriptionForAllScopes() {}, updateCleanupSettings() {}, setCloudReasoningForAllScopes() {} };
        export const useSettingsStore = () => state; useSettingsStore.getState = () => state;
      `,
      "/onboarding/useOnboardingSession": `
        const session = { version: 2, currentStepId: "notes", history: ["enterprise-models"], authPath: "account", setupMode: null, selfHostedRequested: false };
        export const useOnboardingSession = () => ({ session, setSession() {}, goTo() {}, goBack() {}, setAuthPath() {}, setSetupMode() {}, setSelfHostedRequested() {}, clearSession() {} });
      `,
      "/stores/enterpriseIdentityStore": `
        const state = { accountId: "account-1", workspaceId: "workspace-1", authGeneration: 7, status: "ready", verdict: "configured", failClosed: false, config: { generation: 11, localModels: { selections: [{ provider: "whisper", model: "base" }] } } };
        export const selectManagedLocalModelContext = () => ({ identity: { accountId: "account-1", workspaceId: "workspace-1", authGeneration: 7, configGeneration: 11 }, localModels: state.config.localModels });
        export const useEnterpriseIdentityStore = (selector) => selector(state); useEnterpriseIdentityStore.getState = () => state;
      `,
      ManagedEnterpriseModelCoordinator: nullComponent,
      ActivationModeSelector: `export const ActivationModeSelector = () => null;`,
      LinuxPttSetupInfo: nullComponent,
      "/services/cloudApi": `export const cloudPost = async () => {};`,
      "/utils/logger": `export default { warn() {}, error() {} };`,
      "/lib/auth": `export const signOut = async () => {};`,
    },
  });
  const [{ default: OnboardingFlow }, { resolveManagedLocalTranscriptionRuntime }] =
    await Promise.all([
      vite.ssrLoadModule("/components/OnboardingFlow.tsx"),
      vite.ssrLoadModule("/helpers/managedLocalTranscriptionRuntime.ts"),
    ]);
  const root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(OnboardingFlow, { onComplete: () => (completions += 1) }));
  });
  const continueButton = findElements(container, (element) => element.tagName === "BUTTON")[0];
  await React.act(async () => {
    click(continueButton);
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(completions, 1);
  assert.deepEqual(JSON.parse(localStorage.getItem("pendingLocalModelSelectionsV1")).dictation, pending);
  assert.deepEqual(JSON.parse(localStorage.getItem("enterpriseManagedLocalModelBindingsV1")).dictation, binding);
  assert.equal(localStorage.getItem("localSetupPending"), "true");
  assert.deepEqual(resolveManagedLocalTranscriptionRuntime({ isSignedIn: true }), {
    kind: "error",
    code: "MANAGED_LOCAL_MODEL_UNAVAILABLE",
  });
  await React.act(async () => root.unmount());
  assert.equal(window.localStorage, localStorage);
});
