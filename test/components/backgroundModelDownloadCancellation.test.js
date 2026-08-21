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

  return {
    cancellations,
    electronAPI: {
      listWhisperModels: async () => ({
        models: [
          {
            model: selection.modelId,
            downloaded: false,
            isDownloading: true,
            downloadProgress: 42,
          },
        ],
      }),
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
        cancellations.push(request);
        return request.promise;
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
      `,
      "/stores/policyStore": `
        export function usePolicyStore(selector) { return selector({}); }
        usePolicyStore.getState = () => ({});
      `,
      "/stores/policyRules": `export function isAgentAllowed() { return true; }`,
      "/hooks/modelDownloadCancellation": `
        export function notifyModelDownloadCancellation(modelType, modelId) {
          globalThis.__modelDownloadCancellationNotifications.push({ modelType, modelId });
        }
      `,
    },
  });
  const [{ default: BackgroundModelDownloadTray }, pending, managed] = await Promise.all([
    vite.ssrLoadModule("/components/onboarding/BackgroundModelDownloadTray.tsx"),
    vite.ssrLoadModule("/components/onboarding/pendingLocalModels.ts"),
    vite.ssrLoadModule("/components/onboarding/managedLocalModels.ts"),
  ]);

  function seedManagedDownload(identity) {
    storage.clear();
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

  await t.test("a late result after unmount cannot mutate pending or binding state", async () => {
    seedManagedDownload(identityA);
    const { container, root } = await mountTray();
    await React.act(async () => click(cancelButton(container)));
    assert.equal(downloads.cancellations.length, 4);
    await React.act(async () => root.unmount());

    downloads.cancellations[3].resolve({ success: true });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(pending.readPendingLocalModels().dictation, {
      ...selection,
      managedIdentity: identityA,
    });
    assert.equal(
      managed.readManagedLocalModelBinding(identityA.accountId, identityA.workspaceId)
        .categoryErrors,
      undefined
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

    await React.act(async () => click(cancelButton(container)));

    assert.equal(pending.readPendingLocalModels().dictation, undefined);
    assert.equal(downloads.cancellations.length, 4);
    assert.deepEqual(globalThis.__modelDownloadCancellationNotifications, []);
    await React.act(async () => root.unmount());
  });
});
