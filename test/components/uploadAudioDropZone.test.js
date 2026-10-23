const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");

const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { findElement, installInteractiveDom } = require("../lib/interactiveDom");

// Upload audio, with the stores and services it reads at mount stood in for: a managed
// transcription scope makes the provider ready, so the idle drop zone shows.
const MOCKS = {
  "react-i18next": `
    const t = (key, values) => (values ? key + JSON.stringify(values) : key);
    export const useTranslation = () => ({ t, i18n: { language: "en" } });
    export const initReactI18next = { type: "3rdParty", init() {} };
  `,
  "/hooks/useAuth": `
    export const useAuth = () => ({ isLoaded: true, isSignedIn: false, user: null });
  `,
  "/hooks/useUsage": `export const useUsage = () => null;`,
  "/hooks/useSettings": `export const useSettings = () => ({});`,
  "/stores/settingsStore": `
    const state = {
      setUploadTranscriptionMode() {},
      setUploadCloudTranscriptionMode() {},
      setUploadUseLocalWhisper() {},
      useCleanupModel: false,
      preferredLanguage: "en",
    };
    export const useSettingsStore = (selector) => selector(state);
    export const getSettings = () => state;
    export const selectPolicyEffectiveSettings = (settings) => settings;
    export const selectIsCloudCleanupMode = () => false;
    export const selectResolvedUploadTranscription = () => ({
      useLocalWhisper: false,
      cloudTranscriptionMode: "openwhispr",
      cloudTranscriptionProvider: "openai",
      cloudTranscriptionModel: "whisper-1",
      transcriptionMode: "cloud",
    });
  `,
  "/stores/batchQueueStore": `export const useBatchQueue = () => globalThis.__uploadBatch;`,
  "/BatchQueueView": `export default function BatchQueueView() { return null; }`,
  "/hooks/usePolicy": `
    export const usePolicySnapshot = () => ({});
    export const useTranscriptionContextAllowed = () => true;
  `,
  "/stores/policyStore": `export const usePolicyStore = (selector) => selector({});`,
  "/stores/enterpriseIdentityStore": `
    export const useManagedScopeResolution = () => ({ kind: "managed" });
  `,
  "/services/managedTranscription": `export const isManagedTranscriptionActive = () => true;`,
  "/services/fileTranscription": `
    export const transcribeFileWithSpeakers = async () => ({});
    export const resolveDiarizationSettings = async () => ({});
    export const shouldUseByokDiarize = () => false;
    export const getTranscriptionApiKey = () => "";
  `,
  // Its reasoning service starts a cleanup interval when it loads, which would keep the
  // test process alive; titles are only generated after a transcription.
  "/utils/generateTitle": `export const generateNoteTitle = async () => "";`,
  "/services/uploadNotes": `
    export const saveUploadNote = async () => null;
    export const uploadTitleFallback = () => "";
  `,
};

function dispatch(element, type, init = {}) {
  element.dispatchEvent({
    type,
    bubbles: true,
    button: 0,
    defaultPrevented: false,
    cancelBubble: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.cancelBubble = true;
    },
    ...init,
  });
}

const settle = () => React.act(async () => new Promise((resolve) => setImmediate(resolve)));

async function renderUploadAudio(t) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const calls = { browses: [], added: [] };
  globalThis.__uploadBatch = {
    isProcessing: false,
    hasQueue: false,
    queue: [],
    addFiles: (items) => calls.added.push(items),
  };
  t.after(() => delete globalThis.__uploadBatch);
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        selectAudioFile: async (options) => {
          calls.browses.push(options);
          return { canceled: true };
        },
        getPathForFile: (file) => `/files/${file.name}`,
        getDiarizationModelStatus: async () => ({ modelsDownloaded: false }),
        cancelUrlDownload() {},
        deleteTempFile() {},
      },
    },
  });
  const container = installInteractiveDom(t);
  const { createRoot } = require("react-dom/client");
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-upload-audio-drop-zone-test-",
    noExternal: ["react-i18next"],
    mockModules: MOCKS,
  });
  const { default: UploadAudioView } = await vite.ssrLoadModule(
    "/components/notes/UploadAudioView.tsx"
  );
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(UploadAudioView, {})));
  await settle();
  const zone = () =>
    findElement(
      container,
      (node) => node.getAttribute("aria-label") === "notes.upload.dropOrBrowse"
    );
  return { container, calls, zone };
}

test("the upload drop zone is a keyboard button that browses on Enter and Space", async (t) => {
  const { calls, zone } = await renderUploadAudio(t);

  assert.deepEqual([zone().getAttribute("role"), zone().getAttribute("tabindex")], ["button", "0"]);
  await React.act(async () => dispatch(zone(), "keydown", { key: "Enter" }));
  await React.act(async () => dispatch(zone(), "keydown", { key: " " }));
  await React.act(async () => dispatch(zone(), "keydown", { key: "a" }));
  await React.act(async () => dispatch(zone(), "click"));

  assert.equal(calls.browses.length, 3);
  assert.deepEqual(calls.browses[0], { multiple: true });
});

test("dragging over shows Drop to upload and the pulse, and leaving clears it", async (t) => {
  const { container, zone } = await renderUploadAudio(t);
  const target = zone();

  await React.act(async () => dispatch(target, "dragover"));
  assert.match(target.textContent, /notes\.upload\.dropToUpload/);
  assert.doesNotMatch(target.textContent, /notes\.upload\.supportedFormats/);
  assert.equal(target.style.animation, "drag-pulse 1.5s ease-in-out infinite");
  assert.match(target.getAttribute("class"), /border-primary\/60/);

  await React.act(async () => dispatch(target, "dragleave"));
  assert.match(target.textContent, /notes\.upload\.dropOrBrowse/);
  assert.match(target.textContent, /notes\.upload\.supportedFormats/);
  assert.ok(!target.style.animation);
  assert.equal(container.contains(target), true);
});

test(
  "a drop keeps supported files, names the skipped ones, and opens one file or queues several",
  async (t) => {
    const { container, calls, zone } = await renderUploadAudio(t);
    const files = (...entries) => entries.map(([name, size]) => ({ name, size }));

    const dropped = files(["talk.mp3", 2048], ["notes.txt", 5]);
    await React.act(async () => dispatch(zone(), "drop", { dataTransfer: { files: dropped } }));

    assert.match(container.textContent, /notes\.upload\.unsupportedFiles\{"names":"notes\.txt"\}/);
    // One supported file opens it rather than starting a queue
    assert.match(container.textContent, /talk\.mp3/);
    assert.equal(zone(), null);
    assert.deepEqual(calls.added, []);
  }
);

test("several supported files go to the queue", async (t) => {
  const { container, calls, zone } = await renderUploadAudio(t);
  const files = [
    { name: "one.mp3", size: 10 },
    { name: "two.wav", size: 20 },
  ];

  await React.act(async () => dispatch(zone(), "drop", { dataTransfer: { files } }));

  assert.deepEqual(calls.added, [
    [
      { name: "one.mp3", path: "/files/one.mp3", sizeBytes: 10 },
      { name: "two.wav", path: "/files/two.wav", sizeBytes: 20 },
    ],
  ]);
  assert.doesNotMatch(container.textContent, /notes\.upload\.unsupportedFiles/);
});
