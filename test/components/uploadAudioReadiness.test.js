const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

async function setup(t, { settings = {}, whisper = [], parakeet = [] } = {}) {
  let root;
  let download;
  let downloadProgress;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const events = new EventTarget();
  const inventory = { whisper, parakeet };
  const calls = { whisper: 0, parakeet: 0 };
  installBrowserGlobals(t, {
    window: {
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    },
  });
  const container = installHostDom(t);
  Object.assign(globalThis.window.electronAPI, {
    onWhisperDownloadProgress: (callback) => {
      downloadProgress = callback;
      return () => {
        downloadProgress = null;
      };
    },
    listWhisperModels: async () => {
      calls.whisper++;
      return { success: true, models: inventory.whisper };
    },
    listParakeetModels: async () => {
      calls.parakeet++;
      return { success: true, models: inventory.parakeet };
    },
  });
  const vite = await createRendererServer(t, {
    mockModules: {
      "/ui/useToast": `const toast = () => {}; export const useToast = () => ({ toast });`,
      "/hooks/useAuth": `export const useAuth = () => ({ isSignedIn: false, user: null });`,
      "/hooks/useUsage": `export const useUsage = () => ({ hasPaidAccessOptimistic: false });`,
      // Title generation owns an API-key cleanup timer unrelated to readiness.
      "/utils/generateTitle": `export const generateNoteTitle = async () => null;`,
      "/lib/auth": `export const withSessionRefresh = (fn) => fn();`,
      "/hooks/useSettings": `export const useSettings = () => ({});`,
    },
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState({
    uploadTranscriptionMode: "local",
    uploadUseLocalWhisper: true,
    uploadLocalTranscriptionProvider: "whisper",
    uploadWhisperModel: "tiny",
    ...settings,
  });
  const { default: UploadAudioView } = await vite.ssrLoadModule(
    "/components/notes/UploadAudioView.tsx"
  );
  const { useModelDownload } = await vite.ssrLoadModule("/hooks/useModelDownload.ts");
  function MountedUpload() {
    download = useModelDownload({ modelType: "whisper" });
    return React.createElement(UploadAudioView);
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(MountedUpload)));
  return {
    container,
    async removeAll() {
      const { removeLocalModels } = await vite.ssrLoadModule("/utils/localModelRemoval.ts");
      let success;
      await React.act(async () => {
        success = await removeLocalModels();
      });
      return success;
    },
    get download() {
      return download;
    },
    async progress(data) {
      await React.act(async () => downloadProgress(null, data));
    },
    inventory,
    calls,
    settings: useSettingsStore,
    async notify(name = "openwhispr-local-models-changed") {
      await React.act(async () => globalThis.window.dispatchEvent(new Event(name)));
    },
    async select(next) {
      await React.act(async () => useSettingsStore.setState(next));
    },
    async unmount() {
      await React.act(async () => root.unmount());
      root = null;
    },
  };
}

function assertReady(view, ready) {
  assert.equal(
    view.container.textContent.includes("No transcription provider set up"),
    !ready,
    view.container.textContent
  );
  const hasDropTarget = (node) =>
    node.getAttribute?.("aria-label") === "Drop an audio or video file, or click to browse" ||
    (node.childNodes ?? []).some(hasDropTarget);
  assert.equal(hasDropTarget(view.container), ready, "file selection follows readiness");
}

test("mounted Upload unlocks after the first local model installs without navigating away", async (t) => {
  const view = await setup(t);
  assertReady(view, false);
  let finishInstall;
  globalThis.window.electronAPI.downloadWhisperModel = () =>
    new Promise((resolve) => {
      finishInstall = resolve;
    });
  let pendingDownload;
  await React.act(async () => {
    pendingDownload = view.download.downloadModel("tiny");
  });
  await view.progress({ model: "tiny", type: "installing", percentage: 100 });
  assertReady(view, false);
  view.inventory.whisper = [{ model: "tiny", downloaded: true }];
  await React.act(async () => {
    finishInstall({ success: true });
    await pendingDownload;
  });
  assertReady(view, true);
  globalThis.window.electronAPI.deleteWhisperModel = async () => {
    view.inventory.whisper = [];
    return { success: true, freed_mb: 75 };
  };
  await React.act(async () => view.download.deleteModel("tiny"));
  assertReady(view, false);
});

for (const [provider, key, inventoryKey, model, otherModel] of [
  ["whisper", "uploadWhisperModel", "whisper", "tiny", "base"],
  [
    "nvidia",
    "uploadParakeetModel",
    "parakeet",
    "parakeet-tdt-0.6b-v3",
    "cohere-transcribe-03-2026",
  ],
  ["cohere", "uploadCohereModel", "parakeet", "cohere-transcribe-03-2026", "parakeet-tdt-0.6b-v3"],
]) {
  test(`${provider}: readiness follows the selected installed model and removal`, async (t) => {
    const view = await setup(t, {
      settings: { uploadLocalTranscriptionProvider: provider, [key]: model },
      [inventoryKey]: [{ model: otherModel, downloaded: true }],
    });
    assertReady(view, false);
    view.inventory[inventoryKey].push({ model, downloaded: true });
    await view.notify();
    assertReady(view, true);
    await view.select({ [key]: "not-installed" });
    assertReady(view, false);
    await view.select({ [key]: model });
    assertReady(view, true);
    view.inventory[inventoryKey] = [{ model: otherModel, downloaded: true }];
    await view.notify();
    assertReady(view, false);
    view.inventory[inventoryKey].push({ model, downloaded: true });
    await view.notify();
    assertReady(view, true);
    view.inventory[inventoryKey] = [];
    await view.notify("openwhispr-models-cleared");
    assertReady(view, false);
  });
}

test("a stale inventory response cannot re-enable Upload after model removal", async (t) => {
  const view = await setup(t);
  const pending = [];
  globalThis.window.electronAPI.listWhisperModels = () =>
    new Promise((resolve) => pending.push(resolve));
  await view.notify();
  await view.notify("openwhispr-models-cleared");
  assert.equal(pending.length, 2);
  await React.act(async () => pending[1]({ success: true, models: [] }));
  assertReady(view, false);
  await React.act(async () =>
    pending[0]({ success: true, models: [{ model: "tiny", downloaded: true }] })
  );
  assertReady(view, false);
});

test("changing the selected model invalidates a pending inventory response", async (t) => {
  const view = await setup(t);
  let resolveOld;
  globalThis.window.electronAPI.listWhisperModels = () =>
    new Promise((resolve) => {
      resolveOld = resolve;
    });
  await view.notify();
  globalThis.window.electronAPI.listWhisperModels = async () => ({ success: true, models: [] });
  await view.select({ uploadWhisperModel: "base" });
  assertReady(view, false);
  await React.act(async () =>
    resolveOld({ success: true, models: [{ model: "tiny", downloaded: true }] })
  );
  assertReady(view, false);
});

test("a failed inventory refresh closes readiness and a later success recovers", async (t) => {
  const view = await setup(t, { whisper: [{ model: "tiny", downloaded: true }] });
  assertReady(view, true);
  globalThis.window.electronAPI.listWhisperModels = async () => {
    throw new Error("inventory unavailable");
  };
  await view.notify();
  assertReady(view, false);
  globalThis.window.electronAPI.listWhisperModels = async () => ({
    success: true,
    models: view.inventory.whisper,
  });
  await view.notify();
  assertReady(view, true);
});

test("local inventory changes do not disturb self-hosted readiness or other scopes", async (t) => {
  const view = await setup(t, {
    settings: {
      uploadTranscriptionMode: "self-hosted",
      uploadUseLocalWhisper: false,
      uploadRemoteTranscriptionUrl: "http://localhost:8080",
      whisperModel: "small",
      meetingWhisperModel: "medium",
    },
  });
  assertReady(view, true);
  await view.notify();
  await view.notify("openwhispr-models-cleared");
  assertReady(view, true);
  assert.deepEqual(view.calls, { whisper: 0, parakeet: 0 });
  assert.equal(view.settings.getState().whisperModel, "small");
  assert.equal(view.settings.getState().meetingWhisperModel, "medium");
  await view.select({ uploadRemoteTranscriptionUrl: "" });
  assertReady(view, false);
});

test("unmount removes local inventory subscriptions", async (t) => {
  const view = await setup(t);
  await view.unmount();
  const count = view.calls.whisper;
  await view.notify();
  await view.notify("openwhispr-models-cleared");
  assert.equal(view.calls.whisper, count);
});

test("partial bulk deletion refreshes Upload without announcing all models cleared or changing scopes", async (t) => {
  const view = await setup(t, {
    whisper: [{ model: "tiny", downloaded: true }],
    settings: { whisperModel: "small", meetingWhisperModel: "medium" },
  });
  assertReady(view, true);
  let allCleared = false;
  globalThis.window.addEventListener("openwhispr-models-cleared", () => {
    allCleared = true;
  });
  globalThis.window.electronAPI.deleteAllWhisperModels = async () => {
    view.inventory.whisper = [];
    return { success: false, error: "another Whisper file could not be deleted" };
  };
  globalThis.window.electronAPI.deleteAllParakeetModels = async () => {
    throw new Error("busy");
  };
  globalThis.window.electronAPI.modelDeleteAll = async () => ({ success: false });
  assert.equal(await view.removeAll(), false);
  assertReady(view, false);
  assert.equal(allCleared, false);
  assert.equal(view.settings.getState().uploadWhisperModel, "tiny");
  assert.equal(view.settings.getState().whisperModel, "small");
  assert.equal(view.settings.getState().meetingWhisperModel, "medium");
});
