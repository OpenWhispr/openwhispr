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

async function renderUploadAudio(t, { batch = {}, electronAPI = {}, mocks = {} } = {}) {
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
    ...batch,
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
        ...electronAPI,
      },
    },
  });
  const container = installInteractiveDom(t);
  const { createRoot } = require("react-dom/client");
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-upload-audio-drop-zone-test-",
    noExternal: ["react-i18next"],
    mockModules: { ...MOCKS, ...mocks },
  });
  const { default: UploadAudioView } = await vite.ssrLoadModule(
    "/components/notes/UploadAudioView.tsx"
  );
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", policy: null });
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(UploadAudioView, {})));
  await settle();
  const zone = () =>
    findElement(
      container,
      (node) => node.getAttribute("aria-label") === "notes.upload.dropOrBrowse"
    );
  return { container, calls, zone, usePolicyStore };
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

test("a drop keeps supported files, names the skipped ones, and opens one file or queues several", async (t) => {
  const { container, calls, zone } = await renderUploadAudio(t);
  const files = (...entries) => entries.map(([name, size]) => ({ name, size }));

  const dropped = files(["talk.mp3", 2048], ["notes.txt", 5]);
  await React.act(async () => dispatch(zone(), "drop", { dataTransfer: { files: dropped } }));

  assert.match(container.textContent, /notes\.upload\.unsupportedFiles\{"names":"notes\.txt"\}/);
  // One supported file opens it rather than starting a queue
  assert.match(container.textContent, /talk\.mp3/);
  assert.equal(zone(), null);
  assert.deepEqual(calls.added, []);
});

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

test("the shared upload zone blocks restricted inputs and resumes when policy allows upload", async (t) => {
  const { container, calls, zone, usePolicyStore } = await renderUploadAudio(t);
  await React.act(async () => dispatch(zone(), "dragover"));
  assert.match(zone().textContent, /notes\.upload\.dropToUpload/);

  for (const policy of [
    { status: "managed", policy: { features: { audioUploadEnabled: false } } },
    { status: "loading", policy: null },
  ]) {
    await React.act(async () => usePolicyStore.setState(policy));
    assert.equal(zone().getAttribute("aria-disabled"), "true");
    const banner = findElement(container, (node) => node.getAttribute("role") === "status");
    assert.ok(banner);
    assert.equal(zone().getAttribute("aria-describedby"), banner.getAttribute("id"));
    assert.ok(!zone().style.animation);
    for (const [type, init] of [
      ["click", {}],
      ["keydown", { key: "Enter" }],
      ["keydown", { key: " " }],
      ["dragover", {}],
      ["drop", { dataTransfer: { files: [{ name: "blocked.mp3", size: 10 }] } }],
    ]) {
      await React.act(async () => dispatch(zone(), type, init));
    }
    assert.equal(calls.browses.length, 0);
    assert.deepEqual(calls.added, []);
    assert.doesNotMatch(container.textContent, /blocked\.mp3/);
    assert.doesNotMatch(zone().textContent, /notes\.upload\.dropToUpload/);
  }

  await React.act(async () => usePolicyStore.setState({ status: "unmanaged", policy: null }));
  assert.equal(zone().getAttribute("aria-disabled"), null);
  assert.equal(zone().getAttribute("aria-describedby"), null);
  await React.act(async () => dispatch(zone(), "keydown", { key: "Enter" }));
  assert.equal(calls.browses.length, 1);
  await React.act(async () =>
    dispatch(zone(), "drop", {
      dataTransfer: { files: [{ name: "allowed.mp3", size: 10 }] },
    })
  );
  assert.match(container.textContent, /allowed\.mp3/);
});

test("the default Meetings folder and its subfolders are listed but take no uploads", async (t) => {
  const folder = (id, name, is_default = 0, parent_folder_id = null) => ({
    id,
    name,
    is_default,
    space_id: 1,
    parent_folder_id,
  });
  const { container } = await renderUploadAudio(t, {
    batch: { hasQueue: true, hasPending: true },
    electronAPI: {
      getSpaces: async () => [{ id: 1, kind: "private" }],
      getFolders: async () => [
        folder(3, "Client A", 0, 2),
        folder(1, "Personal", 1),
        folder(2, "Meetings", 1),
        folder(4, "Work"),
        folder(5, "Q1", 0, 4),
      ],
    },
    mocks: {
      "/ui/select": `
        import { createElement } from "react";
        const pass = ({ children }) => children;
        export const Select = pass;
        export const SelectTrigger = pass;
        export const SelectValue = () => null;
        export const SelectContent = pass;
        export const SelectSeparator = () => null;
        export const SelectItem = ({ value, disabled, children }) =>
          createElement("div", { "data-folder": value, "aria-disabled": String(!!disabled) }, children);
      `,
    },
  });
  await settle();

  const options = [];
  findElement(container, (node) => {
    if (node.getAttribute("data-folder")) {
      options.push([node.getAttribute("data-folder"), node.getAttribute("aria-disabled")]);
    }
    return false;
  });
  assert.deepEqual(options, [
    ["1", "false"],
    ["2", "true"],
    ["3", "true"],
    ["4", "false"],
    ["5", "false"],
  ]);
});
