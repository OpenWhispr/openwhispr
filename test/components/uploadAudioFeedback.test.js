const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function loadFeedback(t) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-upload-audio-feedback-test-",
  });
  return vite.ssrLoadModule("/components/notes/UploadAudioFeedback.tsx");
}

async function loadBatchQueueView(t) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-batch-warning-indicator-test-",
  });
  return vite.ssrLoadModule("/components/notes/BatchQueueView.tsx");
}

test("the model button announces the model it names, not just the action", async (t) => {
  const { UploadModelSettingsButton } = await loadFeedback(t);

  const markup = renderToStaticMarkup(
    createElement(UploadModelSettingsButton, {
      label: "Using Whisper · base",
      actionLabel: "Open Transcription Settings",
      onOpenSettings: () => {},
    })
  );

  // WCAG 2.5.3: the accessible name must contain the visible label, or voice
  // control cannot target the button and screen readers never hear the model.
  const ariaLabel = markup.match(/aria-label="([^"]*)"/)?.[1];
  assert.ok(ariaLabel, "expected an aria-label");
  assert.ok(
    ariaLabel.includes("Using Whisper · base"),
    `accessible name "${ariaLabel}" must contain the visible label`
  );
  assert.ok(ariaLabel.includes("Open Transcription Settings"));
});

test("the model button opens the upload-scoped transcription settings", async (t) => {
  const { UploadModelSettingsButton } = await loadFeedback(t);

  const openedSections = [];
  const element = UploadModelSettingsButton({
    label: "Using Whisper · base",
    actionLabel: "Open Transcription Settings",
    onOpenSettings: (section) => openedSections.push(section),
  });
  element.props.onClick();

  assert.deepEqual(openedSections, ["uploadTranscription"]);
  assert.equal(element.props.type, "button");
});

test("the batch warning indicator renders nothing when neither warning is set", async (t) => {
  const { BatchWarningIndicator } = await loadBatchQueueView(t);

  const markup = renderToStaticMarkup(
    createElement(BatchWarningIndicator, {
      transcriptionWarning: false,
      diarizationWarning: false,
      t: (key) => key,
    })
  );

  assert.equal(markup, "");
});

test("the batch warning indicator combines both warnings into one label", async (t) => {
  const { BatchWarningIndicator } = await loadBatchQueueView(t);

  const markup = renderToStaticMarkup(
    createElement(BatchWarningIndicator, {
      transcriptionWarning: true,
      diarizationWarning: true,
      t: (key) => key,
    })
  );

  const ariaLabel = markup.match(/aria-label="([^"]*)"/)?.[1];
  assert.equal(ariaLabel, "notes.upload.partialWarning notes.upload.diarizationWarning");
  assert.match(markup, /text-warning/);
  // A non-widget span in the tab order is a dead stop: `title` tooltips do not
  // open on keyboard focus, so there is nothing to read once you land there.
  assert.doesNotMatch(markup, /tabindex/i);
});

test("the batch warning indicator reports a transcription-only warning", async (t) => {
  const { BatchWarningIndicator } = await loadBatchQueueView(t);

  const markup = renderToStaticMarkup(
    createElement(BatchWarningIndicator, {
      transcriptionWarning: true,
      diarizationWarning: false,
      t: (key) => key,
    })
  );

  assert.match(markup, /aria-label="notes\.upload\.partialWarning"/);
});

test("the completed upload stays quiet when nothing went wrong", async (t) => {
  const { UploadCompleteWarnings } = await loadFeedback(t);

  const markup = renderToStaticMarkup(
    createElement(UploadCompleteWarnings, {
      partialWarning: null,
      diarizationWarning: false,
      t: (key) => key,
    })
  );

  assert.equal(markup, "");
});

test("the completed upload shows the diarization warning only when it is flagged", async (t) => {
  const { UploadCompleteWarnings } = await loadFeedback(t);

  const warned = renderToStaticMarkup(
    createElement(UploadCompleteWarnings, {
      partialWarning: null,
      diarizationWarning: true,
      t: (key) => key,
    })
  );
  assert.match(warned, /notes\.upload\.diarizationWarning/);
  assert.match(warned, /text-warning/);
  assert.doesNotMatch(warned, /amber/, "use the --color-warning token, not a hand-rolled amber");

  const quiet = renderToStaticMarkup(
    createElement(UploadCompleteWarnings, {
      partialWarning: null,
      diarizationWarning: false,
      t: (key) => key,
    })
  );
  assert.doesNotMatch(quiet, /notes\.upload\.diarizationWarning/);
});

test("a chunk loss and a diarization failure are reported together", async (t) => {
  const { UploadCompleteWarnings } = await loadFeedback(t);

  const markup = renderToStaticMarkup(
    createElement(UploadCompleteWarnings, {
      partialWarning: { failed: 2, total: 9 },
      diarizationWarning: true,
      t: (key) => key,
    })
  );

  assert.match(markup, /notes\.upload\.partialWarningCount/);
  assert.match(markup, /notes\.upload\.diarizationWarning/);
});
