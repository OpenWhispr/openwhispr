const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const {
  SIGNED_OUT_AUTH_MOCK,
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

// The voice draft on the real hook: a take recorded with a fake MediaRecorder
// and transcribed through a stubbed file transcription, so what reaches the
// microphone and the transcription config can be read back.
async function mountVoiceDraft(t, { settings, getUserMedia }) {
  let root = null;
  // After hooks run in registration order: unmount while the globals exist.
  t.after(() => root && React.act(async () => root.unmount()));
  const transcribed = [];
  globalThis.__voiceDraftTranscribed = transcribed;
  t.after(() => delete globalThis.__voiceDraftTranscribed);
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        saveTempAudio: async () => ({ path: "/tmp/take.webm" }),
        deleteTempAudio: async () => undefined,
        getSystemDefaultMicrophone: async () => null,
      },
    },
  });
  const container = installHookDom(t);
  installMicCaptureGlobals(t);
  const opened = [];
  const stream = await navigator.mediaDevices.getUserMedia();
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    opened.push(constraints);
    return getUserMedia(constraints, stream);
  };
  navigator.mediaDevices.enumerateDevices = async () => [
    { kind: "audioinput", deviceId: "default", label: "Default - MacBook Pro Microphone" },
    { kind: "audioinput", deviceId: "usb-mic", label: "USB Mic" },
  ];
  globalThis.MediaRecorder = class FakeMediaRecorder {
    start() {}
    stop() {
      this.ondataavailable({ data: new Blob(["audio"]) });
      this.onstop();
    }
  };
  t.after(() => delete globalThis.MediaRecorder);

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-voice-draft-test-",
    mockModules: {
      ...SIGNED_OUT_AUTH_MOCK,
      "/hooks/useSettings": `import { useSettingsStore } from "/stores/settingsStore.ts";
        export const useSettings = () => useSettingsStore();`,
      "/services/fileTranscription": `
        export const transcribeFile = async (_path, config) => {
          globalThis.__voiceDraftTranscribed.push(config);
          return { success: true, text: "hello there" };
        };
        export const getTranscriptionApiKey = () => "";
        export const resolveFileTranscriptionRoute = () => ({ transport: "http" });`,
    },
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState(settings);
  const { useVoiceDraft } = await vite.ssrLoadModule("/components/chat/useVoiceDraft.ts");

  const transcripts = [];
  let voice = null;
  function Harness() {
    voice = useVoiceDraft({
      onTranscript: (text) => transcripts.push(text),
      onError: (message) => transcripts.push(`error:${message}`),
    });
    return null;
  }
  const { createRoot } = require("react-dom/client");
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  return { voice: () => voice, opened, transcribed, transcripts };
}

const SIGNED_IN_CLOUD = {
  isSignedIn: true,
  useLocalWhisper: false,
  cloudTranscriptionMode: "openwhispr",
  microphoneSelectionMode: "specific",
  selectedMicDeviceId: "usb-mic",
  selectedMicDeviceLabel: "USB Mic",
};

async function recordTake(harness) {
  let started;
  await React.act(async () => {
    started = await harness.voice().start();
  });
  await React.act(async () => {
    harness.voice().stop();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return started;
}

test("a signed-in Cloud user's take goes to OpenWhispr Cloud even where no session resolves", async (t) => {
  const harness = await mountVoiceDraft(t, {
    settings: SIGNED_IN_CLOUD,
    getUserMedia: (_constraints, stream) => stream,
  });

  assert.equal(await recordTake(harness), true);
  assert.equal(harness.transcribed.length, 1);
  assert.equal(harness.transcribed[0].isOpenWhisprCloud, true);
  assert.deepEqual(harness.transcripts, ["hello there"]);
});

test("the take records from the chosen microphone with dictation's constraints", async (t) => {
  const harness = await mountVoiceDraft(t, {
    settings: SIGNED_IN_CLOUD,
    getUserMedia: (_constraints, stream) => stream,
  });

  await recordTake(harness);
  assert.deepEqual(harness.opened, [
    {
      audio: {
        deviceId: { exact: "usb-mic" },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
      },
    },
  ]);
});

test("a chosen microphone that won't open falls back to the default one", async (t) => {
  const harness = await mountVoiceDraft(t, {
    settings: SIGNED_IN_CLOUD,
    getUserMedia: (constraints, stream) => {
      if (constraints.audio.deviceId) throw new Error("OverconstrainedError");
      return stream;
    },
  });

  assert.equal(await recordTake(harness), true);
  assert.equal(harness.opened.length, 2);
  assert.equal(harness.opened[1].audio.deviceId, undefined);
  assert.deepEqual(harness.transcripts, ["hello there"]);
});
