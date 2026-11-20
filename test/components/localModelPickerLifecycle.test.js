const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

test("retained local picker loads disk state once per mount and balances progress listeners", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__localPickerCards;
    delete globalThis.__localPickerActions;
  });
  let inventory = 0;
  let hydration = 0;
  let registrations = 0;
  let cleanups = 0;
  const listeners = new Set();
  const events = new EventTarget();
  installBrowserGlobals(t, {
    window: {
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
      electronAPI: {
        modelGetAll: async () => {
          inventory++;
          return [{ id: "local-one", isDownloaded: true }];
        },
        modelGetActiveDownloads: async () => {
          hydration++;
          return [
            {
              modelType: "llm",
              modelId: "local-one",
              sequence: 1,
              phase: "downloading",
              progress: 42,
            },
          ];
        },
        onModelDownloadProgress: (listener) => {
          registrations++;
          listeners.add(listener);
          return () => {
            cleanups++;
            listeners.delete(listener);
          };
        },
      },
    },
  });
  const container = installHostDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-local-picker-lifecycle-test-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        const t = (key) => key;
        export function useTranslation() { return { t }; }
      `,
      "/ui/ProviderTabs": `export const ProviderTabs = () => null;`,
      "/ui/DownloadProgressBar": `export const DownloadProgressBar = () => null;`,
      "/ui/dialog": `export const ConfirmDialog = () => null;`,
      "/ui/ModelCardList": `
        export default function ModelCardList(props) {
          globalThis.__localPickerCards = props.models;
          globalThis.__localPickerActions = props;
          return null;
        }
      `,
      "/hooks/useDialogs": `
        const showAlertDialog = () => {};
        const showConfirmDialog = () => {};
        const hideConfirmDialog = () => {};
        export function useDialogs() {
          return { confirmDialog: { open: false }, showAlertDialog, showConfirmDialog, hideConfirmDialog };
        }
      `,
      "/components/ui/useToast": `
        const context = { toast() {} };
        export function useToast() { return context; }
      `,
      "/stores/settingsStore": `export function clearMissingLocalModelSelections() {} export const useSettingsStore = {}; export const selectResolvedLLMConfig = () => ({});`,
      "/utils/providerIcons": `
        export function getProviderIcon() { return ""; }
        export function isMonochromeProvider() { return false; }
      `,
    },
  });
  const { default: LocalModelPicker } = await vite.ssrLoadModule(
    "/components/LocalModelPicker.tsx"
  );
  const providers = [
    { id: "local", name: "Local", models: [{ id: "local-one", name: "One", size: "1 MB" }] },
  ];
  const renderPicker = async (onModelSelect, selectedModel = "", overrides = {}) =>
    React.act(async () =>
      root.render(
        React.createElement(LocalModelPicker, {
          providers,
          selectedModel,
          selectedProvider: "local",
          onModelSelect,
          onProviderSelect() {},
          modelType: "llm",
          ...overrides,
        })
      )
    );

  root = createRoot(container);
  await renderPicker(() => {});
  assert.deepEqual(
    [inventory, hydration, registrations, cleanups, listeners.size],
    [1, 1, 1, 0, 1]
  );
  assert.equal(globalThis.__localPickerCards[0].isDownloaded, true);
  assert.equal(globalThis.__localPickerCards[0].isDownloading, true);

  for (let i = 0; i < 3; i++) await renderPicker(() => {});
  assert.deepEqual(
    [inventory, hydration, registrations, cleanups, listeners.size],
    [1, 1, 1, 0, 1],
    "callback-only tab/section renders do not re-query inventory or multiply listeners"
  );

  await React.act(async () => root.unmount());
  root = null;
  assert.deepEqual([registrations, cleanups, listeners.size], [1, 1, 0]);

  root = createRoot(container);
  await renderPicker(() => {});
  assert.deepEqual(
    [inventory, hydration, registrations, cleanups, listeners.size],
    [2, 2, 2, 1, 1],
    "a late-mounted picker hydrates disk and active-download state once"
  );
  await React.act(async () => root.unmount());
  root = null;
  assert.deepEqual([registrations, cleanups, listeners.size], [2, 2, 0]);

  // Reconciliation acts (stale replies, confirmed-empty clears, unmounted owners) live in transcriptionInventoryReconciliation.
  const api = globalThis.window.electronAPI;
  const selected = [];
  const select = (id) => selected.push(id);
  const remount = async () => {
    if (root) await React.act(async () => root.unmount());
    root = createRoot(container);
    selected.length = 0;
  };
  await remount();
  api.modelGetAll = async () => {
    throw new Error("inventory unavailable");
  };
  await renderPicker(select, "local-one");
  assert.deepEqual(selected, []);
  api.modelDownload = async () => ({ success: true });
  await React.act(async () => globalThis.__localPickerActions.onDownload("local-two"));
  assert.deepEqual(selected, [], "unknown inventory cannot justify replacing the selection");
  api.modelGetAll = async () => [{ id: "local-one", isDownloaded: true }];
  await React.act(async () => events.dispatchEvent(new Event("openwhispr-models-cleared")));
  assert.equal(globalThis.__localPickerCards[0].isDownloaded, true);
  assert.deepEqual(selected, []);
});
