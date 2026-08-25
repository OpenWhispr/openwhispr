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

async function flush() {
  await React.act(async () => new Promise((resolve) => setImmediate(resolve)));
}

async function mountManagedFlowAtPermissions(t) {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let lockRequests = 0;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      userAgent: "Macintosh",
      locks: {
        request: async (_name, callback) => {
          lockRequests += 1;
          return callback({ name: "managed-local" });
        },
      },
    },
  });
  t.after(() => {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
  });
  let resolveDownload;
  let downloadStarted = false;
  let installed = false;
  let whisperListenerRegistrations = 0;
  const whisperListeners = new Set();
  const initialSession = {
    version: 2,
    currentStepId: "enterprise-models",
    history: ["auth"],
    authPath: "account",
    setupMode: null,
    selfHostedRequested: false,
  };
  installBrowserGlobals(t, {
    initialStorage: { onboardingSessionV2: JSON.stringify(initialSession) },
    window: {
      electronAPI: {
        listWhisperModels: async () => ({
          models: [
            {
              model: "base",
              downloaded: installed,
              isDownloading: downloadStarted,
              downloadProgress: downloadStarted ? 20 : 0,
            },
          ],
        }),
        listParakeetModels: async () => ({ models: [] }),
        modelGetAll: async () => [],
        checkParakeetInstallation: async () => ({ supported: false }),
        downloadWhisperModel: async () => {
          downloadStarted = true;
          return new Promise((resolve) => {
            resolveDownload = resolve;
          });
        },
        cancelWhisperDownload: async () => {
          downloadStarted = false;
          resolveDownload({ success: false, code: "DOWNLOAD_CANCELLED" });
          return { success: true };
        },
        onWhisperDownloadProgress: (listener) => {
          whisperListenerRegistrations += 1;
          whisperListeners.add(listener);
          return () => whisperListeners.delete(listener);
        },
        onParakeetDownloadProgress: () => () => {},
        onModelDownloadProgress: () => () => {},
        setOnboardingWindowMode: async () => {},
        setOnboardingActive: async () => {},
        getEffectiveDefaultHotkey: async () => "CommandOrControl+Shift+Space",
      },
    },
  });
  const { container } = installManagedLocalTestDom(t);
  const nullComponent = `export default function Component() { return null; }`;
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-managed-recovery-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `const t = (key) => key; export const useTranslation = () => ({ t });`,
      "lucide-react": `export const AlertCircle = () => null; export const Check = () => null; export const Download = () => null; export const Loader2 = () => null;`,
      AuthenticationStep: nullComponent,
      EmailVerificationStep: nullComponent,
      UseCaseStep: nullComponent,
      CompactPermissionsStep: `export default function Permissions() { return "Permissions"; }`,
      LanguageSelectionStep: nullComponent,
      ShortcutSetupStep: nullComponent,
      AssistantHotkeyPreview: nullComponent,
      DemoStep: nullComponent,
      CalendarConnectionsStep: nullComponent,
      SetupChoiceStep: nullComponent,
      ProviderSetupStep: `export const ByokProviderStep = () => null; export const LocalModelSetupStep = () => null;`,
      OnboardingShell: `
        import React from "react";
        export const BrandMark = () => null;
        export const OnboardingStepHeader = ({ title }) => React.createElement("h1", null, title);
        export default function Shell({ children, persistentContent, onContinue, continueDisabled }) {
          return React.createElement("main", null, children, persistentContent,
            onContinue ? React.createElement("button", { disabled: continueDisabled, onClick: onContinue }, "Continue") : null);
        }
      `,
      "/ui/dialog": `
        import React from "react";
        export const AlertDialog = () => null;
        export const Dialog = ({ open, children }) => open ? React.createElement(React.Fragment, null, children) : null;
        export const DialogContent = ({ children }) => React.createElement("section", null, children);
        export const DialogHeader = ({ children }) => React.createElement("header", null, children);
        export const DialogTitle = ({ children }) => React.createElement("h2", null, children);
        export const DialogDescription = ({ children }) => React.createElement("p", null, children);
      `,
      "/ui/ProviderIcon": `export const ProviderIcon = () => null;`,
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
        export const clearMissingLocalModelSelections = () => {};
        export const useSettingsStore = () => state; useSettingsStore.getState = () => state;
      `,
      ActivationModeSelector: `export const ActivationModeSelector = () => null;`,
      LinuxPttSetupInfo: nullComponent,
      "/services/cloudApi": `export const cloudPost = async () => {};`,
      "/utils/logger": `export default { warn() {}, error() {} };`,
      "/lib/auth": `export const signOut = async () => {};`,
    },
  });
  const [flowModule, storeModule, trayModule, toastModule] = await Promise.all([
    vite.ssrLoadModule("/components/OnboardingFlow.tsx"),
    vite.ssrLoadModule("/stores/enterpriseIdentityStore.ts"),
    vite.ssrLoadModule("/components/onboarding/BackgroundModelDownloadTray.tsx"),
    vite.ssrLoadModule("/components/ui/useToast.ts"),
  ]);
  storeModule.useEnterpriseIdentityStore.setState({
    ...identity,
    status: "ready",
    verdict: "configured",
    failClosed: false,
    error: null,
    config: {
      generation: 11,
      localModels: { selections: [{ provider: "whisper", model: "base" }] },
    },
  });
  const toastValue = {
    toast: () => "toast",
    dismiss() {},
    toastCount: 0,
    dictationErrorActionCount: 0,
    dismissByPresentation() {},
  };
  const root = createRoot(container);
  await React.act(async () => {
    root.render(
      React.createElement(
        toastModule.ToastContext.Provider,
        { value: toastValue },
        React.createElement(
          React.Fragment,
          null,
          React.createElement(flowModule.default, { onComplete: () => assert.fail("not final") }),
          React.createElement(trayModule.default)
        )
      )
    );
  });
  await flush();
  await flush();
  assert.equal(downloadStarted, true);
  await React.act(async () => {
    for (const listener of whisperListeners) {
      listener(null, { model: "base", type: "progress", percentage: 20 });
    }
    await new Promise((resolve) => setImmediate(resolve));
  });

  const continueButton = findElements(
    container,
    (element) => element.tagName === "BUTTON" && element.textContent === "Continue"
  )[0];
  assert.ok(continueButton);
  await React.act(async () => click(continueButton));
  await flush();
  assert.match(container.textContent, /Permissions/);
  assert.ok(findElements(container, (element) => element.getAttribute("hidden") === "").length > 0);
  assert.equal(lockRequests, 1);
  assert.equal(whisperListenerRegistrations, 2);
  assert.equal(whisperListeners.size, 2);

  return {
    container,
    root,
    completeDownload() {
      installed = true;
      downloadStarted = false;
      resolveDownload({ success: true });
      for (const listener of whisperListeners) {
        listener(null, { model: "base", type: "complete", percentage: 100 });
      }
    },
  };
}

test("a managed transfer failure after Continue returns the mounted flow to recovery", async (t) => {
  const { container, root } = await mountManagedFlowAtPermissions(t);

  const cancelButton = findElements(
    container,
    (element) =>
      element.tagName === "BUTTON" &&
      element.getAttribute("aria-label") === "onboarding.rehaul.local.cancelDownload"
  )[0];
  assert.ok(cancelButton);
  await React.act(async () => {
    click(cancelButton);
    await new Promise((resolve) => setImmediate(resolve));
  });
  await flush();
  await flush();

  const session = JSON.parse(localStorage.getItem("onboardingSessionV2"));
  const pending = JSON.parse(localStorage.getItem("pendingLocalModelSelectionsV1"));
  assert.equal(session.currentStepId, "enterprise-models");
  assert.equal(pending.dictation.transferState, "missing");
  assert.equal(pending.dictation.errorCode, "DOWNLOAD_CANCELLED");
  assert.match(container.textContent, /onboarding\.managedLocal\.recovery\.title/);
  assert.match(container.textContent, /common\.retry/);
  assert.match(container.textContent, /settingsPage\.account\.signOut\.signOut/);
  await React.act(async () => root.unmount());
});

test("a healthy managed transfer completion after Continue stays on the later step", async (t) => {
  const { completeDownload, container, root } = await mountManagedFlowAtPermissions(t);
  await React.act(async () => {
    completeDownload();
    await new Promise((resolve) => setImmediate(resolve));
  });
  await flush();
  await flush();

  const session = JSON.parse(localStorage.getItem("onboardingSessionV2"));
  const pending = JSON.parse(localStorage.getItem("pendingLocalModelSelectionsV1") ?? "{}");
  assert.equal(session.currentStepId, "permissions");
  assert.equal(pending.dictation, undefined);
  assert.match(container.textContent, /Permissions/);
  assert.doesNotMatch(container.textContent, /onboarding\.managedLocal\.recovery\.title/);
  await React.act(async () => root.unmount());
});
