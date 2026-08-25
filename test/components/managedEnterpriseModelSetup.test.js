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

function configuredState(selections) {
  return {
    ...identity,
    status: "ready",
    verdict: "configured",
    failClosed: false,
    error: null,
    config: { generation: 11, localModels: { selections } },
  };
}

function inventory({ downloaded }) {
  return {
    listWhisperModels: async () => ({
      models: [{ model: "base", downloaded, isDownloading: false }],
    }),
    listParakeetModels: async () => ({ models: [] }),
    modelGetAll: async () => [],
    checkParakeetInstallation: async () => ({ supported: false }),
    onWhisperDownloadProgress: () => () => {},
    onParakeetDownloadProgress: () => () => {},
    onModelDownloadProgress: () => () => {},
  };
}

async function loadCoordinator(t, electronAPI) {
  installBrowserGlobals(t, { window: { electronAPI } });
  const { container, createContainer } = installManagedLocalTestDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-managed-coordinator-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `const t = (key) => key; export const useTranslation = () => ({ t });`,
      "/ui/dialog": `
        import React from "react";
        export const Dialog = ({ open, children }) => open ? React.createElement(React.Fragment, null, children) : null;
        export const DialogContent = ({ children }) => React.createElement("section", null, children);
        export const DialogHeader = ({ children }) => React.createElement("header", null, children);
        export const DialogTitle = ({ children }) => React.createElement("h2", null, children);
        export const DialogDescription = ({ children }) => React.createElement("p", null, children);
      `,
      "/stores/settingsStore": `export const clearMissingLocalModelSelections = () => {};`,
      ProviderIcon: `export const ProviderIcon = () => null;`,
    },
  });
  const [{ default: Coordinator }, { useEnterpriseIdentityStore }, { ToastContext }] =
    await Promise.all([
      vite.ssrLoadModule("/components/onboarding/ManagedEnterpriseModelCoordinator.tsx"),
      vite.ssrLoadModule("/stores/enterpriseIdentityStore.ts"),
      vite.ssrLoadModule("/components/ui/useToast.ts"),
    ]);
  return { Coordinator, ToastContext, container, createContainer, useEnterpriseIdentityStore, vite };
}

async function flush() {
  await React.act(async () => new Promise((resolve) => setImmediate(resolve)));
}

const toastValue = {
  toast: () => "toast",
  dismiss() {},
  toastCount: 0,
  dictationErrorActionCount: 0,
  dismissByPresentation() {},
};

async function mountCoordinator(loaded, props, container = loaded.container) {
  const root = createRoot(container);
  await React.act(async () => {
    root.render(
      React.createElement(
        loaded.ToastContext.Provider,
        { value: toastValue },
        React.createElement(loaded.Coordinator, props)
      )
    );
  });
  return root;
}

function createLockQueue() {
  let held = false;
  const queue = [];
  return {
    request: async (_name, callback) => {
      if (held) await new Promise((resolve) => queue.push(resolve));
      held = true;
      try {
        return await callback({ name: "managed-local" });
      } finally {
        held = false;
        queue.shift()?.();
      }
    },
  };
}

