const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function boot(t, modelType, refresh) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  let listener;
  const hydration = deferred();
  installBrowserGlobals(t, {
    window: {
      dispatchEvent() {},
      electronAPI: {
        modelGetActiveDownloads: () => hydration.promise,
        onModelDownloadProgress: (callback) => {
          listener = callback;
          return () => {
            listener = null;
          };
        },
        onWhisperDownloadProgress: (callback) => {
          listener = callback;
          return () => {
            listener = null;
          };
        },
        onParakeetDownloadProgress: (callback) => {
          listener = callback;
          return () => {
            listener = null;
          };
        },
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `const t = key => key; export const useTranslation = () => ({t});`,
      "/components/ui/useToast": `export const useToast = () => ({toast() {}});`,
      "/stores/settingsStore": `export const clearMissingLocalModelSelections = () => {};`,
    },
  });
  const module = await vite.ssrLoadModule("/hooks/useModelDownload.ts");
  let current;
  function Owner() {
    current = module.useModelDownload({ modelType, onDownloadComplete: refresh });
    return null;
  }
  root = createRoot(container);
  await React.act(async () =>
    root.render(React.createElement(React.StrictMode, null, React.createElement(Owner)))
  );
  return { ...module, hydration, read: () => current, emit: (event) => listener(undefined, event) };
}
const status = (modelType, sequence, modelId = "A") => ({
  modelType,
  modelId,
  sequence,
  phase: "downloading",
  progress: 100,
  downloadedBytes: 10,
  totalBytes: 10,
});

test("download transitions replay identically without mutating inputs; terminal watermarks and model ordering stay in state", async (t) => {
  const { modelDownloadTransition: transition } = await boot(t, "llm", async () => {});
  const empty = Object.freeze({ downloads: Object.freeze({}), terminals: Object.freeze({}) });
  assert.equal(
    transition(empty, { type: "remove", modelId: "A" }),
    empty,
    "terminal settlement before hydration has no row to remove"
  );
  const action = Object.freeze({ type: "progress", status: Object.freeze(status("llm", 3)) });
  assert.deepEqual(transition(empty, action), transition(empty, action));
  let state = transition(empty, action);
  state = transition(state, { type: "terminal", modelId: "A", sequence: 4 });
  state = transition(state, { type: "remove", modelId: "A", sequence: 4 });
  for (const sequence of [0, 2, 3, 4])
    assert.equal(transition(state, { type: "progress", status: status("llm", sequence) }), state);
  state = transition(state, { type: "start", status: status("llm", 0) });
  assert.equal(state.downloads.A.sequence, 0, "explicit Retry may start again");
  state = transition(state, { type: "progress", status: status("llm", 6) });
  assert.equal(
    transition(state, { type: "remove", modelId: "A", sequence: 4 }),
    state,
    "old completion cannot remove newer progress"
  );
  const before = structuredClone(state);
  const next = { type: "terminal", modelId: "A", sequence: 7 };
  assert.deepEqual(transition(state, next), transition(state, next));
  assert.deepEqual(state, before);
  assert.deepEqual(empty, { downloads: {}, terminals: {} });
});

for (const modelType of ["llm", "whisper", "parakeet"]) {
  for (const outcome of ["complete", "cancel", "error"]) {
    test(`${modelType} queued ${outcome} rejects late progress and stale hydration while reconciliation is pending`, async (t) => {
      const refresh = deferred();
      const renderer = await boot(t, modelType, () => refresh.promise);
      const event = (type, sequence) =>
        modelType === "llm"
          ? { modelId: "A", type, sequence, progress: 100 }
          : { model: "A", type, sequence, percentage: 100 };
      await React.act(async () => {
        renderer.emit(event(modelType === "llm" ? "progress" : "installing", 2));
        renderer.emit({
          ...event(outcome === "complete" ? "complete" : "error", 3),
          error: outcome === "cancel" ? "Download cancelled by user" : "ENOTFOUND",
          code: outcome === "cancel" ? "DOWNLOAD_CANCELLED" : "ENOTFOUND",
        });
        renderer.emit(event(modelType === "llm" ? "progress" : "installing", 2));
        renderer.emit(event(modelType === "llm" ? "progress" : "installing", undefined));
      });
      await React.act(async () =>
        renderer.hydration.resolve([status(modelType, 1), status(modelType, 1, "B")])
      );
      assert.equal(
        renderer.read().downloads.A.sequence,
        2,
        "late progress must not replace the terminal's last row while settling"
      );
      await React.act(async () => refresh.resolve());
      assert.equal(renderer.read().isDownloadingModel("A"), false);
      assert.equal(renderer.read().isDownloadingModel("B"), true, "other model remains active");
      await React.act(async () =>
        renderer.emit(event(modelType === "llm" ? "progress" : "installing", 2))
      );
      assert.equal(renderer.read().isDownloadingModel("A"), false);
      assert.equal(Boolean(renderer.read().downloadErrors.A), outcome === "error");
    });
  }
}

test("a newer same-model terminal during pending reconciliation cannot leave its progress resurrected", async (t) => {
  const refresh = deferred();
  const renderer = await boot(t, "llm", () => refresh.promise);
  await React.act(async () => {
    renderer.emit({ type: "progress", modelId: "A", progress: 100, sequence: 2 });
    renderer.emit({ type: "complete", modelId: "A", sequence: 3 });
    renderer.emit({ type: "progress", modelId: "A", progress: 100, sequence: 4 });
  });
  assert.equal(renderer.read().downloads.A.sequence, 4);
  await React.act(async () => renderer.emit({ type: "complete", modelId: "A", sequence: 5 }));
  await React.act(async () => refresh.resolve());
  assert.equal(renderer.read().isDownloadingModel("A"), false);
  await React.act(async () => renderer.hydration.resolve([status("llm", 4)]));
  assert.equal(renderer.read().isDownloadingModel("A"), false);
});
