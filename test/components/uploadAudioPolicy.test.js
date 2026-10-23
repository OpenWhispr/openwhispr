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

const source = ts.createSourceFile(
  "UploadAudioView.tsx",
  fs.readFileSync(path.join(__dirname, "../../src/components/notes/UploadAudioView.tsx"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);
let transcribe;
let policyChanged;
function visit(node) {
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
    handlers.policyChanged({ allowed: false });
    assert.equal(states.at(-1), "error");
    assert.equal(errors.at(-1), "common.managedByOrg");
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
      esTranslation.common.policyTranscriptionRestricted,
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
