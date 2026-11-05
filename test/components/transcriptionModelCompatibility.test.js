const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { mountSettingsPanel } = require("../lib/settingsPanelHarness");

const ENGLISH_MODEL = "parakeet-unified-en-0.6b";
const COHERE_MODEL = "cohere-transcribe-03-2026";
const card = (panel, modelId) => panel.find((node) => node.props?.modelId === modelId)[0];

async function mount(
  t,
  { language = "en-US", organization = "nvidia", downloaded = true, download } = {}
) {
  const selected = [];
  const panel = await mountSettingsPanel(t, {
    module: "/components/TranscriptionModelPicker.tsx",
    props: {
      selectedCloudProvider: "openai",
      selectedCloudModel: "whisper-1",
      onCloudProviderSelect() {},
      onCloudModelSelect() {},
      selectedLocalProvider: organization === "cohere" ? "cohere" : "nvidia",
      selectedLocalModel: organization === "cohere" ? COHERE_MODEL : "parakeet-tdt-0.6b-v3",
      onLocalModelSelect: (...args) => selected.push(args),
      useLocalWhisper: true,
      mode: "local",
      onModeChange() {},
    },
    settings: { preferredLanguage: language },
    electronAPI: {
      onWhisperDownloadProgress: () => () => {},
      onParakeetDownloadProgress: () => () => {},
      checkParakeetAvailable: async () => ({ supported: true }),
      listParakeetModels: async () => ({
        success: true,
        models: [ENGLISH_MODEL, COHERE_MODEL, "parakeet-tdt-0.6b-v3", "orukeet-v0.1.0"].map(
          (model) => ({ model, downloaded })
        ),
      }),
      downloadParakeetModel: download,
    },
  });
  return { panel, selected };
}

test("unsupported models stay visible with downloads and model-card links, but cannot be selected", async (t) => {
  const { panel, selected } = await mount(t, { language: "ar", downloaded: false });
  const english = card(panel, ENGLISH_MODEL);
  assert.ok(english);
  assert.equal(english.props.isLanguageUnsupported, true);
  assert.equal(english.props.languageLabel, "transcription.modelCompatibility.unsupported");
  assert.equal(typeof english.props.onDownload, "function");
  await React.act(async () => english.props.onSelect());
  assert.deepEqual(selected, []);
  await panel.selectTab("oruk");
  assert.ok(
    card(panel, "orukeet-v0.1.0").props.modelCardUrl,
    "main's organization tab and link survive"
  );
});

test("Cohere auto explains the backend's English fallback without blocking selection", async (t) => {
  const { panel, selected } = await mount(t, { language: "auto", organization: "cohere" });
  const cohere = card(panel, COHERE_MODEL);
  assert.equal(cohere.props.isLanguageUnsupported, false);
  assert.equal(cohere.props.languageLabel, "transcription.modelCompatibility.englishFallback");
  await React.act(async () => cohere.props.onSelect());
  assert.deepEqual(selected, [[COHERE_MODEL, "cohere"]]);
});

for (const [before, after, shouldSelect] of [
  ["en-US", "ar", false],
  ["ar", "en-US", true],
]) {
  test(`a download started with ${before} uses ${after} at completion`, async (t) => {
    let finish;
    const { panel, selected } = await mount(t, {
      language: before,
      downloaded: false,
      download: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    await React.act(async () => {
      card(panel, ENGLISH_MODEL).props.onDownload();
    });
    assert.equal(typeof finish, "function", "incompatible models are still downloadable");
    await panel.setStore({ preferredLanguage: after });
    await React.act(async () => finish({ success: true }));
    assert.deepEqual(selected, shouldSelect ? [[ENGLISH_MODEL, "nvidia"]] : []);
  });
}
