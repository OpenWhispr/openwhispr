const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { click, findElements, installManagedLocalTestDom } = require("./managedLocalTestDom");

const pending = {
  provider: "whisper",
  modelId: "base",
  accountId: "account-1",
  workspaceId: "workspace-1",
  authGeneration: 7,
  configGeneration: 11,
  transferState: "downloading",
};

test("accepted managed cancellation persists an exact retryable missing selection", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: { pendingLocalModelSelectionsV1: JSON.stringify({ dictation: pending }) },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-managed-cancel-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `export const useTranslation = () => ({ t: (key) => key });`,
      "/ui/ProviderIcon": `export const ProviderIcon = () => null;`,
      OnboardingShell: `export const BrandMark = () => null;`,
      "/stores/settingsStore": `export const useSettingsStore = { getState: () => ({}) };`,
    },
  });
  const { markManagedPendingLocalModelCancelled } = await vite.ssrLoadModule(
    "/components/onboarding/pendingLocalModels.ts"
  );
  assert.equal(markManagedPendingLocalModelCancelled("dictation", pending), true);
  assert.deepEqual(JSON.parse(localStorage.getItem("pendingLocalModelSelectionsV1")).dictation, {
    ...pending,
    transferState: "missing",
    errorCode: "DOWNLOAD_CANCELLED",
  });
});

async function mountTray(t, { initialPending, inventory, cancelWhisperDownload }) {
  let onWhisperProgress;
  installBrowserGlobals(t, {
    initialStorage: {
      pendingLocalModelSelectionsV1: JSON.stringify({ dictation: initialPending }),
      localSetupPending: "true",
    },
    window: {
      electronAPI: {
        listWhisperModels: async () => ({ models: inventory }),
        listParakeetModels: async () => ({ models: [] }),
        modelGetAll: async () => [],
        onWhisperDownloadProgress: (callback) => {
          onWhisperProgress = callback;
          return () => {};
        },
        onParakeetDownloadProgress: () => () => {},
        onModelDownloadProgress: () => () => {},
        cancelWhisperDownload,
      },
    },
  });
  const { container, createContainer } = installManagedLocalTestDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-mounted-managed-tray-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `const t = (key) => key; export const useTranslation = () => ({ t });`,
      "/ui/ProviderIcon": `export const ProviderIcon = () => null;`,
      OnboardingShell: `export const BrandMark = () => null;`,
      "/stores/settingsStore": `export const useSettingsStore = { getState: () => ({}) };`,
    },
  });
  const { default: Tray } = await vite.ssrLoadModule(
    "/components/onboarding/BackgroundModelDownloadTray.tsx"
  );
  const root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Tray));
    await new Promise((resolve) => setImmediate(resolve));
  });
  return { container, createContainer, onWhisperProgress, root, Tray };
}

test("accepted stale managed cancellation cannot overwrite the current exact pending row", async (t) => {
  let resolveCancellation;
  const mounted = await mountTray(t, {
    initialPending: pending,
    inventory: [{ model: "base", downloaded: false, isDownloading: true, downloadProgress: 25 }],
    cancelWhisperDownload: () =>
      new Promise((resolve) => {
        resolveCancellation = resolve;
      }),
  });
  const cancel = findElements(mounted.container, (element) => element.tagName === "BUTTON")[0];
  await React.act(async () => click(cancel));
  const replacement = { ...pending, configGeneration: 12 };
  localStorage.setItem(
    "pendingLocalModelSelectionsV1",
    JSON.stringify({ dictation: replacement })
  );
  await React.act(async () => {
    resolveCancellation({ success: true });
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.deepEqual(
    JSON.parse(localStorage.getItem("pendingLocalModelSelectionsV1")).dictation,
    replacement
  );
  await React.act(async () => mounted.root.unmount());
});

test("managed cancellation recovery survives tray remount and dismiss", async (t) => {
  const mounted = await mountTray(t, {
    initialPending: pending,
    inventory: [{ model: "base", downloaded: false, isDownloading: true, downloadProgress: 25 }],
    cancelWhisperDownload: async () => ({ success: true }),
  });
  const cancel = findElements(mounted.container, (element) => element.tagName === "BUTTON")[0];
  await React.act(async () => {
    click(cancel);
    await new Promise((resolve) => setImmediate(resolve));
  });
  const cancelled = { ...pending, transferState: "missing", errorCode: "DOWNLOAD_CANCELLED" };
  assert.deepEqual(
    JSON.parse(localStorage.getItem("pendingLocalModelSelectionsV1")).dictation,
    cancelled
  );
  await React.act(async () => mounted.root.unmount());

  const remountContainer = mounted.createContainer();
  const remountedRoot = createRoot(remountContainer);
  await React.act(async () => {
    remountedRoot.render(React.createElement(mounted.Tray));
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.match(remountContainer.textContent, /onboarding\.managedLocal\.errors\.cancelled/);
  assert.deepEqual(
    JSON.parse(localStorage.getItem("pendingLocalModelSelectionsV1")).dictation,
    cancelled
  );

  const dismiss = findElements(remountContainer, (element) => element.tagName === "BUTTON")[0];
  await React.act(async () => click(dismiss));
  assert.deepEqual(
    JSON.parse(localStorage.getItem("pendingLocalModelSelectionsV1")).dictation,
    cancelled
  );
  assert.match(remountContainer.textContent, /onboarding\.managedLocal\.errors\.cancelled/);
  await React.act(async () => remountedRoot.unmount());
});

test("refused cancellation restores only the still-current row", async (t) => {
  let resolveCancellation;
  const mounted = await mountTray(t, {
    initialPending: pending,
    inventory: [{ model: "base", downloaded: false, isDownloading: true, downloadProgress: 25 }],
    cancelWhisperDownload: () =>
      new Promise((resolve) => {
        resolveCancellation = resolve;
      }),
  });
  const cancel = findElements(mounted.container, (element) => element.tagName === "BUTTON")[0];
  await React.act(async () => click(cancel));
  localStorage.setItem(
    "pendingLocalModelSelectionsV1",
    JSON.stringify({ dictation: { ...pending, configGeneration: 12 } })
  );
  await React.act(async () => {
    resolveCancellation({ success: false });
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(mounted.container.textContent, "");
  await React.act(async () => mounted.root.unmount());
});

test("accepted personal cancellation retains ordinary pending cleanup", async (t) => {
  const personal = { provider: "whisper", modelId: "base" };
  const mounted = await mountTray(t, {
    initialPending: personal,
    inventory: [{ model: "base", downloaded: false, isDownloading: true, downloadProgress: 25 }],
    cancelWhisperDownload: async () => ({ success: true }),
  });
  const cancel = findElements(mounted.container, (element) => element.tagName === "BUTTON")[0];
  await React.act(async () => {
    click(cancel);
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(JSON.parse(localStorage.getItem("pendingLocalModelSelectionsV1") ?? "{}").dictation, undefined);
  await React.act(async () => mounted.root.unmount());
});
