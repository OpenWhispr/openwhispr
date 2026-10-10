const test = require("node:test");
const assert = require("node:assert/strict");
const { createSettingsNavigationStore } = require("../../src/stores/settingsNavigationStore.ts");
const { installBrowserGlobals } = require("../lib/rendererTestHarness");

const aliases = {
  transcription: ["speechToText", "dictation"],
  uploadTranscription: ["speechToText", "upload"],
  meetings: ["llms", "noteFormatting"],
  intelligence: ["llms", "dictationCleanup"],
  aiModels: ["llms", "dictationCleanup"],
  prompts: ["llms", "dictationCleanup"],
  dictationAgent: ["llms", "dictationAgent"],
  agentMode: ["llms", "chatIntelligence"],
  agentConfig: ["llms", "chatIntelligence"],
  softwareUpdates: ["system", null],
  developer: ["system", null],
  privacy: ["privacyData", null],
  permissions: ["privacyData", null],
};

test("aliases, repeated requests, plain opens and close reset have one navigation owner", (t) => {
  installBrowserGlobals(t);
  for (const [request, [section, tab]] of Object.entries(aliases)) {
    const navigation = createSettingsNavigationStore();
    const actions = navigation.getState();
    actions.openSettings(request);
    assert.equal(navigation.getState().section, section);
    if (tab) assert.equal(navigation.getState()[section === "llms" ? "llmTab" : "speechTab"], tab);
    actions.openSettings("general");
    actions.openSettings();
    assert.equal(navigation.getState().section, "general");
    actions.openSettings(request);
    assert.equal(navigation.getState().section, section);
    actions.setSettingsOpen(false);
    assert.deepEqual(
      [
        navigation.getState().section,
        navigation.getState().speechTab,
        navigation.getState().llmTab,
      ],
      [null, null, null]
    );
    actions.openSettings();
    assert.equal(navigation.getState().section, "account");
  }
  for (const request of ["unrecognized"]) {
    assert.equal(createSettingsNavigationStore(request).getState().section, "account");
  }
});

test("construction is write-free, preferences hydrate on first visit and clicks reject failed writes", (t) => {
  const { storage } = installBrowserGlobals(t, {
    initialStorage: { "settings.llmsTab": JSON.stringify("dictationAgent") },
  });
  const originalWrite = storage.setItem;
  let writes = 0;
  storage.setItem = (...args) => {
    writes++;
    originalWrite(...args);
  };
  const initial = createSettingsNavigationStore("intelligence");
  assert.equal(writes, 0, "lazy construction can be retried by StrictMode without writing storage");
  assert.equal(initial.getState().llmTab, "dictationCleanup");
  initial.getState().persistCurrentTab();
  assert.equal(writes, 1);
  const navigation = createSettingsNavigationStore("general");
  storage.setItem("settings.speechToTextTab", JSON.stringify("upload"));
  navigation.getState().openSettings("speechToText");
  assert.equal(
    navigation.getState().speechTab,
    "upload",
    "first visit reads the current preference"
  );
  navigation.getState().selectSpeechTab("dictation");
  navigation.getState().openSettings("llms");
  navigation.getState().selectLlmTab("noteFormatting");
  storage.setItem = () => {
    throw new Error("storage unavailable");
  };
  navigation.getState().selectLlmTab("dictationAgent");
  assert.equal(navigation.getState().llmTab, "noteFormatting");
  navigation.getState().selectSpeechTab("upload");
  assert.equal(
    navigation.getState().speechTab,
    "dictation",
    "failed click cannot change selection"
  );
  navigation.getState().openSettings("uploadTranscription");
  assert.equal(navigation.getState().speechTab, "upload", "explicit route still applies in memory");
  storage.setItem = originalWrite;
  navigation.getState().setSettingsOpen(false);
  navigation.getState().selectSpeechTab("dictation");
  assert.equal(
    navigation.getState().speechTab,
    null,
    "closed-owner tab action cannot restore live state"
  );
});

test("hidden agent policy fallback is sticky, including when persistence fails", (t) => {
  const { storage } = installBrowserGlobals(t);
  let allowed = true;
  const navigation = createSettingsNavigationStore("dictationAgent", () => allowed);
  navigation.getState().openSettings("general");
  storage.setItem = () => {
    throw new Error("storage unavailable");
  };
  allowed = false;
  navigation.getState().reconcilePolicy();
  assert.equal(navigation.getState().section, "general", "policy cannot steal the visible page");
  assert.equal(navigation.getState().llmTab, "dictationCleanup");
  allowed = true;
  navigation.getState().reconcilePolicy();
  navigation.getState().openSettings("llms");
  assert.equal(navigation.getState().llmTab, "dictationCleanup");
  allowed = false;
  navigation.getState().openSettings("agentMode");
  assert.equal(navigation.getState().llmTab, "dictationCleanup");
});

test("scoped hosts cannot leak selected tabs, close state or actions into another host", (t) => {
  installBrowserGlobals(t);
  const first = createSettingsNavigationStore("meetings");
  const second = createSettingsNavigationStore();
  first.getState().selectLlmTab("dictationTranslation");
  assert.equal(second.getState().section, null);
  second.getState().openSettings("transcription");
  first.getState().setSettingsOpen(false);
  assert.equal(second.getState().section, "speechToText");
  assert.equal(second.getState().speechTab, "dictation");
  const remounted = createSettingsNavigationStore();
  assert.equal(
    remounted.getState().section,
    null,
    "fresh host does not inherit another host's open modal"
  );
});

test("ordinary page navigation does not clobber inactive preferences; banner dismissal survives close", (t) => {
  const { storage } = installBrowserGlobals(t);
  const navigation = createSettingsNavigationStore("meetings");
  navigation.getState().persistCurrentTab();
  storage.setItem("settings.llmsTab", JSON.stringify("dictationTranslation"));
  navigation.getState().openSettings("general");
  assert.equal(storage.getItem("settings.llmsTab"), JSON.stringify("dictationTranslation"));
  navigation.getState().dismissGpuBanner();
  navigation.getState().setSettingsOpen(false);
  navigation.getState().openSettings();
  assert.equal(navigation.getState().gpuBannerDismissed, true);
  assert.equal(createSettingsNavigationStore().getState().gpuBannerDismissed, true);
});