test("binding writes rerender the shared managed settings hook without unrelated state", async (t) => {
  const loaded = await loadCoordinator(t, inventory({ downloaded: false }));
  loaded.useEnterpriseIdentityStore.setState(
    configuredState([
      { provider: "whisper", model: "base" },
      { provider: "qwen", model: "assistant-model" },
    ])
  );
  const [{ useManagedLocalModelSelection }, managed] = await Promise.all([
    loaded.vite.ssrLoadModule("/hooks/useManagedLocalModelSelection.ts"),
    loaded.vite.ssrLoadModule("/components/onboarding/managedLocalModels.ts"),
  ]);
  function ManagedSelectionProbe() {
    const dictation = useManagedLocalModelSelection("dictation");
    const assistant = useManagedLocalModelSelection("assistant");
    return React.createElement(
      "span",
      null,
      `${dictation?.model ?? "waiting"}:${assistant?.model ?? "waiting"}`
    );
  }
  const root = createRoot(loaded.container);
  await React.act(async () => root.render(React.createElement(ManagedSelectionProbe)));
  assert.equal(loaded.container.textContent, "waiting:waiting");
  await React.act(async () => {
    managed.rememberManagedLocalModelBinding({
      ...identity,
      category: "dictation",
      provider: "whisper",
      model: "base",
    });
  });
  assert.equal(loaded.container.textContent, "base:waiting");
  localStorage.setItem(
    "enterpriseManagedLocalModelBindingsV1",
    JSON.stringify({
      dictation: { ...identity, category: "dictation", provider: "whisper", model: "base" },
      assistant: {
        ...identity,
        category: "assistant",
        provider: "qwen",
        model: "assistant-model",
      },
    })
  );
  await React.act(async () => {
    globalThis.window.dispatchEvent({
      type: "storage",
      key: "enterpriseManagedLocalModelBindingsV1",
    });
  });
  assert.equal(loaded.container.textContent, "base:assistant-model");
  await React.act(async () => root.unmount());
});

test("download progress updates the current managed setup row", async (t) => {
  let onProgress;
  const electronAPI = {
    ...inventory({ downloaded: false }),
    onWhisperDownloadProgress: (callback) => {
      onProgress = callback;
      return () => {};
    },
    downloadWhisperModel: () => new Promise(() => {}),
  };
  const loaded = await loadCoordinator(t, electronAPI);
  loaded.useEnterpriseIdentityStore.setState(
    configuredState([{ provider: "whisper", model: "base" }])
  );
  const root = createRoot(loaded.container);
  await React.act(async () => {
    root.render(
      React.createElement(
        loaded.ToastContext.Provider,
        {
          value: {
            toast: () => "toast",
            dismiss() {},
            toastCount: 0,
            dictationErrorActionCount: 0,
            dismissByPresentation() {},
          },
        },
        React.createElement(loaded.Coordinator, { surface: "onboarding", showUi: true })
      )
    );
  });
  await flush();
  await React.act(async () => {
    onProgress(null, { model: "base", type: "progress", percentage: 37 });
  });
  assert.match(loaded.container.textContent, /37%/);
  await React.act(async () => root.unmount());
});

test("a completed NVIDIA capability check failure renders recovery actions", async (t) => {
  const electronAPI = {
    ...inventory({ downloaded: false }),
    listWhisperModels: async () => ({ models: [] }),
    listParakeetModels: async () => ({
      models: [{ model: "parakeet-tdt-0.6b-v3", downloaded: false, isDownloading: false }],
    }),
    checkParakeetInstallation: async () => undefined,
  };
  const loaded = await loadCoordinator(t, electronAPI);
  loaded.useEnterpriseIdentityStore.setState(
    configuredState([{ provider: "nvidia", model: "parakeet-tdt-0.6b-v3" }])
  );
  const root = createRoot(loaded.container);
  await React.act(async () => {
    root.render(
      React.createElement(
        loaded.ToastContext.Provider,
        {
          value: {
            toast: () => "toast",
            dismiss() {},
            toastCount: 0,
            dictationErrorActionCount: 0,
            dismissByPresentation() {},
          },
        },
        React.createElement(loaded.Coordinator, { surface: "onboarding", showUi: true })
      )
    );
  });
  await flush();
  assert.match(loaded.container.textContent, /onboarding\.managedLocal\.errors\.capabilityCheck/);
  assert.equal(findElements(loaded.container, (element) => element.tagName === "BUTTON").length, 2);
  await React.act(async () => root.unmount());
});

