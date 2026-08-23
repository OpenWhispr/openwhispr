const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { click, findElement, installInteractiveDom } = require("../lib/interactiveDom");

const identity = {
  accountId: "account-1",
  workspaceId: "workspace-1",
  authGeneration: 7,
  configVersion: 3,
};
const nvidia = { provider: "nvidia", modelId: "parakeet-tdt-0.6b-v3" };
const whisper = { provider: "whisper", modelId: "base" };
const config = { version: 3, transcription: [nvidia, whisper], reasoning: [] };

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

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

function modelDownloadMock() {
  return `
    const downloads = new Map();
    const active = new Map();
    globalThis.__resetManagedSetupDownloadState = () => {
      for (const activeModels of active.values()) activeModels.clear();
    };
    export function useModelDownload({ modelType }) {
      if (downloads.has(modelType)) return downloads.get(modelType);
      const activeModels = new Set();
      active.set(modelType, activeModels);
      const download = {
        hasHydratedDownloads: true,
        get isDownloading() { return activeModels.size > 0; },
        isDownloadingModel(modelId) { return activeModels.has(modelId); },
        async downloadModel(modelId, onComplete) {
          activeModels.add(modelId);
          globalThis.__managedSetupDownloads.push({ modelType, modelId });
          return 'started';
        },
      };
      downloads.set(modelType, download);
      return download;
    }
  `;
}

function commonMocks() {
  return {
    "react-i18next": `
      const labels = {
        "common.download": "Download",
        "common.retry": "Retry",
        "common.continue": "Continue",
        "managedLocalModels.compatibility.checking": "Checking device compatibility…",
        "managedLocalModels.compatibility.unavailable": "Device compatibility could not be verified.",
        "managedLocalModels.compatibility.unsupported": "This model is not supported on this device.",
        "onboarding.rehaul.local.downloadingShort": "Downloading",
        "onboarding.rehaul.local.selected": "Selected",
        "onboarding.rehaul.local.use": "Use",
      };
      export function useTranslation() {
        return { t(key) { return labels[key] ?? key; } };
      }
    `,
    "lucide-react": `
      import React from 'react';
      const Icon = () => React.createElement('span');
      export const AlertCircle = Icon;
      export const Check = Icon;
      export const Download = Icon;
      export const Loader2 = Icon;
      export const RotateCcw = Icon;
    `,
    "/ui/button": `
      import React from 'react';
      export function Button(props) { return React.createElement('button', props); }
    `,
    "/ui/dialog": `
      import React from "react";
      const dialogState = {
        dismissalRequests: 0,
        onOpenChange() {},
      };
      function createCancelableEvent() {
        return {
          cancelable: true,
          defaultPrevented: false,
          preventDefault() {
            if (this.cancelable) this.defaultPrevented = true;
          },
        };
      }
      function requestDismiss(handler) {
        const event = createCancelableEvent();
        handler?.(event);
        if (!event.defaultPrevented) {
          dialogState.dismissalRequests += 1;
          dialogState.onOpenChange(false);
        }
        return event;
      }
      export function Dialog({ open, onOpenChange, children }) {
        dialogState.onOpenChange = onOpenChange;
        return open ? children : null;
      }
      export function DialogContent({
        children,
        overlayClassName,
        onPointerDownOutside,
        onEscapeKeyDown,
        onFocusOutside,
        ...props
      }) {
        globalThis.__managedSetupDialogInteractions = {
          escape() { return requestDismiss(onEscapeKeyDown); },
          pointerOutside() { return requestDismiss(onPointerDownOutside); },
          focusOutside() { return requestDismiss(onFocusOutside); },
          get dismissalRequests() { return dialogState.dismissalRequests; },
        };
        return React.createElement("section", {
          ...props,
          "data-managed-setup-dialog": "true",
        }, children);
      }
      export function DialogTitle(props) {
        return React.createElement("h2", props);
      }
      export function DialogDescription(props) {
        return React.createElement("p", props);
      }
    `,
    "/ui/ProviderIcon": `
      import React from 'react';
      export function ProviderIcon() { return React.createElement('span'); }
    `,
    "/hooks/useModelDownload": modelDownloadMock(),
    "/hooks/usePolicy": `
      const policy = {};
      export function usePolicySnapshot() { return policy; }
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
        return selector(globalThis.__managedSetupEnterpriseState);
      }
      useEnterpriseIdentityStore.getState = () => globalThis.__managedSetupEnterpriseState;
    `,
    "/models/ModelRegistry": `
      export function getParakeetModelInfo(modelId) {
        return modelId === 'parakeet-tdt-0.6b-v3'
          ? { name: 'Parakeet', size: '600 MB' }
          : null;
      }
      export function getWhisperModelInfo(modelId) {
        return modelId === 'base' ? { name: 'Whisper Base', size: '150 MB' } : null;
      }
      export const modelRegistry = { getModel() { return null; } };
    `,
    "/managedLocalModelSettings": `
      export function enforceManagedLocalModelSettings() {}
      export function reconcileManagedLocalModelSettings() {}
    `,
  };
}

