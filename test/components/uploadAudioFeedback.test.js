const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("the upload model control opens its settings and diarization failures render a warning", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-upload-audio-feedback-test-",
    mockModules: {
      "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
    },
  });
  const { UploadModelSettingsButton, UploadDiarizationWarning } = await vite.ssrLoadModule(
    "/components/notes/UploadAudioFeedback.tsx"
  );

  assert.equal(typeof UploadModelSettingsButton, "function");
  assert.equal(typeof UploadDiarizationWarning, "function");

  const openedSections = [];
  const modelButton = UploadModelSettingsButton({
    label: "Using Parakeet",
    ariaLabel: "Open Transcription Settings",
    onOpenSettings: (section) => openedSections.push(section),
  });
  modelButton.props.onClick();

  assert.deepEqual(openedSections, ["uploadTranscription"]);
  assert.equal(modelButton.props.type, "button");
  assert.equal(modelButton.props["aria-label"], "Open Transcription Settings");

  const warningMarkup = renderToStaticMarkup(
    React.createElement(UploadDiarizationWarning, {
      message: "Speaker identification couldn't be applied. The transcript was saved without speaker labels.",
    })
  );
  assert.match(warningMarkup, /Speaker identification couldn&#x27;t be applied/);
});

test("upload and batch views preserve accurate warning wiring", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-upload-warning-wiring-test-",
  });
  const { BatchWarningIndicator } = await vite.ssrLoadModule(
    "/components/notes/BatchQueueView.tsx"
  );

  assert.equal(typeof BatchWarningIndicator, "function");
  const indicator = BatchWarningIndicator({
    transcriptionWarning: false,
    diarizationWarning: true,
    t: (key) => key,
  });
  assert.equal(indicator.props.title, "notes.upload.diarizationWarning");
  assert.equal(indicator.props["aria-label"], "notes.upload.diarizationWarning");

  const sourceRoot = path.join(__dirname, "../..");
  const uploadViewSource = fs.readFileSync(
    path.join(sourceRoot, "src/components/notes/UploadAudioView.tsx"),
    "utf8"
  );
  const batchStoreSource = fs.readFileSync(
    path.join(sourceRoot, "src/stores/batchQueueStore.ts"),
    "utf8"
  );

  assert.equal((uploadViewSource.match(/<UploadModelSettingsButton/g) || []).length, 2);
  assert.match(uploadViewSource, /setDiarizationWarning\(!!res\.diarizationWarning\)/);
  assert.match(
    uploadViewSource,
    /<UploadDiarizationWarning message=\{t\("notes\.upload\.diarizationWarning"\)\}/
  );
  assert.match(batchStoreSource, /warning: !!transcriptionResult\.warning/);
  assert.match(
    batchStoreSource,
    /diarizationWarning: !!transcriptionResult\.diarizationWarning/
  );
});