test("reconciliation exceptions render stable localized recovery without raw errors", async (t) => {
  const electronAPI = {
    ...inventory({ downloaded: false }),
    listWhisperModels: () => {
      throw new Error("private backend detail");
    },
  };
  const loaded = await loadCoordinator(t, electronAPI);
  loaded.useEnterpriseIdentityStore.setState(
    configuredState([{ provider: "whisper", model: "base" }])
  );
  const root = createRoot(loaded.container);
  await React.act(async () => {
    root.render(
      React.createElement(
        loaded.ToastContext.Provider,
        {
          value: {
            toast: () => "toast",
            dismiss() {},
            toastCount: 0,
            dictationErrorActionCount: 0,
            dismissByPresentation() {},
          },
        },
        React.createElement(loaded.Coordinator, { surface: "onboarding", showUi: true })
      )
    );
  });
  await flush();
  assert.match(loaded.container.textContent, /onboarding\.managedLocal\.errors\.reconciliation/);
  assert.doesNotMatch(loaded.container.textContent, /private backend detail/);
  await React.act(async () => root.unmount());
});

test("clicking B while A is in flight starts B once after A releases its slot", async (t) => {
  let resolveA;
  const downloads = [];
  const downloaded = new Set();
  const electronAPI = {
    ...inventory({ downloaded: false }),
    listWhisperModels: async () => ({
      models: ["base", "small"].map((model) => ({
        model,
        downloaded: downloaded.has(model),
        isDownloading: false,
      })),
    }),
    downloadWhisperModel: async (model) => {
      downloads.push(model);
      if (model === "base") {
        await new Promise((resolve) => {
          resolveA = resolve;
        });
        return { success: false, code: "DOWNLOAD_CANCELLED" };
      }
      downloaded.add(model);
      return { success: true };
    },
  };
  const loaded = await loadCoordinator(t, electronAPI);
  loaded.useEnterpriseIdentityStore.setState(
    configuredState([
      { provider: "whisper", model: "base" },
      { provider: "whisper", model: "small" },
    ])
  );
  const root = createRoot(loaded.container);
  await React.act(async () => {
    root.render(
      React.createElement(
        loaded.ToastContext.Provider,
        {
          value: {
            toast: () => "toast",
            dismiss() {},
            toastCount: 0,
            dictationErrorActionCount: 0,
            dismissByPresentation() {},
          },
        },
        React.createElement(loaded.Coordinator, { surface: "onboarding", showUi: true })
      )
    );
  });
  await flush();
  assert.deepEqual(downloads, ["base"]);
  await React.act(async () => {
    const rows = findElements(loaded.container, (element) => element.tagName === "BUTTON");
    click(rows[1]);
    await new Promise((resolve) => setImmediate(resolve));
  });
  await React.act(async () => {
    resolveA();
    await new Promise((resolve) => setImmediate(resolve));
  });
  await flush();
  assert.deepEqual(downloads, ["base", "small"]);
  await React.act(async () => root.unmount());
});

test("a blocked headless owner yields recovery and can rejoin after a real transfer change", async (t) => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: { locks: createLockQueue() },
    configurable: true,
  });
  t.after(() => {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
  });
  let supported = false;
  let downloaded = false;
  let inventoryReads = 0;
  const electronAPI = {
    ...inventory({ downloaded: false }),
    listWhisperModels: async () => ({ models: [] }),
    listParakeetModels: async () => {
      inventoryReads += 1;
      return {
        models: [
          {
            model: "parakeet-tdt-0.6b-v3",
            downloaded,
            isDownloading: false,
          },
        ],
      };
    },
    checkParakeetInstallation: async () => ({ supported }),
  };
  const loaded = await loadCoordinator(t, electronAPI);
  localStorage.setItem("onboardingCompleted", "true");
  loaded.useEnterpriseIdentityStore.setState(
    configuredState([{ provider: "nvidia", model: "parakeet-tdt-0.6b-v3" }])
  );
  const headlessRoot = await mountCoordinator(
    loaded,
    { surface: "background", showUi: false },
    loaded.container
  );
  const visibleContainer = loaded.createContainer();
  const visibleRoot = await mountCoordinator(
    loaded,
    { surface: "background", showUi: true },
    visibleContainer
  );
  await flush();
  await flush();
  assert.match(visibleContainer.textContent, /noCompatibleDictationModel/);

  supported = true;
  downloaded = true;
  const beforeRecovery = inventoryReads;
  await React.act(async () => {
    globalThis.window.dispatchEvent({ type: "storage", key: "pendingLocalModelSelectionsV1" });
    await new Promise((resolve) => setImmediate(resolve));
  });
  await flush();
  assert.equal(visibleContainer.textContent, "");
  assert.ok(inventoryReads > beforeRecovery);

  const beforeHandoff = inventoryReads;
  await React.act(async () => visibleRoot.unmount());
  await flush();
  await flush();
  assert.ok(inventoryReads > beforeHandoff);
  await React.act(async () => headlessRoot.unmount());
});

