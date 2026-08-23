const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { click, findElement, installInteractiveDom } = require("../lib/interactiveDom");

const selection = { provider: "whisper", modelId: "base" };
const identityA = {
  accountId: "account-a",
  workspaceId: "workspace-a",
  authGeneration: 3,
  configVersion: 7,
};
const identityB = {
  accountId: "account-b",
  workspaceId: "workspace-b",
  authGeneration: 8,
  configVersion: 7,
};

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function downloadPlatform() {
  const whisperListeners = new Set();
  const cancellations = [];
  const downloadRequests = [];
  let isWhisperDownloading = true;
  let whisperInventoryReads = 0;

  return {
    cancellations,
    downloadRequests,
    get whisperInventoryReads() {
      return whisperInventoryReads;
    },
    reset() {
      isWhisperDownloading = true;
    },
    electronAPI: {
      listWhisperModels: async () => {
        whisperInventoryReads += 1;
        return {
          models: isWhisperDownloading
            ? [
                {
                  model: selection.modelId,
                  downloaded: false,
                  isDownloading: true,
                  downloadProgress: 42,
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
      cancelWhisperDownload() {
        const request = deferred();
        cancellations.push({
          promise: request.promise,
          resolve(result) {
            if (result?.success === true) isWhisperDownloading = false;
            request.resolve(result);
          },
        });
        return request.promise;
      },
      downloadWhisperModel(modelId) {
        downloadRequests.push(modelId);
        return Promise.resolve({ success: true });
      },
    },
    emitError(error) {
      for (const listener of whisperListeners) {
        listener(undefined, {
          type: "error",
          model: selection.modelId,
          percentage: 42,
          error,
        });
      }
    },
  };
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

async function waitFor(check, message) {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await React.act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  }
}

function cancelButton(container) {
  return findElement(container, (element) => element.tagName === "BUTTON");
}

test("the mounted download tray fences cancellation results to the clicked identity", async (t) => {
  const downloads = downloadPlatform();
  const { storage } = installBrowserGlobals(t, {
    window: {
      ...eventTarget(),
      setTimeout,
      clearTimeout,
      electronAPI: downloads.electronAPI,
    },
  });
  const testContainer = installInteractiveDom(t);
  globalThis.__modelDownloadCancellationNotifications = [];
  t.after(() => delete globalThis.__modelDownloadCancellationNotifications);

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-background-download-cancellation-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        export function useTranslation() {
          return { t(key, values) { return values?.model ? key + ':' + values.model : key; } };
        }
      `,
      "/ui/ProviderIcon": `
        import React from "react";
        export function ProviderIcon() { return React.createElement("span"); }
      `,
      "/OnboardingShell": `
        import React from "react";
        export function BrandMark() { return React.createElement("span"); }
      `,
      "/models/ModelRegistry": `
        export function getWhisperModelInfo(modelId) {
          return modelId === "base" ? { name: "Whisper Base" } : null;
        }
        export function getParakeetModelInfo() { return null; }
        export const modelRegistry = { getModel() { return null; } };
      `,
      "/stores/settingsStore": `
        const state = {
          setLocalTranscriptionProvider() {},
          setParakeetModel() {},
          setWhisperModel() {},
          setCloudTranscriptionForAllScopes() {},
          setChatAgentMode() {},
          setChatAgentProvider() {},
          setChatAgentModel() {},
          setCloudReasoningForAllScopes() {},
        };
        export function useSettingsStore() { return state; }
        useSettingsStore.getState = () => state;
        export function clearMissingLocalModelSelections() {}
      `,
      "/stores/policyStore": `
        export function usePolicyStore(selector) { return selector({}); }
        usePolicyStore.getState = () => ({});
      `,
      "/stores/policyRules": `
        export function isAgentAllowed() { return true; }
        export function isModeAllowedByPolicy() { return true; }
      `,
      "/hooks/modelDownloadCancellation": `
        export function notifyModelDownloadCancellation(modelType, modelId) {
          globalThis.__modelDownloadCancellationNotifications.push({ modelType, modelId });
        }
      `,
      "/hooks/useModelDownload": `
        export function useModelDownload({ modelType }) {
          return {
            hasHydratedDownloads: true,
            isDownloading: false,
            isDownloadingModel() { return false; },
            async downloadModel(modelId) {
              if (modelType === "whisper") {
                await window.electronAPI.downloadWhisperModel(modelId);
              }
              return "started";
            },
          };
        }
      `,
      "/EnterpriseModelSetupStep": `export default function EnterpriseModelSetupStep() { return null; }`,
      "/ManagedSetupBlockedActions": `
        export function EnterpriseConfigErrorActions() { return null; }
        export function ManagedSetupFooterActions() { return null; }
      `,
      "/hooks/useDialogs": `
        export function useDialogs() { return { showAlertDialog() {} }; }
      `,
      "/components/ui/useToast": `
        export function useToast() { return { toast() {} }; }
      `,
      "/hooks/usePolicy": `export function usePolicySnapshot() { return {}; }`,
      "/stores/enterpriseIdentityStore": `
        export function selectEffectiveManagedLocalModels(state) { return state.config; }
        export function useEnterpriseIdentityStore(selector) {
          return selector(globalThis.__backgroundTrayEnterpriseState);
        }
        useEnterpriseIdentityStore.getState = () => globalThis.__backgroundTrayEnterpriseState;
      `,
      "/managedLocalModelSettings": `
        export function enforceManagedLocalModelSettings() {}
        export function reconcileManagedLocalModelSettings() {}
      `,
    },
  });
  const [{ default: BackgroundModelDownloadTray }, pending, managed, coordinator] = await Promise.all([
    vite.ssrLoadModule("/components/onboarding/BackgroundModelDownloadTray.tsx"),
    vite.ssrLoadModule("/components/onboarding/pendingLocalModels.ts"),
    vite.ssrLoadModule("/components/onboarding/managedLocalModels.ts"),
    vite.ssrLoadModule("/components/onboarding/ManagedEnterpriseModelCoordinator.tsx"),
  ]);
  const ManagedEnterpriseModelCoordinator = coordinator.default;

  function seedManagedDownload(identity) {
    storage.clear();
    downloads.reset();
    globalThis.__modelDownloadCancellationNotifications.length = 0;
    localStorage.setItem("localSetupPending", "true");
    managed.writeManagedLocalModelBinding(identity.accountId, identity.workspaceId, {
      configVersion: identity.configVersion,
      transcription: selection,
      reasoning: null,
      error: null,
    });
    pending.rememberPendingLocalModel("dictation", selection, identity);
  }

  async function mountTray() {
    const container = globalThis.document.createElement("div");
    testContainer.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(BackgroundModelDownloadTray));
      await new Promise((resolve) => setImmediate(resolve));
    });
    await waitFor(() => cancelButton(container), "the hydrated download row did not render");
    return { container, root };
  }

  await t.test("a late success cannot mark or clear a replacement identity", async () => {
    seedManagedDownload(identityA);
    const { container, root } = await mountTray();
    await React.act(async () => click(cancelButton(container)));
    assert.equal(downloads.cancellations.length, 1);

    managed.writeManagedLocalModelBinding(identityB.accountId, identityB.workspaceId, {
      configVersion: identityB.configVersion,
      transcription: selection,
      reasoning: null,
      error: null,
    });
    pending.rememberPendingLocalModel("dictation", selection, identityB);

    await React.act(async () => {
      downloads.cancellations[0].resolve({ success: true });
      await new Promise((resolve) => setImmediate(resolve));
    });

    assert.deepEqual(pending.readPendingLocalModels().dictation, {
      ...selection,
      managedIdentity: identityB,
    });
    assert.deepEqual(
      managed.readManagedLocalModelBinding(identityB.accountId, identityB.workspaceId)
        .categoryErrors,
      undefined
    );
    assert.deepEqual(globalThis.__modelDownloadCancellationNotifications, [
      { modelType: "whisper", modelId: "base" },
    ]);
    await React.act(async () => root.unmount());
  });

  await t.test(
    "a current success records the stable error and clears that exact pending",
    async () => {
      seedManagedDownload(identityA);
      const { container, root } = await mountTray();
      await React.act(async () => click(cancelButton(container)));
      assert.equal(downloads.cancellations.length, 2);

      await React.act(async () => {
        downloads.cancellations[1].resolve({ success: true });
        await new Promise((resolve) => setImmediate(resolve));
      });

      assert.equal(pending.readPendingLocalModels().dictation, undefined);
      assert.equal(
        managed.readManagedLocalModelBinding(identityA.accountId, identityA.workspaceId)
          .categoryErrors.transcription,
        managed.MANAGED_LOCAL_MODEL_ERROR_CODES.downloadCancelled
      );
      assert.deepEqual(globalThis.__modelDownloadCancellationNotifications, [
        { modelType: "whisper", modelId: "base" },
      ]);
      await React.act(async () => root.unmount());
    }
  );

  await t.test(
    "a rejected cancellation restores the row without changing pending state",
    async () => {
      seedManagedDownload(identityA);
      const { container, root } = await mountTray();
      await React.act(async () => click(cancelButton(container)));
      assert.equal(cancelButton(container), null);
      assert.equal(downloads.cancellations.length, 3);

      await React.act(async () => {
        downloads.cancellations[2].resolve({ success: false });
        await new Promise((resolve) => setImmediate(resolve));
      });

      assert.ok(cancelButton(container));
      assert.deepEqual(pending.readPendingLocalModels().dictation, {
        ...selection,
        managedIdentity: identityA,
      });
      assert.equal(
        managed.readManagedLocalModelBinding(identityA.accountId, identityA.workspaceId)
          .categoryErrors,
        undefined
      );
      assert.deepEqual(globalThis.__modelDownloadCancellationNotifications, []);
      await React.act(async () => root.unmount());
    }
  );

  await t.test("a late cancellation success persists the current managed selection after unmount", async () => {
    seedManagedDownload(identityA);
    const { container, root } = await mountTray();
    await React.act(async () => click(cancelButton(container)));
    assert.equal(downloads.cancellations.length, 4);
    await React.act(async () => root.unmount());

    downloads.cancellations[3].resolve({ success: true });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(pending.readPendingLocalModels().dictation, undefined);
    assert.equal(
      managed.readManagedLocalModelBinding(identityA.accountId, identityA.workspaceId)
        .categoryErrors.transcription,
      managed.MANAGED_LOCAL_MODEL_ERROR_CODES.downloadCancelled
    );
    assert.deepEqual(globalThis.__modelDownloadCancellationNotifications, [
      { modelType: "whisper", modelId: "base" },
    ]);
  });

  await t.test("dismissing a terminal error clears only the exact current pending", async () => {
    seedManagedDownload(identityA);
    const { container, root } = await mountTray();
    await React.act(async () => downloads.emitError("network unavailable"));
    assert.match(container.textContent, /network unavailable/);

    const dismissErrorButton = cancelButton(container);
    assert.equal(
      dismissErrorButton.getAttribute("aria-label"),
      "managedLocalModels.actions.dismissError:Whisper Base"
    );
    await React.act(async () => click(dismissErrorButton));

    assert.equal(pending.readPendingLocalModels().dictation, undefined);
    assert.equal(downloads.cancellations.length, 4);
    assert.deepEqual(globalThis.__modelDownloadCancellationNotifications, []);
    await React.act(async () => root.unmount());
  });

  await t.test(
    "a late tray cancellation prevents a successor coordinator from restarting the exact model",
    async () => {
      seedManagedDownload(identityA);
      globalThis.__backgroundTrayEnterpriseState = {
        ...identityA,
        status: "ready",
        failClosed: false,
        config: { version: identityA.configVersion, transcription: [selection], reasoning: [] },
      };
      const { container, root } = await mountTray();
      const cancellationIndex = downloads.cancellations.length;
      await React.act(async () => click(cancelButton(container)));
      assert.equal(downloads.cancellations.length, cancellationIndex + 1);
      await React.act(async () => root.unmount());

      downloads.cancellations[cancellationIndex].resolve({ success: true });
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(pending.readPendingLocalModels().dictation, undefined);
      assert.equal(
        managed.readManagedLocalModelBinding(identityA.accountId, identityA.workspaceId)
          .categoryErrors.transcription,
        managed.MANAGED_LOCAL_MODEL_ERROR_CODES.downloadCancelled
      );

      const successorContainer = globalThis.document.createElement("div");
      testContainer.appendChild(successorContainer);
      const successorRoot = createRoot(successorContainer);
      const inventoryReadsBeforeSuccessor = downloads.whisperInventoryReads;
      await React.act(async () => {
        successorRoot.render(
          React.createElement(ManagedEnterpriseModelCoordinator, { showUi: false })
        );
        await new Promise((resolve) => setImmediate(resolve));
      });
      await waitFor(
        () => downloads.whisperInventoryReads > inventoryReadsBeforeSuccessor,
        "the successor coordinator did not reconcile its inventory"
      );

      assert.deepEqual(downloads.downloadRequests, []);
      await React.act(async () => successorRoot.unmount());
      delete globalThis.__backgroundTrayEnterpriseState;
    }
  );
});
