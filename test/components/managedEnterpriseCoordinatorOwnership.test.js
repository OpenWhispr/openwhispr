const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");

const identity = {
  accountId: "account-1",
  workspaceId: "workspace-1",
  authGeneration: 7,
  configVersion: 3,
};
const selection = { provider: "whisper", modelId: "base" };
const config = { version: 3, transcription: [selection], reasoning: [] };

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

function lockManager() {
  let held = false;
  const waiters = [];

  const run = async (name, callback) => {
    held = true;
    try {
      return await callback({ name, mode: "exclusive" });
    } finally {
      held = false;
      const next = waiters.shift();
      if (next) setTimeout(next, 0);
    }
  };

  return {
    request(name, callback) {
      if (!held) return run(name, callback);
      return new Promise((resolve, reject) => {
        waiters.push(() => run(name, callback).then(resolve, reject));
      });
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function downloadPlatform() {
  const whisperListeners = new Set();
  const requests = [];
  let activeModel = null;
  let whisperInventoryReads = 0;

  return {
    requests,
    get diagnostics() {
      return { whisperInventoryReads, whisperListeners: whisperListeners.size };
    },
    electronAPI: {
      checkParakeetInstallation: async () => ({ supported: true }),
      listWhisperModels: async () => {
        whisperInventoryReads += 1;
        return {
          models: activeModel
            ? [
                {
                  model: activeModel,
                  downloaded: false,
                  isDownloading: true,
                  downloadProgress: 25,
                },
              ]
            : [],
        };
      },
      listParakeetModels: async () => ({ models: [] }),
      modelGetAll: async () => [],
      onWhisperDownloadProgress(listener) {
        whisperListeners.add(listener);
        return () => whisperListeners.delete(listener);
      },
      onParakeetDownloadProgress() {
        return () => {};
      },
      onModelDownloadProgress() {
        return () => {};
      },
      downloadWhisperModel(modelId) {
        const request = deferred();
        activeModel = modelId;
        requests.push({ modelId, ...request });
        return request.promise;
      },
    },
    emitProgress(modelId) {
      activeModel = modelId;
      for (const listener of whisperListeners) {
        listener(undefined, {
          type: "progress",
          model: modelId,
          percentage: 25,
          downloaded_bytes: 25,
          total_bytes: 100,
        });
      }
    },
    emitError(modelId, error) {
      activeModel = null;
      for (const listener of whisperListeners) {
        listener(undefined, { type: "error", model: modelId, error });
      }
    },
  };
}

async function waitFor(check, message) {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() >= deadline) {
      throw new Error(typeof message === "function" ? message() : message);
    }
    await React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

test("StrictMode coordinators keep one current owner through errors, retries, and takeover", async (t) => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const events = eventTarget();
  const locks = lockManager();
  const downloads = downloadPlatform();
  const { storage } = installBrowserGlobals(t, {
    initialStorage: {
      onboardingCompleted: "true",
      enterpriseManagedLocalModelBindingsV1: JSON.stringify({
        "account-1:workspace-1": {
          configVersion: 3,
          transcription: null,
          reasoning: null,
          error: null,
        },
      }),
    },
    window: {
      ...events,
      setTimeout,
      clearTimeout,
      electronAPI: downloads.electronAPI,
    },
  });
  const bindingWrites = [];
  const setStorageItem = storage.setItem;
  storage.setItem = (key, value) => {
    if (key === "enterpriseManagedLocalModelBindingsV1") bindingWrites.push(String(value));
    setStorageItem(key, value);
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks },
  });
  t.after(() => {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
  });

  const container = installInteractiveDom(t);
  const firstContainer = globalThis.document.createElement("div");
  const secondContainer = globalThis.document.createElement("div");
  container.appendChild(firstContainer);
  container.appendChild(secondContainer);
  globalThis.CustomEvent = class {
    constructor(type) {
      this.type = type;
    }
  };
  t.after(() => delete globalThis.CustomEvent);

  globalThis.__managedCoordinatorReconciliations = [];
  globalThis.__managedCoordinatorSettingsCalls = [];
  globalThis.__managedCoordinatorSettingsMutations = [];
  globalThis.__managedCoordinatorEnforcedSettings = null;
  globalThis.__managedSetupEnterpriseState = { ...identity, status: "ready", config };
  t.after(() => {
    delete globalThis.__managedCoordinatorReconciliations;
    delete globalThis.__managedCoordinatorSettingsCalls;
    delete globalThis.__managedCoordinatorSettingsMutations;
    delete globalThis.__managedCoordinatorEnforcedSettings;
    delete globalThis.__managedSetupEnterpriseState;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-managed-coordinator-ownership-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        export function useTranslation() {
          return { t(key, values) { return values?.error ?? key; } };
        }
      `,
      "lucide-react": `
        import React from 'react';
        export const AlertCircle = () => React.createElement('span');
      `,
      "/EnterpriseModelSetupStep": `
        export default function EnterpriseModelSetupStep() { return null; }
      `,
      "/ManagedSetupBlockedActions": `
        export function EnterpriseConfigErrorActions() { return null; }
        export function ManagedSetupFooterActions() { return null; }
      `,
      "/hooks/useDialogs": `
        export function useDialogs() {
          return { showAlertDialog() {} };
        }
      `,
      "/components/ui/useToast": `
        export function useToast() { return { toast() {} }; }
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
          return selector(globalThis.__managedSetupEnterpriseState);
        }
        useEnterpriseIdentityStore.getState = () => globalThis.__managedSetupEnterpriseState;
      `,
      "/models/ModelRegistry": `
        export const modelRegistry = { getModel() { return null; } };
      `,
      "/stores/settingsStore": `
        export function clearMissingLocalModelSelections() {}
      `,
      "/managedLocalModelSettings": `
        export function enforceManagedLocalModelSettings(category, selected) {
          globalThis.__managedCoordinatorSettingsCalls.push({ category, selected });
          const key = category + ':' + selected.provider + ':' + selected.modelId;
          if (globalThis.__managedCoordinatorEnforcedSettings === key) return;
          globalThis.__managedCoordinatorEnforcedSettings = key;
          globalThis.__managedCoordinatorSettingsMutations.push({ category, selected });
        }
        export function reconcileManagedLocalModelSettings(args) {
          if (args.ownsReconciliation) globalThis.__managedCoordinatorReconciliations.push(args);
        }
      `,
    },
  });
  const { default: ManagedEnterpriseModelCoordinator } = await vite.ssrLoadModule(
    "/components/onboarding/ManagedEnterpriseModelCoordinator.tsx"
  );
  const managedModels = await vite.ssrLoadModule("/components/onboarding/managedLocalModels.ts");
  const firstRoot = createRoot(firstContainer);
  const secondRoot = createRoot(secondContainer);
  let firstMounted = true;
  let secondMounted = true;
  t.after(async () => {
    if (firstMounted) await React.act(async () => firstRoot.unmount());
    if (secondMounted) await React.act(async () => secondRoot.unmount());
  });

  await React.act(async () => {
    firstRoot.render(
      React.createElement(
        React.StrictMode,
        null,
        React.createElement(ManagedEnterpriseModelCoordinator, { showUi: false })
      )
    );
    secondRoot.render(
      React.createElement(
        React.StrictMode,
        null,
        React.createElement(ManagedEnterpriseModelCoordinator, { showUi: false })
      )
    );
  });
  await waitFor(
    () => downloads.requests.length === 1,
    () =>
      `the owner did not start its download: ${JSON.stringify({
        ...downloads.diagnostics,
        reconciliations: globalThis.__managedCoordinatorReconciliations.length,
        settingsCalls: globalThis.__managedCoordinatorSettingsCalls.length,
        binding: managedModels.readManagedLocalModelBinding("account-1", "workspace-1"),
      })}`
  );

  assert.deepEqual(
    downloads.requests.map(({ modelId }) => modelId),
    ["base"]
  );
  assert.equal(globalThis.__managedCoordinatorReconciliations.length, 1);
  assert.equal(globalThis.__managedCoordinatorSettingsMutations.length, 1);

  const writesBeforeFirstError = bindingWrites.length;
  await React.act(async () => {
    downloads.emitError("base", "network unavailable");
    downloads.requests[0].resolve({ success: false, error: "network unavailable" });
    await new Promise((resolve) => setImmediate(resolve));
  });
  let binding = managedModels.readManagedLocalModelBinding("account-1", "workspace-1");
  assert.equal(binding.categoryErrors.transcription, "network unavailable");
  assert.equal(bindingWrites.length - writesBeforeFirstError, 1);

  await React.act(async () => {
    managedModels.writeManagedLocalModelBinding(
      "account-1",
      "workspace-1",
      managedModels.createManagedLocalModelRetryBinding(binding)
    );
    await new Promise((resolve) => setImmediate(resolve));
  });
  await waitFor(() => downloads.requests.length === 2, "the owner did not start its retry");

  await React.act(async () => {
    downloads.emitProgress("base");
    await new Promise((resolve) => setImmediate(resolve));
    firstRoot.unmount();
  });
  firstMounted = false;
  await waitFor(
    () => globalThis.__managedCoordinatorReconciliations.length === 2,
    "the standby did not acquire reconciliation ownership"
  );

  assert.equal(globalThis.__managedCoordinatorReconciliations.length, 2);
  assert.equal(
    downloads.requests.length,
    2,
    "the standby must join the observed active download instead of starting another one"
  );

  const writesBeforeTakeoverError = bindingWrites.length;
  await React.act(async () => {
    downloads.emitError("base", "disk full");
    downloads.requests[1].resolve({ success: false, error: "disk full" });
    await new Promise((resolve) => setImmediate(resolve));
  });
  binding = managedModels.readManagedLocalModelBinding("account-1", "workspace-1");
  assert.equal(binding.categoryErrors.transcription, "disk full");
  assert.equal(
    bindingWrites.length - writesBeforeTakeoverError,
    1,
    "the released owner must not persist the promoted renderer's terminal error"
  );

  await React.act(async () => {
    managedModels.writeManagedLocalModelBinding(
      "account-1",
      "workspace-1",
      managedModels.createManagedLocalModelRetryBinding(binding)
    );
    await new Promise((resolve) => setImmediate(resolve));
  });
  await waitFor(() => downloads.requests.length === 3, "the promoted owner did not retry");
  assert.equal(downloads.requests.length, 3, "the promoted renderer must own exactly one retry");
  const writesBeforeReleasedOwnerCompletion = bindingWrites.length;
  const settingsCallsBeforeReleasedOwnerCompletion =
    globalThis.__managedCoordinatorSettingsCalls.length;
  await React.act(async () => secondRoot.unmount());
  secondMounted = false;
  await React.act(async () => {
    downloads.requests[2].resolve({ success: true });
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(bindingWrites.length, writesBeforeReleasedOwnerCompletion);
  assert.equal(
    globalThis.__managedCoordinatorSettingsCalls.length,
    settingsCallsBeforeReleasedOwnerCompletion,
    "a released owner must not apply settings when its request succeeds"
  );
});