test("onboarding applies an installed approved selection and becomes ready", async (t) => {
  const loaded = await loadCoordinator(t, inventory({ downloaded: true }));
  loaded.useEnterpriseIdentityStore.setState(
    configuredState([{ provider: "whisper", model: "base" }])
  );
  const readiness = [];
  const root = await mountCoordinator(loaded, {
    surface: "onboarding",
    showUi: true,
    onReadinessChange: (ready) => readiness.push(ready),
  });
  await flush();
  const binding = JSON.parse(localStorage.getItem("enterpriseManagedLocalModelBindingsV1"));
  assert.deepEqual(binding.dictation, {
    ...identity,
    category: "dictation",
    provider: "whisper",
    model: "base",
  });
  assert.equal(readiness.at(-1), true);
  await React.act(async () => root.unmount());
});

test("a completed background owner consumes a hydrated exact pending row after install", async (t) => {
  const loaded = await loadCoordinator(t, inventory({ downloaded: true }));
  loaded.useEnterpriseIdentityStore.setState(
    configuredState([{ provider: "whisper", model: "base" }])
  );
  localStorage.setItem("onboardingCompleted", "true");
  localStorage.setItem(
    "enterpriseManagedLocalModelBindingsV1",
    JSON.stringify({
      dictation: { ...identity, category: "dictation", provider: "whisper", model: "base" },
    })
  );
  localStorage.setItem(
    "pendingLocalModelSelectionsV1",
    JSON.stringify({
      dictation: {
        ...identity,
        provider: "whisper",
        modelId: "base",
        transferState: "downloading",
      },
    })
  );
  const root = createRoot(loaded.container);
  await React.act(async () => {
    root.render(
      React.createElement(
        loaded.ToastContext.Provider,
        {
          value: {
            toast: () => "toast",
            dismiss() {},
            toastCount: 0,
            dictationErrorActionCount: 0,
            dismissByPresentation() {},
          },
        },
        React.createElement(loaded.Coordinator, { surface: "background", showUi: false })
      )
    );
  });
  await flush();
  assert.equal(
    JSON.parse(localStorage.getItem("pendingLocalModelSelectionsV1") ?? "{}").dictation,
    undefined
  );
  await React.act(async () => root.unmount());
});

test("a missing approved selection starts exactly one transfer and applies after inventory refresh", async (t) => {
  let downloaded = false;
  const downloads = [];
  const electronAPI = {
    ...inventory({ downloaded: false }),
    listWhisperModels: async () => ({
      models: [{ model: "base", downloaded, isDownloading: false }],
    }),
    downloadWhisperModel: async (model) => {
      downloads.push(model);
      downloaded = true;
      return { success: true };
    },
  };
  const loaded = await loadCoordinator(t, electronAPI);
  loaded.useEnterpriseIdentityStore.setState(
    configuredState([{ provider: "whisper", model: "base" }])
  );
  const root = await mountCoordinator(loaded, { surface: "onboarding", showUi: true });
  await flush();
  await flush();
  assert.deepEqual(downloads, ["base"]);
  const binding = JSON.parse(localStorage.getItem("enterpriseManagedLocalModelBindingsV1"));
  assert.equal(binding.dictation.model, "base");
  assert.equal(
    JSON.parse(localStorage.getItem("pendingLocalModelSelectionsV1") ?? "{}").dictation,
    undefined
  );
  await React.act(async () => root.unmount());
});

