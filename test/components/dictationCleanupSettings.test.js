const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { mountSettingsPanel } = require("../lib/settingsPanelHarness");
const { managedPolicy } = require("../helpers/harness/policyFixtures");

const copy = "settingsPage.aiModels.assemblyAiCleanup";
const settings = {
  transcriptionMode: "providers",
  useLocalWhisper: false,
  cloudTranscriptionMode: "byok",
  cloudTranscriptionProvider: "assemblyai",
  cloudTranscriptionModel: "dictation",
  cleanupMode: "openwhispr",
  isSignedIn: true,
};
const props = { enabled: true, onEnabledChange() {}, onModeChange() {} };
const mount = (t, options) =>
  mountSettingsPanel(t, {
    module: "/components/settings/DictationCleanupSettings.tsx",
    props,
    secrets: settings,
    policy: { status: "unmanaged", policy: null },
    ...options,
  });
const advanced = (panel) => panel.find((node) => node.props?.["aria-expanded"] !== undefined)[0];
const editor = (panel) => panel.find((node) => node.props?.scope === "dictationCleanup")[0];
const ordinaryCopy = "settingsPage.aiModels.enableTextCleanupDescription";
const cleanupRow = (panel) =>
  panel.find((node) => node.props?.label === "settingsPage.aiModels.enableTextCleanup")[0];
const missingNotice = (panel) =>
  panel.find((node) => node.props?.children === copy + ".modelNeeded")[0];

test("batch dictation keeps the user's cleanup toggle and saved advanced provider", async (t) => {
  const changes = [];
  const panel = await mount(t, {
    props: { ...props, onEnabledChange: (value) => changes.push(value) },
  });
  assert.equal(cleanupRow(panel).props.description, copy + ".description");
  assert.equal(advanced(panel).props["aria-expanded"], false);
  assert.equal(editor(panel), undefined);
  await React.act(() => advanced(panel).props.onClick());
  assert.equal(editor(panel).props.selectedLabel, copy + ".saved");
  assert.equal(panel.state().cleanupMode, "openwhispr");
  await React.act(() =>
    panel
      .find((node) => node.props?.ariaLabel === "settingsPage.aiModels.enableTextCleanup")[0]
      .props.onChange(false)
  );
  assert.deepEqual(changes, [false]);
  await panel.setProps({ enabled: false });
  assert.equal(editor(panel), undefined);
  assert.equal(advanced(panel), undefined);
  assert.equal(cleanupRow(panel).props.description, copy + ".description");
  await panel.setProps({ enabled: true });
  await panel.setStore({ cleanupMode: "providers" });
  assert.equal(panel.state().cloudTranscriptionModel, "dictation");
  assert.ok(
    panel.find((node) => node.props?.children === "settingsPage.aiModels.modes.providers").length
  );
});

test("a saved AssemblyAI preference under local, cloud, realtime or managed policy uses the ordinary editor", async (t) => {
  const panel = await mount(t);
  for (const change of [
    { transcriptionMode: "local", useLocalWhisper: true },
    { transcriptionMode: "openwhispr", cloudTranscriptionMode: "openwhispr" },
    { cloudTranscriptionModel: "universal-3-6-pro" },
    { cloudTranscriptionProvider: "openai", cloudTranscriptionModel: "whisper-1" },
  ]) {
    await panel.setStore({ ...settings, ...change });
    assert.equal(advanced(panel), undefined);
    assert.equal(cleanupRow(panel).props.description, ordinaryCopy);
    assert.equal(editor(panel).props.selectedLabel, undefined);
  }
  await panel.setStore(settings);
  await panel.setPolicy({
    status: "managed",
    policy: managedPolicy({ llm: { allowedModes: ["local"] } }),
  });
  assert.equal(advanced(panel), undefined);
  assert.equal(cleanupRow(panel).props.description, ordinaryCopy);
});

test("missing local cleanup models reveal the picker for styling without changing preferences", async (t) => {
  const panel = await mount(t, {
    secrets: { ...settings, cleanupMode: "local", cleanupModel: "", toneStyleEnabled: true },
  });
  assert.equal(advanced(panel).props["aria-expanded"], true);
  assert.ok(missingNotice(panel));
  let focused = false;
  editor(panel).props.localPickerRef.current = {
    focus() {
      focused = true;
    },
  };
  await panel.click("models.policy.chooseModel");
  assert.equal(focused, true);
  assert.equal(panel.state().cleanupMode, "local");
  assert.equal(panel.state().toneStyleEnabled, true);
  await panel.setStore({
    toneStyleEnabled: false,
    customPrompts: { cleanup: "Use bullet points" },
  });
  assert.ok(missingNotice(panel));
  await panel.setStore({ customPrompts: { cleanup: "" } });
  assert.equal(missingNotice(panel), undefined);
});

test("a stale or failed disk lookup cannot mark the current local cleanup model missing", async (t) => {
  let models = [{ id: "model", isDownloaded: false }];
  let resolveOld;
  let inventory = () => Promise.resolve(models);
  const panel = await mount(t, {
    secrets: { ...settings, cleanupMode: "local", cleanupModel: "model", toneStyleEnabled: true },
    electronAPI: { modelGetAll: () => inventory() },
  });
  assert.ok(missingNotice(panel));
  inventory = () =>
    new Promise((resolve) => {
      resolveOld = resolve;
    });
  await panel.setStore({ cleanupModel: "old" });
  inventory = () => Promise.resolve([{ id: "downloaded", isDownloaded: true }]);
  await panel.setStore({ cleanupModel: "downloaded" });
  await React.act(() => resolveOld([]));
  assert.equal(missingNotice(panel), undefined);
  inventory = () => Promise.reject(new Error("offline"));
  await panel.setStore({ cleanupModel: "unknown" });
  assert.equal(missingNotice(panel), undefined);
});

test("managed cleanup keeps the enterprise editor visible even with personal AssemblyAI dictation selected", async (t) => {
  const {
    assemblyAiPolicy,
    setManagedBedrockCleanup,
  } = require("../helpers/harness/policyFixtures");
  const panel = await mount(t, { policy: assemblyAiPolicy(true, true) });
  await React.act(() => setManagedBedrockCleanup(panel.vite));
  assert.equal(advanced(panel), undefined);
  assert.equal(cleanupRow(panel).props.description, ordinaryCopy);
  assert.equal(editor(panel).props.selectedLabel, undefined);
});

test("a completed download or deletion updates the notice for the same selected model", async (t) => {
  let downloaded = false;
  const panel = await mount(t, {
    electronAPI: { modelGetAll: async () => [{ id: "model", isDownloaded: downloaded }] },
  });
  const events = new EventTarget();
  t.mock.method(globalThis.window, "addEventListener", events.addEventListener.bind(events));
  t.mock.method(globalThis.window, "removeEventListener", events.removeEventListener.bind(events));
  await panel.setStore({ cleanupMode: "local", cleanupModel: "model", toneStyleEnabled: true });
  assert.ok(missingNotice(panel));
  downloaded = true;
  await React.act(() => {
    events.dispatchEvent(new Event("openwhispr-local-models-changed"));
  });
  assert.equal(missingNotice(panel), undefined);
  downloaded = false;
  await React.act(() => {
    events.dispatchEvent(new Event("openwhispr-models-cleared"));
  });
  assert.ok(missingNotice(panel));
  assert.equal(panel.state().cleanupModel, "model");
});
