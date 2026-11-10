const assert = require("node:assert/strict");
const test = require("node:test");
const { mountSettingsPanel } = require("../lib/settingsPanelHarness");

// The Note Recording picker, as MeetingSettings renders it.
const mount = (t, overrides = {}) =>
  mountSettingsPanel(t, {
    module: "/components/TranscriptionModelPicker.tsx",
    props: {
      transcriptionContext: "meeting",
      streamingOnly: true,
      selectedCloudProvider: "openai",
      onCloudProviderSelect() {},
      selectedCloudModel: "gpt-4o-mini-transcribe",
      onCloudModelSelect() {},
      selectedLocalModel: "",
      onLocalModelSelect() {},
      useLocalWhisper: false,
      onModeChange() {},
      mode: "cloud",
      ...overrides,
    },
    electronAPI: {
      onWhisperDownloadProgress: () => () => {},
      onParakeetDownloadProgress: () => () => {},
    },
  });

// The harness's `t` returns the key followed by its interpolation values.
const hint = (panel) =>
  panel.find(
    (node) =>
      typeof node.props?.children === "string" &&
      node.props.children.startsWith("transcription.browsedProviderHint")
  )[0]?.props.children;

test("a browsed tab says the saved provider stays in use until a model is picked", async (t) => {
  const panel = await mount(t);
  assert.equal(hint(panel), undefined, "the saved provider's own tab needs no hint");

  await panel.selectTab("deepgram");
  assert.equal(
    hint(panel),
    'transcription.browsedProviderHint {"current":"OpenAI","provider":"Deepgram"}'
  );
  assert.equal(panel.state().meetingCloudTranscriptionProvider, "", "browsing saves nothing");

  await panel.selectTab("openai");
  assert.equal(hint(panel), undefined, "browsing back to the saved tab clears it");

  await panel.selectTab("deepgram");
  await panel.selectModel("nova-3");
  assert.equal(panel.state().meetingCloudTranscriptionProvider, "deepgram");
  assert.equal(hint(panel), undefined, "a picked model saves the tab");
});

test("a saved provider this picker doesn't offer is not named", async (t) => {
  // Dictation's batch provider, which Note Recording falls back to but can't stream.
  const panel = await mount(t, {
    selectedCloudProvider: "groq",
    selectedCloudModel: "whisper-large-v3-turbo",
  });
  await panel.selectTab("deepgram");
  assert.equal(hint(panel), 'transcription.browsedProviderHintNoCurrent {"provider":"Deepgram"}');
});

test("a browsed Custom tab says the saved provider stays in use", async (t) => {
  const panel = await mount(t, { transcriptionContext: "dictation", streamingOnly: false });
  await panel.selectTab("custom");
  assert.equal(
    hint(panel),
    'transcription.browsedProviderHint {"current":"OpenAI","provider":"transcription.customProvider"}'
  );
});