test("a hidden incomplete onboarding renderer never enters reconciliation", async (t) => {
  const downloads = [];
  const electronAPI = {
    ...inventory({ downloaded: false }),
    downloadWhisperModel: async (model) => {
      downloads.push(model);
      return { success: true };
    },
  };
  const loaded = await loadCoordinator(t, electronAPI);
  loaded.useEnterpriseIdentityStore.setState(
    configuredState([{ provider: "whisper", model: "base" }])
  );
  const root = createRoot(loaded.container);
  await React.act(async () => {
    root.render(
      React.createElement(
        loaded.ToastContext.Provider,
        {
          value: {
            toast: () => "toast",
            dismiss() {},
            toastCount: 0,
            dictationErrorActionCount: 0,
            dismissByPresentation() {},
          },
        },
        React.createElement(loaded.Coordinator, { surface: "onboarding", showUi: false })
      )
    );
  });
  await flush();
  assert.deepEqual(downloads, []);
  assert.equal(localStorage.getItem("enterpriseManagedLocalModelBindingsV1"), null);
  await React.act(async () => root.unmount());
});

test("configuration recovery retries the current authenticated workspace", async (t) => {
  const refreshes = [];
  const loaded = await loadCoordinator(t, inventory({ downloaded: true }));
  loaded.useEnterpriseIdentityStore.setState({
    ...identity,
    status: "error",
    error: "MANAGED_CONFIG_UNAVAILABLE",
    config: null,
    refresh: async (...args) => refreshes.push(args),
  });
  const root = createRoot(loaded.container);
  await React.act(async () => {
    root.render(
      React.createElement(
        loaded.ToastContext.Provider,
        {
          value: {
            toast: () => "toast",
            dismiss() {},
            toastCount: 0,
            dictationErrorActionCount: 0,
            dismissByPresentation() {},
          },
        },
        React.createElement(loaded.Coordinator, { surface: "onboarding", showUi: true })
      )
    );
  });
  const buttons = findElements(loaded.container, (element) => element.tagName === "BUTTON");
  assert.equal(buttons.length, 2);
  await React.act(async () => click(buttons[1]));
  assert.deepEqual(refreshes, [["account-1", "workspace-1", 7, true]]);
  assert.equal(loaded.container.textContent.includes("MANAGED_CONFIG_UNAVAILABLE"), false);
  await React.act(async () => root.unmount());
});

test("a stale transfer error cannot poison a newer configuration choosing the same model", async (t) => {
  let resolveFirstDownload;
  let downloaded = false;
  let downloadCount = 0;
  const firstDownload = new Promise((resolve) => {
    resolveFirstDownload = resolve;
  });
  const electronAPI = {
    ...inventory({ downloaded: false }),
    listWhisperModels: async () => ({
      models: [{ model: "base", downloaded, isDownloading: false }],
    }),
    downloadWhisperModel: async () => {
      downloadCount += 1;
      if (downloadCount === 1) return firstDownload;
      downloaded = true;
      return { success: true };
    },
  };
  const loaded = await loadCoordinator(t, electronAPI);
  const selections = [{ provider: "whisper", model: "base" }];
  loaded.useEnterpriseIdentityStore.setState(configuredState(selections));
  const readiness = [];
  const root = createRoot(loaded.container);
  await React.act(async () => {
    root.render(
      React.createElement(
        loaded.ToastContext.Provider,
        {
          value: {
            toast: () => "toast",
            dismiss() {},
            toastCount: 0,
            dictationErrorActionCount: 0,
            dismissByPresentation() {},
          },
        },
        React.createElement(loaded.Coordinator, {
          surface: "onboarding",
          showUi: true,
          onReadinessChange: (ready) => readiness.push(ready),
        })
      )
    );
  });
  await flush();
  assert.equal(downloadCount, 1);

  await React.act(async () => {
    loaded.useEnterpriseIdentityStore.setState({
      ...configuredState(selections),
      config: { generation: 12, localModels: { selections } },
    });
    await new Promise((resolve) => setImmediate(resolve));
  });
  localStorage.setItem(
    "pendingLocalModelSelectionsV1",
    JSON.stringify({
      dictation: {
        ...identity,
        configGeneration: 12,
        provider: "whisper",
        modelId: "base",
        transferState: "downloading",
      },
    })
  );
  await React.act(async () => {
    resolveFirstDownload({ success: false, error: "old transfer failed" });
    await new Promise((resolve) => setImmediate(resolve));
  });
  await flush();
  await flush();

  const binding = JSON.parse(localStorage.getItem("enterpriseManagedLocalModelBindingsV1"));
  assert.equal(downloadCount, 2);
  assert.equal(binding.dictation.configGeneration, 12);
  assert.equal(readiness.at(-1), true);
  assert.equal(
    JSON.parse(localStorage.getItem("pendingLocalModelSelectionsV1") ?? "{}").dictation,
    undefined
  );
  await React.act(async () => root.unmount());
});

