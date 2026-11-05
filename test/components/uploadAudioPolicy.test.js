const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { deferred } = require("../helpers/harness/deferred");
const { audioFeatureFailure } = require("../../src/helpers/audioFeaturePolicy");
const { i18nMain, changeLanguage } = require("../../src/helpers/i18nMain");
const esTranslation = require("../../src/locales/es/translation.json");
const { uploadRestrictionKey } = require("../../src/components/notes/shared.ts");

const source = ts.createSourceFile(
  "UploadAudioView.tsx",
  fs.readFileSync(path.join(__dirname, "../../src/components/notes/UploadAudioView.tsx"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);
let transcribe;
let policyChanged;
let activeModelLabel;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "getActiveModelLabel") {
    activeModelLabel = ts.transpileModule(`(${node.initializer.getText(source)})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "handleTranscribe") {
    transcribe = node.initializer.getText(source);
  }
  if (ts.isCallExpression(node) && node.expression.getText(source) === "usePolicyStore.subscribe") {
    policyChanged = node.arguments[0].getText(source);
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(transcribe);
assert.ok(policyChanged);
const callbacks = ts.transpileModule(
  `({ transcribe: ${transcribe}, policyChanged: ${policyChanged} })`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
).outputText;

for (const phase of ["title", "save"]) {
  test(`upload revocation during ${phase} processing exits progress and suppresses late completion`, async () => {
    const entered = deferred();
    const finish = deferred();
    const cancelled = [];
    const saved = [];
    const states = [];
    const errors = [];
    const activeRequestIdRef = { current: null };
    const noop = () => {};
    const context = {
      file: { path: "/tmp/audio.wav", name: "audio.wav", fromUrl: false },
      batch: { isProcessing: false },
      usePolicyStore: { getState: () => ({ allowed: true }) },
      isAudioFeatureAllowed: (policy) => policy.allowed,
      isAudioFeatureDenied: (policy) => !policy.allowed,
      uploadRestrictionKey,
      isManagedTranscriptionActive: () => false,
      isTranscriptionContextAllowed: () => true,
      getSettings: () => ({}),
      downloadedTempPath: null,
      runIdRef: { current: 0 },
      activeRequestIdRef,
      singleDownloadIdRef: { current: null },
      crypto: { randomUUID: () => "upload-request" },
      setState: (state) => states.push(state),
      setError: (error) => errors.push(error),
      setProgress: noop,
      setChunkProgress: noop,
      setDiarizationWarning: noop,
      setResult: noop,
      setPartialWarning: noop,
      setNoteId: noop,
      setDownloadedTempPath: noop,
      selectedFolderId: "",
      isOpenWhisprCloud: false,
      managedActive: false,
      isLargeFile: false,
      progressRef: { current: null },
      progressCleanupRef: { current: null },
      setInterval: () => 1,
      clearInterval: noop,
      buildDiarizationSettings: async () => ({ enabled: false }),
      buildTranscriptionConfig: () => ({}),
      transcribeFileWithSpeakers: async () => ({ success: true, text: "Transcript" }),
      generateTitle: async () => {
        if (phase === "title") {
          entered.resolve();
          await finish.promise;
        }
        return "Title";
      },
      uploadTitleFallback: () => "Title",
      saveUploadNote: async (note) => {
        saved.push(note);
        if (phase === "save") {
          entered.resolve();
          await finish.promise;
        }
        return { success: true, note: { id: 1 } };
      },
      window: { electronAPI: { cancelUploadTranscription: (id) => cancelled.push(id) } },
      t: (key) => key,
    };
    const handlers = vm.runInNewContext(callbacks, context);
    const pending = handlers.transcribe();
    await entered.promise;
    handlers.policyChanged({
      allowed: false,
      status: "managed",
      policy: { features: { audioUploadEnabled: false } },
    });
    assert.equal(states.at(-1), "error");
    assert.equal(errors.at(-1), "notes.upload.disabledByOrg");
    assert.deepEqual(cancelled, ["upload-request"]);
    finish.resolve();
    await pending;
    assert.equal(states.at(-1), "error");
    assert.equal(activeRequestIdRef.current, null);
    assert.equal(saved.length, phase === "save" ? 1 : 0);
  });
}

test("main policy refusals appear in Spanish upload errors", async (t) => {
  const previousLanguage = i18nMain.language;
  changeLanguage("es");
  t.after(() => changeLanguage(previousLanguage));

  for (const [snapshot, expected] of [
    [
      { success: true, managed: true, policy: { features: { audioUploadEnabled: false } } },
      esTranslation.notes.upload.disabledByOrg,
    ],
    [null, esTranslation.common.policyUnresolved],
  ]) {
    const errors = [];
    const states = [];
    const noop = () => {};
    const context = {
      file: { path: "/tmp/audio.wav" },
      batch: { isProcessing: false },
      usePolicyStore: { getState: () => ({}) },
      isAudioFeatureAllowed: () => true,
      isManagedTranscriptionActive: () => false,
      isTranscriptionContextAllowed: () => true,
      getSettings: () => ({}),
      downloadedTempPath: null,
      runIdRef: { current: 0 },
      activeRequestIdRef: { current: null },
      crypto: { randomUUID: () => "upload-request" },
      setState: (state) => states.push(state),
      setError: (error) => errors.push(error),
      setProgress: noop,
      setChunkProgress: noop,
      setDiarizationWarning: noop,
      isOpenWhisprCloud: false,
      managedActive: false,
      progressRef: { current: null },
      progressCleanupRef: { current: null },
      setInterval: () => 1,
      clearInterval: noop,
      buildDiarizationSettings: async () => ({ enabled: false }),
      buildTranscriptionConfig: () => ({}),
      transcribeFileWithSpeakers: async () => audioFeatureFailure(snapshot, "upload"),
      transcriptionErrorKey: () => undefined,
      t: (key) => key,
    };

    await vm.runInNewContext(callbacks, context).transcribe();

    assert.equal(states.at(-1), "error");
    assert.equal(errors.at(-1), expected);
    assert.equal(context.activeRequestIdRef.current, null);
  }
});

test("an upload refused before it starts names the reason the policy gives", async () => {
  for (const [policy, expected] of [
    [
      { status: "managed", policy: { features: { audioUploadEnabled: false } } },
      "notes.upload.disabledByOrg",
    ],
    [{ status: "loading", policy: null }, "common.policyUnresolved"],
  ]) {
    const errors = [];
    const context = {
      file: { path: "/tmp/audio.wav" },
      batch: { isProcessing: false },
      usePolicyStore: { getState: () => policy },
      isAudioFeatureAllowed: () => false,
      uploadRestrictionKey,
      setError: (error) => errors.push(error),
      t: (key) => key,
    };

    await vm.runInNewContext(callbacks, context).transcribe();

    assert.deepEqual(errors, [expected]);
  }
});

test("an upload refused for its local model shows the reason instead of nothing", async () => {
  const { transcriptionChoiceRefusal } = await import("../../src/stores/policyRules.ts");
  const managed = (allowedModes, allowedLocalModels) => ({
    status: "managed",
    appVersion: "1.11.1",
    policy: {
      transcription: { allowedModes, allowedLocalModels, allowedByokProviders: [] },
      features: {},
      minAppVersion: null,
    },
  });
  const settings = {
    uploadTranscriptionMode: "local",
    localTranscriptionProvider: "whisper",
    whisperModel: "small",
    cloudTranscriptionProvider: "",
  };
  for (const [policy, expected] of [
    [managed(["local"], ["base"]), "models.policy.modelBlocked"],
    [managed(["openwhispr"], null), "models.policy.modeBlocked"],
    [{ status: "loading", policy: null }, "common.managedByOrg"],
  ]) {
    const errors = [];
    const states = [];
    const context = {
      file: { path: "/tmp/audio.wav" },
      batch: { isProcessing: false },
      usePolicyStore: { getState: () => policy },
      isAudioFeatureAllowed: () => true,
      isManagedTranscriptionActive: () => false,
      isTranscriptionContextAllowed: () => false,
      transcriptionChoiceRefusal,
      getSettings: () => settings,
      setError: (error) => errors.push(error),
      setState: (state) => states.push(state),
      t: (key) => key,
    };

    await vm.runInNewContext(callbacks, context).transcribe();

    assert.deepEqual(errors, [expected]);
    assert.deepEqual(states, ["error"], "the error view only renders in the error state");
  }
});

test("the upload label never names a model the policy won't run", () => {
  const label = (uploadChoiceRefusal, overrides = {}) =>
    vm.runInNewContext(activeModelLabel, {
      managed: { kind: "none" },
      isOpenWhisprCloud: false,
      useLocalWhisper: true,
      localTranscriptionProvider: "whisper",
      whisperModel: "",
      parakeetModel: "",
      cohereModel: "",
      isSelfHosted: false,
      uploadChoiceRefusal,
      t: (key) => key,
      ...overrides,
    })();

  assert.equal(label({ code: "POLICY_MODEL_BLOCKED" }), "models.policy.chooseModel");
  assert.equal(
    label({ code: "POLICY_MODEL_BLOCKED" }, { localTranscriptionProvider: "nvidia" }),
    "models.policy.chooseModel"
  );
  assert.equal(label(null, { whisperModel: "small" }), "Whisper · small");
  assert.equal(label(null), "Whisper · base", "a guest's blank still means the engine default");
});
