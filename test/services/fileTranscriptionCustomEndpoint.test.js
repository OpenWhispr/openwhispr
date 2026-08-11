const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

function customConfig(baseUrl) {
  return {
    useLocalWhisper: false,
    localTranscriptionProvider: "whisper",
    whisperModel: "base",
    parakeetModel: "parakeet-tdt-0.6b-v3",
    isOpenWhisprCloud: false,
    getApiKey: () => "must-not-leak",
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionBaseUrl: baseUrl,
    cloudTranscriptionModel: "whisper-1",
    language: "en",
    transcriptionMode: "providers",
  };
}

test("file transcription enforces Custom endpoint security before IPC", async (t) => {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-file-custom-endpoint-test-",
    mockModules: {
      "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
    },
  });
  const { transcribeFile } = await vite.ssrLoadModule("/services/fileTranscription.ts");

  let ipcCalls = 0;
  window.electronAPI.transcribeAudioFileByok = async () => {
    ipcCalls += 1;
    return { success: true, text: "must not run" };
  };

  for (const baseUrl of ["", "http://public.example.com/v1", "ftp://192.168.1.20/v1"]) {
    const result = await transcribeFile("/tmp/audio.webm", customConfig(baseUrl), false);
    assert.equal(result.success, false);
    assert.equal(result.code, "CUSTOM_ENDPOINT_INVALID");
  }
  assert.equal(ipcCalls, 0);

  let receivedOptions = null;
  window.electronAPI.transcribeAudioFileByok = async (options) => {
    receivedOptions = options;
    return { success: true, text: "local gateway" };
  };

  const result = await transcribeFile(
    "/tmp/audio.webm",
    customConfig("http://192.168.1.20:5001/v1"),
    false
  );

  assert.equal(result.success, true);
  assert.equal(receivedOptions.baseUrl, "http://192.168.1.20:5001/v1");
});

test("self-hosted file transcription bypasses stale Custom endpoint validation", async (t) => {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-file-self-hosted-endpoint-test-",
    mockModules: {
      "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
    },
  });
  const { transcribeFile } = await vite.ssrLoadModule("/services/fileTranscription.ts");

  let receivedOptions = null;
  window.electronAPI.transcribeAudioFileByok = async (options) => {
    receivedOptions = options;
    return { success: true, text: "self-hosted" };
  };

  const result = await transcribeFile(
    "/tmp/audio.webm",
    {
      ...customConfig(""),
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "http://192.168.1.20:9000/v1",
      remoteTranscriptionModel: "whisper-large-v3",
    },
    false
  );

  assert.equal(result.success, true);
  assert.equal(receivedOptions.transcriptionMode, "self-hosted");
  assert.equal(receivedOptions.remoteTranscriptionUrl, "http://192.168.1.20:9000/v1");
  assert.equal(receivedOptions.remoteTranscriptionModel, "whisper-large-v3");
});