test("an exact active transfer is onboarding-ready without starting a duplicate", async (t) => {
  const electronAPI = {
    ...inventory({ downloaded: false }),
    listWhisperModels: async () => ({
      models: [{ model: "base", downloaded: false, isDownloading: true, downloadProgress: 25 }],
    }),
    downloadWhisperModel: async () => assert.fail("must not duplicate an active transfer"),
  };
  const loaded = await loadCoordinator(t, electronAPI);
  loaded.useEnterpriseIdentityStore.setState(
    configuredState([{ provider: "whisper", model: "base" }])
  );
  const readiness = [];
  const root = await mountCoordinator(loaded, {
    surface: "onboarding",
    showUi: true,
    onReadinessChange: (ready) => readiness.push(ready),
  });
  await flush();
  assert.equal(readiness.at(-1), true);
  await React.act(async () => root.unmount());
});

test("selecting a later approved installed row applies that exact row", async (t) => {
  const electronAPI = {
    ...inventory({ downloaded: true }),
    listWhisperModels: async () => ({
      models: [
        { model: "base", downloaded: true, isDownloading: false },
        { model: "small", downloaded: true, isDownloading: false },
      ],
    }),
  };
  const loaded = await loadCoordinator(t, electronAPI);
  loaded.useEnterpriseIdentityStore.setState(
    configuredState([
      { provider: "whisper", model: "base" },
      { provider: "whisper", model: "small" },
    ])
  );
  const root = await mountCoordinator(loaded, { surface: "onboarding", showUi: true });
  await flush();
  const rows = findElements(loaded.container, (element) => element.tagName === "BUTTON");
  assert.equal(rows.length, 2);
  await React.act(async () => {
    click(rows[1]);
    await new Promise((resolve) => setImmediate(resolve));
  });
  const binding = JSON.parse(localStorage.getItem("enterpriseManagedLocalModelBindingsV1"));
  assert.equal(binding.dictation.model, "small");
  await React.act(async () => root.unmount());
});

test("assistant inventory uses the provider id when applying an installed model", async (t) => {
  const electronAPI = {
    ...inventory({ downloaded: true }),
    modelGetAll: async () => [
      { id: "assistant-model", providerId: "qwen", isDownloaded: true, isDownloading: false },
    ],
  };
  const loaded = await loadCoordinator(t, electronAPI);
  loaded.useEnterpriseIdentityStore.setState(
    configuredState([{ provider: "qwen", model: "assistant-model" }])
  );
  const readiness = [];
  const root = await mountCoordinator(loaded, {
    surface: "onboarding",
    showUi: true,
    onReadinessChange: (ready) => readiness.push(ready),
  });
  await flush();
  assert.equal(readiness.at(-1), true);
  await React.act(async () => root.unmount());
});
