const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { useStore } = require("zustand");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");
const { deferred } = require("../lib/settingsAuditHarness");

test("SettingsHost routes opens and releases its main-process listeners", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__gpuBannerOptions;
    delete globalThis.__settingsModalProps;
  });
  let keydown;
  let showSettingsFromMain;
  let readyHost;
  const acknowledgements = [];
  const { window } = installBrowserGlobals(t, {
    window: {
      addEventListener(type, listener) {
        if (type === "keydown") keydown = listener;
      },
      removeEventListener(type, listener) {
        if (type === "keydown" && keydown === listener) keydown = undefined;
      },
      electronAPI: {
        getPlatform: () => "linux",
        getSettingsDocumentId: async () => 1,
        setSettingsHostReady(id, ready) {
          readyHost = ready ? id : undefined;
        },
        acknowledgeSettingsOpen(id, requestId) {
          acknowledgements.push({ id, requestId });
        },
        onShowSettings(listener) {
          showSettingsFromMain = listener;
          return () => {
            showSettingsFromMain = undefined;
          };
        },
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-settings-host-test-",
    noExternal: ["react-i18next"],
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
    mockModules: {
      "react-i18next": `
        export function useTranslation() { return { t: (key) => key }; }
        export const initReactI18next = { type: "3rdParty", init() {} };
      `,
      "/hooks/usePolicy": `export function usePolicySnapshot() { return {}; }`,
      "/hooks/useGpuBannerAvailability": `
        const EMPTY = { transcription: false, intelligence: null };
        export function useGpuBannerAvailability(options) {
          globalThis.__gpuBannerOptions = options;
          return EMPTY;
        }
      `,
      "/stores/policyStore": `import {create} from "zustand"; export const usePolicyStore = create(() => ({status: "unmanaged", policy: null, appVersion: null}));`,
      "/stores/settingsStore": `
        const settings = {
          useLocalWhisper: false,
          localTranscriptionProvider: "whisper",
          useCleanupModel: false,
          cleanupMode: "openwhispr",
          useDictationAgent: false,
          dictationAgentMode: "openwhispr"
        };
        export function selectPolicyEffectiveSettings() { return settings; }
        export function useSettingsStore(selector) { return selector(settings); }
      `,
      "/SettingsModal": `
        export default function SettingsModal(props) {
          globalThis.__settingsModalProps = props;
          return null;
        }
      `,
    },
  });
  const { SettingsHost } = await vite.ssrLoadModule("/components/SettingsHost.tsx");
  const { GpuAccelerationBanner } = await vite.ssrLoadModule(
    "/components/GpuAccelerationBanner.tsx"
  );
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  let openSettings;
  function NavigationChild({ navigation }) {
    openSettings = useStore(navigation, (state) => state.openSettings);
    return React.createElement(GpuAccelerationBanner, { navigation });
  }
  root = createRoot(container);
  await React.act(async () => {
    root.render(
      React.createElement(SettingsHost, { initialSection: "transcription" }, (navigation) =>
        React.createElement(NavigationChild, { navigation })
      )
    );
    await flush();
  });
  // React.lazy's mocked module may resolve after the initial Suspense commit.
  for (let i = 0; i < 50 && !globalThis.__settingsModalProps; i++) {
    await React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  assert.equal(globalThis.__settingsModalProps.navigation.getState().section, "speechToText");
  assert.equal(globalThis.__settingsModalProps.navigation.getState().speechTab, "dictation");

  await React.act(async () => globalThis.__settingsModalProps.onOpenChange(false));
  assert.equal(globalThis.__gpuBannerOptions.settingsOpen, false);

  await React.act(async () => {
    let prevented = false;
    keydown({ ctrlKey: true, key: ",", preventDefault: () => (prevented = true) });
    assert.equal(prevented, true);
    await flush();
  });
  assert.equal(globalThis.__settingsModalProps.navigation.getState().section, "account");

  await React.act(async () => globalThis.__settingsModalProps.onOpenChange(false));
  await React.act(async () => {
    showSettingsFromMain({ hostId: "disposed", requestId: 1 });
    assert.equal(globalThis.__gpuBannerOptions.settingsOpen, false);
    showSettingsFromMain({ hostId: readyHost, requestId: 2 });
    await flush();
  });
  assert.equal(globalThis.__gpuBannerOptions.settingsOpen, true);

  const modal = globalThis.__settingsModalProps;
  await React.act(async () => {
    showSettingsFromMain({ hostId: readyHost, requestId: 3, section: "llms" });
    await flush();
  });
  assert.equal(modal.navigation.getState().section, "llms");
  assert.strictEqual(globalThis.__settingsModalProps.navigation, modal.navigation);
  await React.act(async () => {
    openSettings("general");
    showSettingsFromMain({ hostId: readyHost, requestId: 4, section: "llms" });
    await flush();
  });
  assert.equal(modal.navigation.getState().section, "llms", "a repeated named open navigates again");
  await React.act(async () => {
    showSettingsFromMain({ hostId: readyHost, requestId: 5 });
    await flush();
  });
  assert.equal(modal.navigation.getState().section, "llms", "a plain open keeps the current section");

  // Ported from the readiness test: a disposed host cannot consume a late
  // document read or an already-queued callback after its cleanup.
  const reads = [];
  const readyLog = [];
  const showListeners = [];
  let currentListener = null;
  const stores = [];
  const portChild = (navigation) => {
    stores.push(navigation);
    return null;
  };
  window.electronAPI.getSettingsDocumentId = () => {
    const request = deferred();
    reads.push(request);
    return request.promise;
  };
  window.electronAPI.setSettingsHostReady = (id, value) => {
    readyLog.push({ id, value });
    if (value) {
      readyHost = id;
      currentListener?.({ hostId: id, requestId: 10 });
    } else if (readyHost === id) readyHost = undefined;
  };
  window.electronAPI.onShowSettings = (listener) => {
    showListeners.push(listener);
    currentListener = listener;
    return () => {
      if (currentListener === listener) currentListener = null;
    };
  };
  await React.act(async () =>
    root.render(React.createElement(SettingsHost, { key: "old" }, portChild))
  );
  await React.act(async () => root.render(null));
  await React.act(async () =>
    root.render(React.createElement(SettingsHost, { key: "new" }, portChild))
  );
  await React.act(async () => {
    await reads[0].resolve(1);
    await flush();
  });
  assert.equal(
    readyLog.filter((entry) => entry.value).length,
    0,
    "late document read cannot revive a disposed host"
  );
  await React.act(async () => {
    await reads[1].resolve(1);
    await flush();
  });
  assert.equal(readyLog.filter((entry) => entry.value).length, 1);
  assert.equal(stores.at(-1).getState().section, "account");
  assert.deepEqual(
    acknowledgements.map((item) => item.requestId),
    [2, 3, 4, 5, 10]
  );
  const queuedHostId = readyLog.find((entry) => entry.value).id;
  await React.act(async () => root.render(null));
  assert.equal(readyLog.at(-1).value, false);
  const acked = acknowledgements.length;
  await React.act(async () => showListeners[1]({ hostId: queuedHostId, requestId: 11 }));
  assert.equal(acknowledgements.length, acked, "queued callback cannot consume after cleanup");
  assert.equal(currentListener, null);
  root = null;
  assert.deepEqual(
    acknowledgements.map((item) => item.requestId),
    [2, 3, 4, 5, 10]
  );
});
