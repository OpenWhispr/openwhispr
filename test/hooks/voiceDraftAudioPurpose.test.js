const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { deferred } = require("../helpers/harness/deferred");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

test("chat mic takes carry dictation purpose through local, cloud and BYOK file dispatch", async (t) => {
  let root;
  const originalRecorder = globalThis.MediaRecorder;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    if (originalRecorder === undefined) delete globalThis.MediaRecorder;
    else globalThis.MediaRecorder = originalRecorder;
    delete globalThis.__voiceDraftPurposeSettings;
  });
  const calls = [];
  const result = (lane, options) => {
    calls.push({ lane, options });
    return Promise.resolve({ success: true, text: "Dictated text" });
  };
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        saveTempAudio: async () => ({ path: "/tmp/voice.webm" }),
        deleteTempAudio: async () => {},
        transcribeAudioFile: (_path, options) => result("local", options),
        transcribeAudioFileCloud: (_path, options) => result("cloud", options),
        transcribeAudioFileByok: (options) => result("byok", options),
      },
    },
  });
  const container = installHookDom(t);
  installMicCaptureGlobals(t);
  globalThis.MediaRecorder = class {
    start() {}
    stop() {
      this.ondataavailable({ data: new Blob(["voice"], { type: "audio/webm" }) });
      this.onstop();
    }
  };
  const settings = {
    useLocalWhisper: true,
    whisperModel: "base",
    localTranscriptionProvider: "whisper",
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "openai",
    cloudTranscriptionBaseUrl: "",
    cloudTranscriptionModel: "whisper-1",
    preferredLanguage: "en",
    transcriptionMode: "providers",
    openaiApiKey: "sk-test",
  };
  globalThis.__voiceDraftPurposeSettings = settings;
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-voice-draft-purpose-",
    mockModules: {
      "/hooks/useAuth": "export const useAuth = () => ({ isSignedIn: true });",
      "/hooks/useSettings":
        "export const useSettings = () => globalThis.__voiceDraftPurposeSettings;",
      "/stores/settingsStore":
        "export const useSettingsStore = (selector) => selector(globalThis.__voiceDraftPurposeSettings);",
      "./managedTranscription":
        "export const getManagedTranscriptionResolution = () => null; export const isManagedTranscriptionActive = () => false;",
      "/models/ModelRegistry":
        'export const getTranscriptionProviders = () => [{ id: "openai", baseUrl: "https://api.openai.com/v1" }];',
      "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
    },
  });
  const { useVoiceDraft } = await vite.ssrLoadModule("/components/chat/useVoiceDraft.ts");
  const { transcribeFile } = await vite.ssrLoadModule("/services/fileTranscription.ts");
  let voice;
  let finished;
  const errors = [];
  function Harness() {
    voice = useVoiceDraft({
      onTranscript: (text) => finished.resolve(text),
      onError: (message) => {
        errors.push(message);
        finished.resolve();
      },
    });
    return null;
  }
  root = createRoot(container);
  for (const lane of ["local", "cloud", "byok"]) {
    settings.useLocalWhisper = lane === "local";
    settings.cloudTranscriptionMode = lane === "cloud" ? "openwhispr" : "byok";
    await React.act(async () => root.render(React.createElement(Harness)));
    await React.act(async () => voice.start());
    finished = deferred();
    await React.act(async () => {
      voice.stop();
      assert.equal(await finished.promise, "Dictated text", errors.join("; "));
    });
    assert.equal(calls.at(-1).lane, lane);
    assert.equal(calls.at(-1).options.purpose, "dictation");
    assert.deepEqual(errors, []);

    await transcribeFile(
      "/tmp/upload.webm",
      {
        ...settings,
        isOpenWhisprCloud: lane === "cloud",
        getApiKey: () => "sk-test",
        language: "en",
      },
      false
    );
    assert.equal(calls.at(-1).options.purpose, undefined, "uploads keep the default purpose");
  }
  assert.equal(calls.length, 6);
});