async function flush() {
  await React.act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });
}

function buttonFor(container, label) {
  return findElement(
    container,
    (element) => element.tagName === "BUTTON" && element.textContent.includes(label)
  );
}

test("NVIDIA stays non-interactive until capability resolves supported", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const capability = deferred();
  let capabilityPromise = capability.promise;
  const events = eventTarget();
  installBrowserGlobals(t, {
    window: {
      ...events,
      setTimeout,
      clearTimeout,
      electronAPI: {
        checkParakeetInstallation: () => capabilityPromise,
        listWhisperModels: async () => ({ models: [] }),
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
  globalThis.__managedSetupDownloads = [];
  globalThis.__managedSetupEnterpriseState = { ...identity, config };
  t.after(() => {
    delete globalThis.__managedSetupDownloads;
    delete globalThis.__managedSetupDialogInteractions;
    delete globalThis.__managedSetupEnterpriseState;
    delete globalThis.__resetManagedSetupDownloadState;
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-enterprise-setup-capability-",
    noExternal: ["react-i18next"],
    mockModules: commonMocks(),
  });
  const { default: EnterpriseModelSetupStep } = await vite.ssrLoadModule(
    "/components/onboarding/EnterpriseModelSetupStep.tsx"
  );
  root = createRoot(container);

  await React.act(async () => {
    root.render(
      React.createElement(EnterpriseModelSetupStep, {
        identity,
        config,
        onReadinessChange() {},
      })
    );
  });
  await flush();

  const pendingButton = buttonFor(container, "Download");
  assert.ok(pendingButton);
  assert.equal(pendingButton.getAttribute("disabled"), "");
  assert.match(container.textContent, /Checking device compatibility/);
  click(pendingButton);
  await flush();
  assert.deepEqual(globalThis.__managedSetupDownloads, []);

  await React.act(async () => {
    capability.resolve({ supported: true });
    await new Promise((resolve) => setImmediate(resolve));
  });
  const supportedButton = buttonFor(container, "Download");
  assert.equal(supportedButton.getAttribute("disabled"), null);
  await React.act(async () => {
    click(supportedButton);
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.deepEqual(globalThis.__managedSetupDownloads, [
    { modelType: "parakeet", modelId: "parakeet-tdt-0.6b-v3" },
  ]);

  const nextIdentityCapability = deferred();
  globalThis.__resetManagedSetupDownloadState();
  capabilityPromise = nextIdentityCapability.promise;
  const nextIdentity = { ...identity, workspaceId: "workspace-2" };
  globalThis.__managedSetupEnterpriseState = { ...nextIdentity, config };
  await React.act(async () => {
    root.render(
      React.createElement(EnterpriseModelSetupStep, {
        identity: nextIdentity,
        config,
        onReadinessChange() {},
      })
    );
    await new Promise((resolve) => setImmediate(resolve));
  });
  const nextIdentityButton = buttonFor(container, "Download");
  assert.equal(nextIdentityButton.getAttribute("disabled"), "");
  assert.match(container.textContent, /Checking device compatibility/);
});

test("coordinator waits for capability, then chooses the exact supported fallback", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const capability = deferred();
  const events = eventTarget();
  const initialBinding = {
    configVersion: 3,
    transcription: nvidia,
    reasoning: null,
    error: null,
  };
  installBrowserGlobals(t, {
    initialStorage: {
      onboardingCompleted: "true",
      enterpriseManagedLocalModelBindingsV1: JSON.stringify({
        "account-1:workspace-1": initialBinding,
      }),
    },
    window: {
      ...events,
      setTimeout,
      clearTimeout,
      electronAPI: {
        checkParakeetInstallation: () => capability.promise,
        listWhisperModels: async () => ({ models: [] }),
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
  globalThis.__managedSetupDownloads = [];
  globalThis.__managedSetupEnterpriseState = { ...identity, config };
  t.after(() => {
    delete globalThis.__managedSetupDownloads;
    delete globalThis.__managedSetupEnterpriseState;
    delete globalThis.__resetManagedSetupDownloadState;
  });
  const mocks = commonMocks();
  mocks["/EnterpriseModelSetupStep"] =
    "export default function EnterpriseModelSetupStep() { return null; }";
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-enterprise-coordinator-capability-",
    noExternal: ["react-i18next"],
    mockModules: mocks,
  });
  const { default: ManagedEnterpriseModelCoordinator } = await vite.ssrLoadModule(
    "/components/onboarding/ManagedEnterpriseModelCoordinator.tsx"
  );
  root = createRoot(container);

  await React.act(async () => {
    root.render(React.createElement(ManagedEnterpriseModelCoordinator, { showUi: false }));
  });
  await flush();
  await flush();

  assert.deepEqual(globalThis.__managedSetupDownloads, []);
  assert.deepEqual(
    JSON.parse(localStorage.getItem("enterpriseManagedLocalModelBindingsV1"))[
      "account-1:workspace-1"
    ],
    initialBinding
  );

  await React.act(async () => {
    capability.resolve({ supported: false, message: "Unsupported device" });
    await new Promise((resolve) => setImmediate(resolve));
  });
  await flush();

  const binding = JSON.parse(localStorage.getItem("enterpriseManagedLocalModelBindingsV1"))[
    "account-1:workspace-1"
  ];
  assert.deepEqual(binding.transcription, whisper);
  assert.equal(binding.error, null);
  assert.deepEqual(globalThis.__managedSetupDownloads, [{ modelType: "whisper", modelId: "base" }]);

  globalThis.__resetManagedSetupDownloadState();
  globalThis.__managedSetupEnterpriseState = {
    ...identity,
    authGeneration: 8,
    config,
  };
  localStorage.setItem(
    "enterpriseManagedLocalModelBindingsV1",
    JSON.stringify({ "account-1:workspace-1": initialBinding })
  );
  await React.act(async () => {
    root.render(React.createElement(ManagedEnterpriseModelCoordinator, { showUi: false }));
    await new Promise((resolve) => setImmediate(resolve));
  });
  await flush();

  const reboundForNewGeneration = JSON.parse(
    localStorage.getItem("enterpriseManagedLocalModelBindingsV1")
  )["account-1:workspace-1"];
  assert.deepEqual(reboundForNewGeneration.transcription, whisper);
  assert.deepEqual(globalThis.__managedSetupDownloads, [
    { modelType: "whisper", modelId: "base" },
    { modelType: "whisper", modelId: "base" },
  ]);

  const incompatibleConfig = { version: 4, transcription: [nvidia], reasoning: [] };
  globalThis.__managedSetupEnterpriseState = {
    ...identity,
    authGeneration: 8,
    configVersion: 4,
    config: incompatibleConfig,
  };
  localStorage.setItem(
    "enterpriseManagedLocalModelBindingsV1",
    JSON.stringify({
      "account-1:workspace-1": {
        configVersion: 4,
        transcription: nvidia,
        reasoning: null,
        error: null,
      },
    })
  );
  await React.act(async () => {
    root.render(React.createElement(ManagedEnterpriseModelCoordinator, { showUi: false }));
    await new Promise((resolve) => setImmediate(resolve));
  });
  await flush();

  const incompatibleBinding = JSON.parse(
    localStorage.getItem("enterpriseManagedLocalModelBindingsV1")
  )["account-1:workspace-1"];
  assert.equal(incompatibleBinding.transcription, null);
  assert.equal(incompatibleBinding.error, "MANAGED_LOCAL_MODEL_INCOMPATIBLE_TRANSCRIPTION");
  assert.deepEqual(globalThis.__managedSetupDownloads, [
    { modelType: "whisper", modelId: "base" },
    { modelType: "whisper", modelId: "base" },
  ]);
});

test("a new auth generation cannot inherit dismissed or ready managed setup UI", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const events = eventTarget();
  installBrowserGlobals(t, {
    initialStorage: { onboardingCompleted: "true" },
    window: {
      ...events,
      setTimeout,
      clearTimeout,
      electronAPI: {
        checkParakeetInstallation: async () => ({ supported: true }),
        listWhisperModels: async () => ({ models: [] }),
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
  globalThis.__managedSetupDownloads = [];
  globalThis.__managedSetupAutoReady = true;
  globalThis.__managedSetupEnterpriseState = {
    ...identity,
    config: { version: 3, transcription: [whisper], reasoning: [] },
  };
  t.after(() => {
    delete globalThis.__managedSetupDownloads;
    delete globalThis.__managedSetupAutoReady;
    delete globalThis.__managedSetupEnterpriseState;
    delete globalThis.__resetManagedSetupDownloadState;
  });
  const mocks = commonMocks();
  mocks["react-i18next"] = `
    export function useTranslation() {
      return { t(key) { return key === "common.continue" ? "Continue" : key; } };
    }
  `;
  mocks["/lib/auth"] = "export async function signOut() {}";
  mocks["/EnterpriseModelSetupStep"] = `
    import { useEffect } from 'react';
    export default function EnterpriseModelSetupStep({ onReadinessChange }) {
      useEffect(() => {
        if (globalThis.__managedSetupAutoReady) onReadinessChange(true);
      }, [onReadinessChange]);
      return null;
    }
  `;
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-enterprise-coordinator-generation-ui-",
    noExternal: ["react-i18next"],
    mockModules: mocks,
  });
  const { default: ManagedEnterpriseModelCoordinator } = await vite.ssrLoadModule(
    "/components/onboarding/ManagedEnterpriseModelCoordinator.tsx"
  );
  root = createRoot(container);

  await React.act(async () => {
    root.render(React.createElement(ManagedEnterpriseModelCoordinator, { showUi: true }));
    await new Promise((resolve) => setImmediate(resolve));
  });
  const initialContinue = buttonFor(container, "Continue");
  assert.ok(initialContinue);
  assert.equal(initialContinue.getAttribute("disabled"), null);
  await React.act(async () => click(initialContinue));
  assert.equal(buttonFor(container, "Continue"), null);

  globalThis.__managedSetupAutoReady = false;
  globalThis.__managedSetupEnterpriseState = {
    ...globalThis.__managedSetupEnterpriseState,
    authGeneration: 8,
  };
  await React.act(async () => {
    root.render(React.createElement(ManagedEnterpriseModelCoordinator, { showUi: true }));
    await new Promise((resolve) => setImmediate(resolve));
  });

  const nextGenerationContinue = findElement(
    container,
    (element) => element.tagName === "BUTTON" && element.getAttribute("disabled") === ""
  );
  assert.notEqual(nextGenerationContinue, null);
  assert.equal(nextGenerationContinue.getAttribute("disabled"), "");
});

test("focused managed setup is a non-dismissible labeled dialog with a busy Continue action", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const events = eventTarget();
  installBrowserGlobals(t, {
    initialStorage: { onboardingCompleted: "true" },
    window: {
      ...events,
      setTimeout,
      clearTimeout,
      electronAPI: {
        checkParakeetInstallation: async () => ({ supported: true }),
        listWhisperModels: async () => ({ models: [] }),
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
  globalThis.__managedSetupDownloads = [];
  globalThis.__managedSetupEnterpriseState = {
    ...identity,
    config: { version: 3, transcription: [whisper], reasoning: [] },
  };
  t.after(() => {
    delete globalThis.__managedSetupDownloads;
    delete globalThis.__managedSetupEnterpriseState;
    delete globalThis.__resetManagedSetupDownloadState;
  });
  const mocks = commonMocks();
  mocks["react-i18next"] = `
    const labels = {
      "common.continue": "Continue",
      "managedLocalModels.workspaceSetup.title": "Set up this workspace’s models",
      "managedLocalModels.workspaceSetup.description": "Choose the company-approved models to continue.",
    };
    export function useTranslation() {
      return { t(key) { return labels[key] ?? key; } };
    }
  `;
  mocks["/lib/auth"] = "export async function signOut() {}";
  mocks["/EnterpriseModelSetupStep"] =
    "export default function EnterpriseModelSetupStep() { return null; }";
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-enterprise-focused-setup-dialog-",
    noExternal: ["react-i18next"],
    mockModules: mocks,
  });
  const { default: ManagedEnterpriseModelCoordinator } = await vite.ssrLoadModule(
    "/components/onboarding/ManagedEnterpriseModelCoordinator.tsx"
  );
  root = createRoot(container);

  await React.act(async () => {
    root.render(React.createElement(ManagedEnterpriseModelCoordinator, { showUi: true }));
    await new Promise((resolve) => setImmediate(resolve));
  });

  const dialogContent = findElement(
    container,
    (element) => element.getAttribute("data-managed-setup-dialog") === "true"
  );
  assert.ok(dialogContent);
  assert.equal(findElement(dialogContent, (element) => element.tagName === "H2").textContent, "Set up this workspace’s models");
  assert.equal(
    findElement(dialogContent, (element) => element.tagName === "P").textContent,
    "Choose the company-approved models to continue."
  );

  const continueButton = buttonFor(container, "Continue");
  assert.ok(continueButton);
  assert.equal(continueButton.getAttribute("disabled"), "");
  assert.equal(continueButton.getAttribute("aria-busy"), "true");

  const interactions = globalThis.__managedSetupDialogInteractions;
  for (const requestDismiss of [
    interactions.escape,
    interactions.pointerOutside,
    interactions.focusOutside,
  ]) {
    const event = requestDismiss();
    assert.equal(event.cancelable, true);
    assert.equal(event.defaultPrevented, true);
    assert.ok(
      findElement(
        container,
        (element) => element.getAttribute("data-managed-setup-dialog") === "true"
      )
    );
  }
  assert.equal(interactions.dismissalRequests, 0);
});

test("onboarding error and completed setup modal actions both sign out", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installInteractiveDom(t);
  globalThis.__managedSetupSignOuts = 0;
  t.after(() => delete globalThis.__managedSetupSignOuts);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-enterprise-setup-sign-out-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        export function useTranslation() {
          return { t(key) { return key === "common.continue" ? "Continue" : key; } };
        }
      `,
      "/ui/button": `
        import React from 'react';
        export function Button(props) { return React.createElement('button', props); }
      `,
      "/lib/auth": `
        export async function signOut() { globalThis.__managedSetupSignOuts += 1; }
      `,
    },
  });
  const { EnterpriseConfigErrorActions, ManagedSetupFooterActions } = await vite.ssrLoadModule(
    "/components/onboarding/ManagedSetupBlockedActions.tsx"
  );
  root = createRoot(container);

  await React.act(async () => {
    root.render(React.createElement(EnterpriseConfigErrorActions, { onRetry() {} }));
  });
  const onboardingSignOut = buttonFor(container, "settingsPage.account.signOut.signOut");
  assert.ok(onboardingSignOut);
  await React.act(async () => click(onboardingSignOut));
  assert.equal(globalThis.__managedSetupSignOuts, 1);

  await React.act(async () => {
    root.render(
      React.createElement(ManagedSetupFooterActions, {
        ready: false,
        onContinue() {},
      })
    );
  });
  const modalSignOut = buttonFor(container, "settingsPage.account.signOut.signOut");
  assert.ok(modalSignOut);
  await React.act(async () => click(modalSignOut));
  assert.equal(globalThis.__managedSetupSignOuts, 2);

  const pendingContinue = buttonFor(container, "Continue");
  assert.ok(pendingContinue);
  assert.equal(pendingContinue.getAttribute("aria-busy"), "true");
});

test("signed-in account reconciliation keeps one sign-out action while workspace state resolves", async (t) => {
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
  globalThis.__managedSetupSignOuts = 0;
  globalThis.__managedSetupBacks = 0;
  globalThis.__managedSetupSignedIn = true;
  globalThis.__managedSetupWorkspacesLoaded = true;
  globalThis.__managedSetupInitialEnterpriseState = {
    accountId: "account-1",
    workspaceId: "workspace-1",
    authGeneration: 7,
    status: "ready",
    config: {
      version: 3,
      transcription: [{ provider: "whisper", modelId: "base" }],
      reasoning: [],
    },
  };
  t.after(() => {
    delete globalThis.__managedSetupSignOuts;
    delete globalThis.__managedSetupBacks;
    delete globalThis.__managedSetupSignedIn;
    delete globalThis.__managedSetupWorkspacesLoaded;
    delete globalThis.__managedSetupInitialEnterpriseState;
  });
  const emptyComponent = `
    import React from "react";
    export default function Empty() { return null; }
  `;
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-initial-managed-setup-sign-out-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `export function useTranslation() { return { t(key) { return key === "common.continue" ? "Continue" : key; } }; }`,
      "lucide-react": `
        import React from "react";
        const Icon = () => React.createElement("span");
        export const AlertCircle = Icon;
        export const Loader2 = Icon;
      `,
      "/AuthenticationStep": `
        import React from "react";
        export default function AuthenticationStep() {
          return React.createElement("p", null, "Sign in");
        }
      `,
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
      "/onboarding/useCases": `export function hasUseCaseIntent() { return true; }`,
      "/onboarding/OnboardingShell": `
        import React from "react";
        export default function OnboardingShell({ children, footerLeadingAction, onBack, onContinue, continueDisabled, stepKey }) {
          return React.createElement(
            "main",
            { "data-step-key": stepKey },
            children,
            footerLeadingAction,
            onBack && React.createElement("button", { type: "button", onClick: onBack }, "Back"),
            onContinue && React.createElement("button", { type: "button", disabled: continueDisabled, onClick: onContinue }, "Continue")
          );
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
      "/hooks/useAuth": `
        export function useAuth() { return { isSignedIn: globalThis.__managedSetupSignedIn }; }
      `,
      "/lib/auth": `
        export async function signOut() {
          globalThis.__managedSetupSignOuts += 1;
          globalThis.__managedSetupSignedIn = false;
        }
      `,
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
        const workspace = { id: "workspace-1", plan: "enterprise", status: "active" };
        export function useWorkspace() {
          const loaded = globalThis.__managedSetupWorkspacesLoaded;
          return {
            active: loaded ? workspace : null,
            workspaces: loaded ? [workspace] : [],
            loaded,
            setActive() {},
          };
        }
      `,
      "/stores/policyStore": `export function usePolicyStore(selector) { return selector({}); }`,
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
        export function getOnboardingProgress() { return null; }
        export function getOnboardingRoute() { return ["auth", "enterprise-models", "permissions"]; }
        export function reconcileStepWithRoute(step) { return step; }
        export function resolveEnterpriseWorkspaceForOnboarding(active) { return active; }
        export function shouldSkipOnboardingSetupChoice() {
          return globalThis.__managedSetupWorkspacesLoaded;
        }
      `,
      "/onboarding/useOnboardingSession": `
        import { useCallback, useState } from "react";
        export function useOnboardingSession() {
          const [session, setSession] = useState({
            currentStepId: "enterprise-models",
            authPath: "account",
            setupMode: null,
            history: ["auth"],
          });
          return {
            session,
            setSession,
            goTo: useCallback((stepId) => {
              setSession((current) => ({ ...current, currentStepId: stepId }));
            }, []),
            goBack: useCallback(() => {
              globalThis.__managedSetupBacks += 1;
              globalThis.__managedSetupWorkspacesLoaded = false;
              globalThis.__managedSetupInitialEnterpriseState = {
                ...globalThis.__managedSetupInitialEnterpriseState,
                status: "loading",
              };
              setSession((current) => ({ ...current, currentStepId: "auth" }));
            }, []),
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
      "/stores/enterpriseIdentityStore": `
        export function selectEffectiveManagedLocalModels(value) { return value.config; }
        export function useEnterpriseIdentityStore() {
          return globalThis.__managedSetupInitialEnterpriseState;
        }
      `,
      "/onboarding/managedLocalModels": `
        export function areManagedLocalModelBindingsReady() { return false; }
        export function readManagedLocalModelBinding() { return null; }
        export function requiresManagedLocalModels() { return true; }
        export function translateManagedLocalModelError(value) { return value; }
      `,
    },
  });
  const { default: OnboardingFlow } = await vite.ssrLoadModule("/components/OnboardingFlow.tsx");
  root = createRoot(container);

  await React.act(async () => {
    root.render(React.createElement(OnboardingFlow, { onComplete() {} }));
    await new Promise((resolve) => setImmediate(resolve));
  });

  const continueButton = buttonFor(container, "Continue");
  assert.ok(continueButton);
  assert.equal(continueButton.getAttribute("disabled"), "");
  assert.ok(buttonFor(container, "settingsPage.account.signOut.signOut"));

  await React.act(async () => {
    click(buttonFor(container, "Back"));
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(globalThis.__managedSetupBacks, 1);
  assert.match(container.textContent, /managedLocalModels\.onboarding\.checking/);
  const pendingSignOutButton = buttonFor(container, "settingsPage.account.signOut.signOut");
  assert.ok(pendingSignOutButton);
  await React.act(async () => click(pendingSignOutButton));
  assert.equal(globalThis.__managedSetupSignOuts, 1);
  assert.equal(globalThis.__managedSetupSignedIn, false);
  await React.act(async () => {
    root.render(React.createElement(OnboardingFlow, { onComplete() {} }));
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(buttonFor(container, "settingsPage.account.signOut.signOut"), null);
  assert.match(container.textContent, /Sign in/);

  globalThis.__managedSetupSignedIn = true;
  globalThis.__managedSetupWorkspacesLoaded = true;
  globalThis.__managedSetupInitialEnterpriseState = {
    ...globalThis.__managedSetupInitialEnterpriseState,
    status: "error",
    error: "configuration request failed",
  };
  await React.act(async () => {
    root.render(React.createElement(OnboardingFlow, { onComplete() {} }));
    await new Promise((resolve) => setImmediate(resolve));
  });
  const configErrorSignOutCount =
    container.textContent.split("settingsPage.account.signOut.signOut").length - 1;
  assert.equal(configErrorSignOutCount, 1);

  globalThis.__managedSetupInitialEnterpriseState = {
    ...globalThis.__managedSetupInitialEnterpriseState,
    status: "ready",
    error: null,
  };
  await React.act(async () => {
    root.render(React.createElement(OnboardingFlow, { onComplete() {} }));
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(
    findElement(container, (element) => element.tagName === "MAIN").getAttribute("data-step-key"),
    "enterprise-models"
  );
  const reconciledSignOutButton = buttonFor(container, "settingsPage.account.signOut.signOut");
  assert.ok(reconciledSignOutButton);

  await React.act(async () => click(reconciledSignOutButton));
  assert.equal(globalThis.__managedSetupSignOuts, 2);
  assert.equal(globalThis.__managedSetupSignedIn, false);
});
